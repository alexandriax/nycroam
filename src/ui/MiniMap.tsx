'use client';

import { useEffect, useRef, useState } from 'react';
import type { World } from '../engine/World';

const SIZE = 208;
const R = SIZE / 2 - 6;
// meters from center to edge. Index 0 is the closest zoom (street level, where
// road centerlines are drawn); the old 9500m island-wide view is gone.
const ZOOMS = [220, 650, 2600];
const STREET_ZOOM_IDX = 0;

/**
 * Corner minimap: island silhouette, streets at the closest zoom, subway
 * stations (trunk-colored, ringed), entrance dots, and a heading arrow.
 */
export default function MiniMap({ world }: { world: World }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomIdx, setZoomIdx] = useState(1);
  const dataRef = useRef<{
    rings: number[][];
    stations: { x: number; z: number; color: string }[];
    entrances: [number, number][];
  } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let rings: number[][] = [];
      try {
        const res = await fetch('/geo/outline.json');
        if (res.ok) rings = (await res.json()).rings ?? [];
      } catch { /* silhouette optional */ }
      const md = world.mapData();
      if (alive) dataRef.current = { rings, ...md };
    })();
    return () => { alive = false; };
  }, [world]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = SIZE * dpr;
    cv.height = SIZE * dpr;

    const draw = () => {
      const d = dataRef.current;
      const p = world.getPos();
      const yaw = world.controlsRef.yaw;
      const radius = ZOOMS[zoomIdx];
      const s = R / radius;
      const cx = SIZE / 2, cy = SIZE / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);

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

      // streets, closest zoom only — centerlines stream in with the tiles, so
      // they exist exactly where the world is loaded
      if (zoomIdx === STREET_ZOOM_IDX) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // OPAQUE on purpose: roads arrive as many pieces (split at tile edges and
        // intersections), so translucent strokes double up where their round caps
        // overlap and freckle every junction with bright blobs.
        ctx.strokeStyle = '#93a1ae';
        for (const rp of world.roadPathsNear(p.x, p.z, 2)) {
          const count = rp.start.length - 1;
          for (let i = 0; i < count; i++) {
            const a = rp.start[i], b = rp.start[i + 1];
            // width in meters -> screen px, floored so alleys stay hairlines
            ctx.lineWidth = Math.max(0.7, rp.width[i] * s * 0.75);
            ctx.beginPath();
            ctx.moveTo(sx(rp.pts[a * 2]), sy(rp.pts[a * 2 + 1]));
            for (let j = a + 1; j < b; j++) ctx.lineTo(sx(rp.pts[j * 2]), sy(rp.pts[j * 2 + 1]));
            ctx.stroke();
          }
        }
      }

      if (d) {
        // subway entrances (the green dots you actually walk into)
        ctx.fillStyle = '#37e874';
        for (const [ex, ez] of d.entrances) {
          const X = sx(ex), Y = sy(ez);
          if (X < -4 || X > SIZE + 4 || Y < -4 || Y > SIZE + 4) continue;
          ctx.fillRect(X - 1, Y - 1, 2, 2);
        }

        // stations: trunk-colored, white-ringed
        for (const st of d.stations) {
          const X = sx(st.x), Y = sy(st.z);
          if (X < -6 || X > SIZE + 6 || Y < -6 || Y > SIZE + 6) continue;
          ctx.beginPath();
          ctx.arc(X, Y, 3.4, 0, Math.PI * 2);
          ctx.fillStyle = st.color;
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = '#f4f6f8';
          ctx.stroke();
        }
      }

      // player heading arrow
      const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.atan2(fwdX, -fwdZ));
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5, 6);
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
      ctx.font = 'bold 10px Helvetica, Arial';
      ctx.textAlign = 'center';
      ctx.fillText('N', cx, cy - R + 11);
    };

    draw();
    const iv = window.setInterval(draw, 250);
    return () => window.clearInterval(iv);
  }, [world, zoomIdx]);

  // zoomIdx 0 is closest, so "+" walks toward 0
  const zoomIn = () => setZoomIdx((z) => Math.max(0, z - 1));
  const zoomOut = () => setZoomIdx((z) => Math.min(ZOOMS.length - 1, z + 1));
  const scale = ZOOMS[zoomIdx] >= 1000
    ? `${(ZOOMS[zoomIdx] / 1000).toFixed(1)} km`
    : `${ZOOMS[zoomIdx]} m`;

  return (
    <div style={{ position: 'relative', width: SIZE, height: SIZE }}>
      <canvas
        ref={canvasRef}
        onClick={() => setZoomIdx((z) => (z + 1) % ZOOMS.length)}
        style={{ width: SIZE, height: SIZE, cursor: 'pointer', touchAction: 'manipulation' }}
        title="Click to cycle zoom"
      />
      <div className="mm-zoom">
        <button
          onClick={(e) => { e.stopPropagation(); zoomIn(); }}
          disabled={zoomIdx === 0}
          aria-label="Zoom in"
        >+</button>
        <span className="mm-scale">{scale}</span>
        <button
          onClick={(e) => { e.stopPropagation(); zoomOut(); }}
          disabled={zoomIdx === ZOOMS.length - 1}
          aria-label="Zoom out"
        >−</button>
      </div>
    </div>
  );
}
