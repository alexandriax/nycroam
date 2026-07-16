'use client';

import { useEffect, useRef, useState } from 'react';
import { World, LANDMARKS, type HudState } from '../engine/World';
import { routeColor, bulletTextColor } from '../engine/subway/types';
import MiniMap from './MiniMap';

function Bullets({ routes, size = 22 }: { routes: string[]; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 3, verticalAlign: 'middle' }}>
      {routes.map((r) => (
        <span key={r} className="bullet" style={{
          background: routeColor(r), color: bulletTextColor(r),
          width: size, height: size, fontSize: size * 0.6,
        }}>{r}</span>
      ))}
    </span>
  );
}

/** Virtual joystick (left = move). Right half of screen drags look. */
function TouchControls({ world }: { world: World }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controls = world.controlsRef;
    let moveId: number | null = null;
    let lookId: number | null = null;
    let moveOrigin = { x: 0, y: 0 };
    let lookLast = { x: 0, y: 0 };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (e.clientX < window.innerWidth * 0.45 && moveId === null) {
        moveId = e.pointerId;
        moveOrigin = { x: e.clientX, y: e.clientY };
        if (baseRef.current) {
          baseRef.current.style.opacity = '1';
          baseRef.current.style.left = `${e.clientX - 60}px`;
          baseRef.current.style.top = `${e.clientY - 60}px`;
        }
      } else if (lookId === null) {
        lookId = e.pointerId;
        lookLast = { x: e.clientX, y: e.clientY };
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId === moveId) {
        const dx = (e.clientX - moveOrigin.x) / 55;
        const dy = (e.clientY - moveOrigin.y) / 55;
        const len = Math.hypot(dx, dy);
        const cx = len > 1 ? dx / len : dx;
        const cy = len > 1 ? dy / len : dy;
        controls.setTouchMove(cx, cy);
        if (stickRef.current) {
          stickRef.current.style.transform = `translate(${cx * 34}px, ${cy * 34}px)`;
        }
      } else if (e.pointerId === lookId) {
        controls.addTouchLook(e.clientX - lookLast.x, e.clientY - lookLast.y);
        lookLast = { x: e.clientX, y: e.clientY };
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId === moveId) {
        moveId = null;
        controls.setTouchMove(0, 0);
        if (baseRef.current) baseRef.current.style.opacity = '0.35';
        if (stickRef.current) stickRef.current.style.transform = 'translate(0px, 0px)';
      }
      if (e.pointerId === lookId) lookId = null;
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [world]);

  return (
    <div ref={baseRef} style={{
      position: 'fixed', left: 40, bottom: 90, width: 120, height: 120,
      borderRadius: '50%', border: '2px solid rgba(255,255,255,0.35)',
      background: 'rgba(255,255,255,0.06)', opacity: 0.35, pointerEvents: 'none',
      transition: 'opacity 0.2s',
    }}>
      <div ref={stickRef} style={{
        position: 'absolute', left: 35, top: 35, width: 50, height: 50,
        borderRadius: '50%', background: 'rgba(255,255,255,0.45)',
      }} />
    </div>
  );
}

