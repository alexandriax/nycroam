'use client';

import { useEffect, useRef, useState } from 'react';
import { dataUrl } from '../engine/dataver';
import type { World } from '../engine/World';
import { PATH_KIND_BIKE, PATH_KIND_SERVICE } from '../engine/tileTypes';
import { SANS } from '../engine/fonts';

// meters from center to edge. The widest shows most of the island at once.
const ZOOMS = [220, 650, 2600, 6500];
// The two closest zooms draw every street from the tile stream. The wide ones
// can't — tiles only load within ~1.1km — so they fall back to the baked
// island-wide major-street skeleton (public/geo/streets.json).
const STREET_MAX_ZOOM_IDX = 1;
const MAJORS_ZOOM_IDX = 2; // this index and wider use the baked skeleton

type Majors = { w: number; p: number[] }[];

/**
 * Corner minimap: island silhouette, streets, one POI layer (subway stations /
 * bike docks / bus stops + live buses), and a heading arrow. Drag to pan the
 * view off the player; a re-center button restores auto-follow.
 */
export default function MiniMap({ world, size = 208, layer = 'transit' }: { world: World; size?: number; layer?: 'transit' | 'bikes' | 'bus' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomIdx, setZoomIdx] = useState(1);
  const [following, setFollowing] = useState(true);
  const followRef = useRef(true);
  const panRef = useRef<{ x: number; z: number }>({ x: 0, z: 0 });
  const dragRef = useRef(false);
  const lastPtr = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const movedRef = useRef(0);
  const dataRef = useRef<{
    rings: number[][];
    stations: { x: number; z: number; color: string }[];
    docks: [number, number][];
    busStops: [number, number][];
    majors: Majors;
  } | null>(null);

  const R = size / 2 - 6;
  const compact = size < 160;

  const recenter = () => { followRef.current = true; setFollowing(true); };
  const setFollow = (on: boolean) => { followRef.current = on; setFollowing(on); };

  useEffect(() => {
    let alive = true;
    (async () => {
      const grab = async (url: string) => {
        try {
          const res = await fetch(url);
          return res.ok ? await res.json() : null;
        } catch { return null; }
      };
      const [outline, streets] = await Promise.all([grab(dataUrl('/geo/outline.json')), grab(dataUrl('/geo/streets.json'))]);
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
      // map center: the player when following, else the panned point
      const c = followRef.current ? { x: p.x, z: p.z } : panRef.current;
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

      const sx = (wx: number) => cx + (wx - c.x) * s;
      const sy = (wz: number) => cy + (wz - c.z) * s;

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
        // full detail from the tile stream around the map center. Cover the whole
        // visible circle: the player sits anywhere within their own tile, hence
        // radius + one tile. (When panned far this is empty — tiles only stream
        // near the player — but the outline + POIs still draw.)
        const tileR = Math.ceil(radius / 256) + 1;
        // bike lanes stroke separately (green, on top of the street grid)
        const bikePath = new Path2D();
        let hasBike = false;
        strokeBuckets((bucket) => {
          for (const rp of world.roadPathsNear(c.x, c.z, tileR)) {
            const count = rp.start.length - 1;
            for (let i = 0; i < count; i++) {
              // service lanes ride in RoadPaths only so the placement solver can
              // see them; drawing driveways and parking aisles would bury the grid
              if (rp.kind[i] === PATH_KIND_SERVICE) continue;
              const a = rp.start[i], b = rp.start[i + 1];
              const isBike = rp.kind[i] === PATH_KIND_BIKE;
              const path = isBike ? bikePath : bucket(rp.width[i] * s * 0.75);
              if (isBike) hasBike = true;
              path.moveTo(sx(rp.pts[a * 2]), sy(rp.pts[a * 2 + 1]));
              for (let j = a + 1; j < b; j++) path.lineTo(sx(rp.pts[j * 2]), sy(rp.pts[j * 2 + 1]));
            }
          }
        }, 0.7);
        if (hasBike) {
          ctx.strokeStyle = '#2da05a';
          ctx.lineWidth = Math.max(0.8, 2.4 * s * 0.75);
          ctx.stroke(bikePath);
        }
      } else if (zoomIdx >= MAJORS_ZOOM_IDX && d?.majors.length) {
        // avenues + highways only, island-wide, with a viewport cull
        const lim = radius * 1.05;
        strokeBuckets((bucket) => {
          for (const way of d.majors) {
            const pts = way.p;
            let visible = false;
            for (let i = 0; i < pts.length; i += 2) {
              if (Math.abs(pts[i] - c.x) < lim && Math.abs(pts[i + 1] - c.z) < lim) { visible = true; break; }
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

      // player heading arrow, drawn at the player's actual position (= center
      // when following, elsewhere when panned).
      const a = compact ? 0.72 : 1;
      const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
      const pX = sx(p.x), pY = sy(p.z);
      ctx.save();
      ctx.translate(pX, pY);
      ctx.rotate(Math.atan2(fwdX, -fwdZ));
      ctx.beginPath();
      ctx.moveTo(0, -7 * a);
      ctx.lineTo(5 * a, 6 * a);
      ctx.lineTo(0, 3 * a);
      ctx.lineTo(-5 * a, 6 * a);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
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

  // ---- drag-to-pan (pointer events cover mouse + touch) ----
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = true;
    movedRef.current = 0;
    lastPtr.current = { x: e.clientX, y: e.clientY };
    // seed the pan point from the current center so the first drag has no jump
    if (followRef.current) {
      const p = world.getPos();
      panRef.current = { x: p.x, z: p.z };
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const s = R / ZOOMS[zoomIdx];
    const dx = e.clientX - lastPtr.current.x, dy = e.clientY - lastPtr.current.y;
    lastPtr.current = { x: e.clientX, y: e.clientY };
    movedRef.current += Math.abs(dx) + Math.abs(dy);
    // drag the map with the finger: content follows the pointer, so the center
    // moves opposite to the drag
    panRef.current.x -= dx / s;
    panRef.current.z -= dy / s;
    if (followRef.current) setFollow(false);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ width: size, height: size, cursor: following ? 'grab' : 'grabbing', touchAction: 'none' }}
        title="Drag to pan"
      />
      {!following && (
        <button
          className={`mm-recenter${compact ? ' compact' : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); recenter(); }}
          title="Re-center on me"
          aria-label="Re-center on me"
        >
          <svg viewBox="0 0 16 16" width={compact ? 11 : 13} height={compact ? 11 : 13} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="3.2" />
            <line x1="8" y1="1" x2="8" y2="3.4" />
            <line x1="8" y1="12.6" x2="8" y2="15" />
            <line x1="1" y1="8" x2="3.4" y2="8" />
            <line x1="12.6" y1="8" x2="15" y2="8" />
          </svg>
        </button>
      )}
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
