'use client';

import { useEffect, useRef, useState } from 'react';
import type { World } from '../engine/World';
import { SANS } from '../engine/fonts';

// meters from center to edge. The old 9500m island-wide view is gone.
const ZOOMS = [220, 650, 2600];
// The two closest zooms draw every street from the tile stream. The widest one
// can't — tiles only load within ~1.1km — so it falls back to the baked
// island-wide major-street skeleton (public/geo/streets.json).
const STREET_MAX_ZOOM_IDX = 1;
const MAJORS_ZOOM_IDX = 2;

type Majors = { w: number; p: number[] }[];

/**
 * Corner minimap: island silhouette, streets, one POI layer (subway stations /
 * bike docks / bus stops + live buses), and a heading arrow.
 */
export default function MiniMap({ world, size = 208, layer = 'transit' }: { world: World; size?: number; layer?: 'transit' | 'bikes' | 'bus' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomIdx, setZoomIdx] = useState(1);
  const dataRef = useRef<{
    rings: number[][];
    stations: { x: number; z: number; color: string }[];
    docks: [number, number][];
    busStops: [number, number][];
    majors: Majors;
  } | null>(null);

  const R = size / 2 - 6;
  const compact = size < 160;

  useEffect(() => {
    let alive = true;
    (async () => {
      const grab = async (url: string) => {
        try {
          const res = await fetch(url);
          return res.ok ? await res.json() : null;
        } catch { return null; }
      };
      const [outline, streets] = await Promise.all([grab('/geo/outline.json'), grab('/geo/streets.json')]);
      const { stations, docks, busStops } = world.mapData();
      if (alive) {
        dataRef.current = {
          rings: outline?.rings ?? [],
          majors: streets?.ways ?? [],
          stations,
          docks,
          busStops,
        };
      }
    })();
    return () => { alive = false; };
  }, [world]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = size * dpr;
    cv.height = size * dpr;

    const draw = () => {
      const d = dataRef.current;
      const p = world.getPos();
      const yaw = world.controlsRef.yaw;
      const radius = ZOOMS[zoomIdx];
      const s = R / radius;
      const cx = size / 2, cy = size / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      // frame + clip
      ctx.beginPath();
      ctx.arc(cx, cy, R + 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10,13,17,0.82)';
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      const sx = (wx: number) => cx + (wx - p.x) * s;
      const sy = (wz: number) => cy + (wz - p.z) * s;

      if (d) {
        // island silhouette
        ctx.beginPath();
        for (const ring of d.rings) {
          ctx.moveTo(sx(ring[0]), sy(ring[1]));
          for (let i = 2; i < ring.length; i += 2) ctx.lineTo(sx(ring[i]), sy(ring[i + 1]));
          ctx.closePath();
        }
        ctx.fillStyle = '#232e37';
        ctx.fill();
        ctx.strokeStyle = '#41505c';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // ---- streets ----
      // Bucket by stroke width into one Path2D each, so the whole grid costs a
      // handful of stroke calls. Safe only because the strokes are OPAQUE: roads
      // arrive as many pieces split at tile edges, and translucent strokes double
      // up where their round caps overlap, freckling every junction.
      const strokeBuckets = (
        add: (bucket: (lw: number) => Path2D) => void,
        floor: number,
      ) => {
        const buckets = new Map<number, Path2D>();
        const bucket = (lw: number) => {
          const k = Math.max(floor, Math.round(lw * 4) / 4);
          let path = buckets.get(k);
          if (!path) { path = new Path2D(); buckets.set(k, path); }
          return path;
        };
        add(bucket);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#93a1ae';
        // widest first so avenues sit under the side streets that meet them
        for (const lw of [...buckets.keys()].sort((x, y) => y - x)) {
          ctx.lineWidth = lw;
          ctx.stroke(buckets.get(lw)!);
        }
      };

      if (zoomIdx <= STREET_MAX_ZOOM_IDX) {
        // full detail from the tile stream. Cover the whole visible circle: the
        // player sits anywhere within their own tile, hence radius + one tile.
        const tileR = Math.ceil(radius / 256) + 1;
        strokeBuckets((bucket) => {
          for (const rp of world.roadPathsNear(p.x, p.z, tileR)) {
            const count = rp.start.length - 1;
            for (let i = 0; i < count; i++) {
              const a = rp.start[i], b = rp.start[i + 1];
              const path = bucket(rp.width[i] * s * 0.75);
              path.moveTo(sx(rp.pts[a * 2]), sy(rp.pts[a * 2 + 1]));
              for (let j = a + 1; j < b; j++) path.lineTo(sx(rp.pts[j * 2]), sy(rp.pts[j * 2 + 1]));
            }
          }
        }, 0.7);
      } else if (zoomIdx === MAJORS_ZOOM_IDX && d?.majors.length) {
        // avenues + highways only, island-wide, with a viewport cull
        const lim = radius * 1.05;
        strokeBuckets((bucket) => {
          for (const way of d.majors) {
            const pts = way.p;
            let visible = false;
            for (let i = 0; i < pts.length; i += 2) {
              if (Math.abs(pts[i] - p.x) < lim && Math.abs(pts[i + 1] - p.z) < lim) { visible = true; break; }
            }
            if (!visible) continue;
            const path = bucket(way.w * s * 0.75);
            path.moveTo(sx(pts[0]), sy(pts[1]));
            for (let i = 2; i < pts.length; i += 2) path.lineTo(sx(pts[i]), sy(pts[i + 1]));
          }
        }, 0.6);
      }

      // one POI layer at a time: subway stations (trunk-colored) or bike docks
      // (blue), white-ringed dots — or the bus layer: every stop as a small
      // flat square with LIVE buses on top as bigger ringed dots, so a moving
      // bus never reads as a stop. (Per-entrance dots used to be scattered here
      // too — 835 green specks that read as visual noise.)
      if (d && layer === 'bus') {
        const sq = compact ? 1.7 : 2.4;
        ctx.fillStyle = '#8fa3b8';
        for (const [x, z] of d.busStops) {
          const X = sx(x), Y = sy(z);
          if (X < -4 || X > size + 4 || Y < -4 || Y > size + 4) continue;
          ctx.fillRect(X - sq / 2, Y - sq / 2, sq, sq);
        }
        const busR = compact ? 2.5 : 3.4;
        for (const b of world.getBuses()) {
          const X = sx(b.x), Y = sy(b.z);
          if (X < -6 || X > size + 6 || Y < -6 || Y > size + 6) continue;
          ctx.beginPath();
          ctx.arc(X, Y, busR, 0, Math.PI * 2);
          ctx.fillStyle = b.color;
          ctx.fill();
          ctx.lineWidth = compact ? 0.9 : 1.2;
          ctx.strokeStyle = '#f4f6f8';
          ctx.stroke();
        }
      } else if (d) {
        const dotR = compact ? 2.4 : 3.4;
        const pois: { x: number; z: number; color: string }[] = layer === 'bikes'
          ? d.docks.map(([x, z]) => ({ x, z, color: '#2f7fe0' }))
          : d.stations;
        for (const st of pois) {
          const X = sx(st.x), Y = sy(st.z);
          if (X < -6 || X > size + 6 || Y < -6 || Y > size + 6) continue;
          ctx.beginPath();
          ctx.arc(X, Y, dotR, 0, Math.PI * 2);
          ctx.fillStyle = st.color;
          ctx.fill();
          ctx.lineWidth = compact ? 0.9 : 1.2;
          ctx.strokeStyle = '#f4f6f8';
          ctx.stroke();
        }
      }

      // player heading arrow
      const a = compact ? 0.72 : 1;
      const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.atan2(fwdX, -fwdZ));
      ctx.beginPath();
      ctx.moveTo(0, -7 * a);
      ctx.lineTo(5 * a, 6 * a);
      ctx.lineTo(0, 3 * a);
      ctx.lineTo(-5 * a, 6 * a);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
      ctx.restore();

      // ring + north tick
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = `bold ${compact ? 8 : 10}px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText('N', cx, cy - R + (compact ? 9 : 11));
    };

    draw();
    const iv = window.setInterval(draw, 250);
    return () => window.clearInterval(iv);
  }, [world, zoomIdx, size, R, compact, layer]);

  // zoomIdx 0 is closest, so "+" walks toward 0
  const zoomIn = () => setZoomIdx((z) => Math.max(0, z - 1));
  const zoomOut = () => setZoomIdx((z) => Math.min(ZOOMS.length - 1, z + 1));
  const scale = ZOOMS[zoomIdx] >= 1000
    ? `${(ZOOMS[zoomIdx] / 1000).toFixed(1)} km`
    : `${ZOOMS[zoomIdx]} m`;

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <canvas
        ref={canvasRef}
        onClick={() => setZoomIdx((z) => (z + 1) % ZOOMS.length)}
        style={{ width: size, height: size, cursor: 'pointer', touchAction: 'manipulation' }}
        title="Click to cycle zoom"
      />
      <div className={`mm-zoom${compact ? ' compact' : ''}`}>
        <button
          onClick={(e) => { e.stopPropagation(); zoomIn(); }}
          disabled={zoomIdx === 0}
          aria-label="Zoom in"
        >+</button>
        {!compact && <span className="mm-scale">{scale}</span>}
        <button
          onClick={(e) => { e.stopPropagation(); zoomOut(); }}
          disabled={zoomIdx === ZOOMS.length - 1}
          aria-label="Zoom out"
        >−</button>
      </div>
    </div>
  );
}