export default function NYCRoam() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [fade, setFade] = useState(false);
  const [showHelp, setShowHelp] = useState(true);
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    setIsTouch(navigator.maxTouchPoints > 1);
    const world = new World(canvasRef.current);
    worldRef.current = world;
    (window as unknown as { __nyc: World }).__nyc = world;
    world.onHud = setHud;
    world.onFade = setFade;
    world.init();
    return () => { world.destroy(); worldRef.current = null; };
  }, []);

  const loading = hud?.loading ?? true;
  const error = hud?.error ?? null;

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />

      {/* fade for subway transitions */}
      <div style={{
        position: 'absolute', inset: 0, background: '#000', pointerEvents: 'none',
        opacity: fade ? 1 : 0, transition: 'opacity 0.4s ease',
      }} />

      {/* top bar */}
      <div className="hud-panel" style={{
        position: 'absolute', top: 12, left: 12, padding: '7px 12px',
        display: 'flex', alignItems: 'center', gap: 9,
        maxWidth: 'calc(100vw - 268px)', overflow: 'hidden', whiteSpace: 'nowrap',
      }}>
        {/* the mascot IS the wordmark — sized to the text it replaces */}
        <img src="/mark.png" alt="NYC Roam" width={18} height={18} className="mark" draggable={false} />
        <span style={{ opacity: 0.62, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: 0.2 }}>
          {hud?.mode === 'station'
            ? <>{hud.stationName} <Bullets routes={hud.stationRoutes} size={16} /></>
            : 'Manhattan'}
        </span>
      </div>

      {/* stats + teleport */}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
        <select
          className="hud-panel jumpto"
          defaultValue=""
          onChange={(e) => {
            const lm = LANDMARKS.find((l) => l.name === e.target.value);
            if (lm) worldRef.current?.teleport(lm.lat, lm.lon);
            e.target.value = '';
          }}
        >
          <option value="" disabled>Jump to…</option>
          {LANDMARKS.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
        </select>
        <div className="hud-panel stats">
          {hud ? `${hud.fps} fps · ${hud.tilesLoaded} tiles${hud.tilesPending ? ` (+${hud.tilesPending})` : ''}${hud.fly ? ' · HELI' : ''}` : '—'}
        </div>
      </div>

      {/* minimap + helicopter toggle */}
      {worldRef.current && hud && !hud.loading && !hud.error && hud.mode === 'street' && (
        <div style={{ position: 'absolute', right: 12, bottom: isTouch ? 170 : 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <MiniMap world={worldRef.current} />
          {!isTouch && (
            <button
              onClick={() => { const c = worldRef.current?.controlsRef; if (c) c.fly = !c.fly; }}
              className={`hud-panel heli-btn${hud.fly ? ' on' : ''}`}
            >
              <span className="heli-ico">🚁</span>
              {hud.fly ? 'Land' : 'Helicopter'}
              <kbd>F</kbd>
            </button>
          )}
        </div>
      )}

      {/* riding panel */}
      {hud?.mode === 'ride' && hud.ride && (
        <div className="hud-panel" style={{
          position: 'absolute', bottom: isTouch ? 170 : 84, left: '50%', transform: 'translateX(-50%)',
          padding: '12px 20px', display: 'flex', gap: 12, alignItems: 'center', whiteSpace: 'nowrap',
        }}>
          <Bullets routes={[hud.ride.route]} size={28} />
          <div style={{ lineHeight: 1.45 }}>
            <div style={{ fontSize: 12, opacity: 0.65 }}>to {hud.ride.terminal}</div>
            <div style={{ fontSize: 15 }}>
              {hud.ride.state === 'dwell' && (hud.ride.atEnd
                ? <>Last stop — <b>{hud.ride.thisStop}</b></>
                : <>This is <b>{hud.ride.thisStop}</b></>)}
              {hud.ride.state === 'closing' && <span className="pulse">Stand clear of the closing doors</span>}
              {hud.ride.state === 'moving' && <>Next stop: <b>{hud.ride.nextStop ?? '—'}</b></>}
            </div>
            {hud.ride.state === 'dwell' && (
              <div style={{ fontSize: 11, opacity: 0.6 }}>{isTouch ? 'tap GO to step off' : 'press E to step off'}</div>
            )}
          </div>
        </div>
      )}

      {/* entrance / exit prompt */}
      {hud?.prompt && hud.mode !== 'ride' && (
        <div className="hud-panel pulse" style={{
          position: 'absolute', bottom: isTouch ? 170 : 96, left: '50%', transform: 'translateX(-50%)',
          padding: '10px 18px', fontSize: 15, display: 'flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap',
        }}>
          {hud.promptRoutes.length > 0 && <Bullets routes={hud.promptRoutes} />}
          <span>{hud.prompt}</span>
          <span style={{ opacity: 0.6, fontSize: 12 }}>{isTouch ? '· walk in / tap GO' : '· walk in or press E'}</span>
        </div>
      )}

      {/* touch buttons */}
      {isTouch && worldRef.current && (
        <>
          <TouchControls world={worldRef.current} />
          <div style={{ position: 'absolute', right: 20, bottom: 96, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(hud?.prompt || (hud?.mode === 'ride' && hud.ride?.state === 'dwell')) && (
              <button
                onClick={() => worldRef.current?.action()}
                style={{ width: 64, height: 64, borderRadius: '50%', border: 'none', background: '#00933C', color: '#fff', fontWeight: 700, fontSize: 16 }}
              >GO</button>
            )}
            {hud?.mode === 'street' && hud?.fly && (
              <>
                <button
                  onPointerDown={() => worldRef.current?.controlsRef.setTouchVertical(1)}
                  onPointerUp={() => worldRef.current?.controlsRef.setTouchVertical(0)}
                  onPointerLeave={() => worldRef.current?.controlsRef.setTouchVertical(0)}
                  style={{ width: 64, height: 64, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(12,14,18,0.7)', color: '#fff', fontSize: 22 }}
                >▲</button>
                <button
                  onPointerDown={() => worldRef.current?.controlsRef.setTouchVertical(-1)}
                  onPointerUp={() => worldRef.current?.controlsRef.setTouchVertical(0)}
                  onPointerLeave={() => worldRef.current?.controlsRef.setTouchVertical(0)}
                  style={{ width: 64, height: 64, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(12,14,18,0.7)', color: '#fff', fontSize: 22 }}
                >▼</button>
              </>
            )}
            {hud?.mode === 'street' && (
              <button
                onClick={() => { const c = worldRef.current?.controlsRef; if (c) c.fly = !c.fly; }}
                style={{ width: 64, height: 64, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.3)', background: hud?.fly ? '#0d5c33' : 'rgba(12,14,18,0.7)', color: '#fff', fontSize: 22 }}
              >🚁</button>
            )}
          </div>
        </>
      )}

      {/* controls help */}
      {!isTouch && showHelp && !loading && !error && (
        <div className="hud-panel legend" onClick={() => setShowHelp(false)} title="Click to hide">
          <div className="legend-row"><kbd>Click</kbd><span>Look</span></div>
          <div className="legend-row"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>Move</span></div>
          <div className="legend-row"><kbd>Shift</kbd><span>Run</span></div>
          <div className="legend-row"><kbd>F</kbd><span>Helicopter</span><kbd>Space</kbd><kbd>C</kbd><span>Up / down</span></div>
          <div className="legend-row"><kbd>E</kbd><span>Enter subway · board · step off</span></div>
        </div>
      )}

      {/* loading */}
      {loading && (
        <div style={{
          position: 'absolute', inset: 0, background: '#0b0e12', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{ fontSize: 26, letterSpacing: 6, fontWeight: 700 }}>NYC ROAM</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['1', 'A', 'N', '4', 'B', '7', 'L'].map((r) => (
              <span key={r} className="bullet pulse" style={{ background: routeColor(r), color: bulletTextColor(r) }}>{r}</span>
            ))}
          </div>
          <div style={{ opacity: 0.6, fontSize: 13 }}>Loading Manhattan…</div>
        </div>
      )}

      {/* error (street mode only — stations work without tiles) */}
      {error && hud?.mode !== 'station' && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(11,14,18,0.94)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <div className="hud-panel" style={{ maxWidth: 520, padding: 24, lineHeight: 1.6 }}>
            <h3 style={{ marginBottom: 10 }}>Map data missing</h3>
            <p style={{ opacity: 0.85, fontSize: 14 }}>{error}</p>
            <p style={{ opacity: 0.6, fontSize: 13, marginTop: 10 }}>
              The pipeline downloads OpenStreetMap + MTA data and builds tiles into <code>public/tiles</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
