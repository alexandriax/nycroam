'use client';

import { useEffect, useRef, useState } from 'react';
import { World, LANDMARKS, type HudState } from '../engine/World';
import { routeColor, bulletTextColor } from '../engine/subway/types';
import { LANDMARKS_REG } from '../engine/landmarks/registry';
import { abbreviateStreet } from '../engine/streetFurniture';
import MiniMap from './MiniMap';

// Every premium landmark (skip alias entries — they resolve to another's build),
// sorted, for the "Jump to…" menu. Pairs with the ?landmark=<id> deep link.
const LANDMARK_JUMPS = LANDMARKS_REG
  .filter((l) => !l.aliasOf)
  .map((l) => ({ name: l.name, lat: l.lat, lon: l.lon }))
  .sort((a, b) => a.name.localeCompare(b.name));

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

/** Bus route chips: MTA buses use rounded rectangles, not subway bullets. */
function BusChips({ badges, size = 22 }: { badges: { id: string; color: string; sbs: boolean }[]; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 3, verticalAlign: 'middle', flexWrap: 'wrap' }}>
      {badges.slice(0, 5).map((b) => (
        <span key={b.id} style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: b.color, color: '#fff', borderRadius: size * 0.2,
          height: size, padding: `0 ${Math.round(size * 0.28)}px`,
          fontWeight: 700, fontSize: size * 0.5, letterSpacing: 0.4,
          boxShadow: b.sbs ? 'inset 0 0 0 2px #00a6ce' : undefined,
        }}>{b.id}</span>
      ))}
      {badges.length > 5 && <span style={{ fontSize: size * 0.5, opacity: 0.7 }}>+{badges.length - 5}</span>}
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
  const [mapLayer, setMapLayer] = useState<'transit' | 'bikes' | 'bus'>('transit');
  // the intro overlay doubles as the loading screen: it persists after the world
  // is ready as a frosted-glass welcome card, dismissed with "Explore".
  const [intro, setIntro] = useState(true);
  const [introLeaving, setIntroLeaving] = useState(false);
  const [muted, setMuted] = useState(false);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);

  const copyShareLink = async () => {
    const url = worldRef.current?.shareLink();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard API can be unavailable (http, permissions) — legacy fallback
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  useEffect(() => {
    if (!canvasRef.current) return;
    // ?touch=1 forces the touch layout on a desktop browser (joystick, GO,
    // half-size map) — same spirit as ?tick=1 / ?station=
    setIsTouch(navigator.maxTouchPoints > 1 || new URLSearchParams(location.search).has('touch'));
    const world = new World(canvasRef.current);
    worldRef.current = world;
    (window as unknown as { __nyc: World }).__nyc = world;
    world.onHud = setHud;
    world.onFade = setFade;
    world.init();
    setMuted(world.audio.isMuted);
    return () => { world.destroy(); worldRef.current = null; };
  }, []);

  const loading = hud?.loading ?? true;
  const error = hud?.error ?? null;

  const dismissIntro = () => {
    worldRef.current?.audio.unlock(); // the tap that starts the world starts the audio
    setIntroLeaving(true);
    window.setTimeout(() => setIntro(false), 560); // matches the CSS fade
  };

  const toggleMute = () => {
    const w = worldRef.current;
    if (w) setMuted(w.audio.toggleMuted());
  };

  const toggleRun = () => {
    const c = worldRef.current?.controlsRef;
    if (c) { c.run = !c.run; setRunning(c.run); }
  };

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
        display: 'flex', flexDirection: 'column', gap: 5,
        maxWidth: 'calc(100vw - 268px)', overflow: 'hidden', whiteSpace: 'nowrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          {/* the mascot IS the wordmark — sized to the text it replaces */}
          <img src="/mark.png" alt="NYC Roam" width={18} height={18} className="mark" draggable={false} />
          <span style={{ opacity: 0.62, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: 0.2 }}>
            {hud?.mode === 'station'
              ? <>{hud.stationName} <Bullets routes={hud.stationRoutes} size={16} /></>
              : (hud?.area ?? 'Manhattan')}
          </span>
        </div>
        {/* current street, styled like the blade signs on the corners */}
        {(hud?.mode === 'street' || hud?.mode === 'bus') && hud?.street && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="street-blade">{abbreviateStreet(hud.street)}</span>
            {hud.cross && <span className="street-blade cross">{abbreviateStreet(hud.cross)}</span>}
          </div>
        )}
      </div>

      {/* stats + teleport */}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
        <select
          className="hud-panel jumpto"
          defaultValue=""
          onChange={(e) => {
            const [la, lo] = e.target.value.split(',').map(Number);
            if (Number.isFinite(la) && Number.isFinite(lo)) worldRef.current?.teleport(la, lo);
            e.target.value = '';
          }}
        >
          <option value="" disabled>Jump to…</option>
          <optgroup label="Popular">
            {LANDMARKS.map((l) => <option key={l.name} value={`${l.lat},${l.lon}`}>{l.name}</option>)}
          </optgroup>
          <optgroup label="Landmarks">
            {LANDMARK_JUMPS.map((l) => <option key={l.name} value={`${l.lat},${l.lon}`}>{l.name}</option>)}
          </optgroup>
        </select>
        {/* copy a deep link to this exact view (position + camera + transit state) */}
        <button
          className={`hud-panel share-btn${copied ? ' ok' : ''}`}
          onClick={copyShareLink}
          title="Copy a link to this exact view"
          aria-label="Copy a link to this exact view"
        >
          {copied ? (
            <>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 8.5 L6 12 L13.5 4" />
              </svg>
              Copied
            </>
          ) : (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.7 9.3 L9.3 6.7" />
              <path d="M7.8 4.9 L9.6 3.1 a2.55 2.55 0 0 1 3.6 3.6 L11.4 8.5" />
              <path d="M8.2 11.1 L6.4 12.9 a2.55 2.55 0 0 1 -3.6 -3.6 L4.6 7.5" />
            </svg>
          )}
        </button>
        {/* sound on/off — the world's footsteps, engines, doors & rotors */}
        <button
          className={`hud-panel share-btn${muted ? ' muted' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Sound off — click to unmute' : 'Sound on — click to mute'}
          aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6 H4.5 L7.5 3.3 V12.7 L4.5 10 H2.5 Z" fill="currentColor" stroke="none" />
            {muted ? (
              <>
                <line x1="10.4" y1="6" x2="13.6" y2="10" />
                <line x1="13.6" y1="6" x2="10.4" y2="10" />
              </>
            ) : (
              <>
                <path d="M10 5.4 a3.2 3.2 0 0 1 0 5.2" />
                <path d="M11.7 3.7 a5.6 5.6 0 0 1 0 8.6" />
              </>
            )}
          </svg>
        </button>
        <div className="hud-panel stats">
          {hud ? `${hud.fps} fps · ${hud.tilesLoaded} tiles${hud.tilesPending ? ` (+${hud.tilesPending})` : ''}${hud.fly ? ' · HELI' : ''}${hud.riding ? ' · BIKE' : ''}${hud.mode === 'bus' ? ' · BUS' : ''}` : '—'}
        </div>

        {/* controls legend */}
        {!isTouch && showHelp && !loading && !error && (
          <div className="hud-panel legend" onClick={() => setShowHelp(false)} title="Click to hide">
            <div className="legend-row"><kbd>Click</kbd><span>Look</span></div>
            <div className="legend-row"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>Move</span></div>
            <div className="legend-row"><kbd>Shift</kbd><span>Run</span></div>
            <div className="legend-row"><kbd>Space</kbd><kbd>C</kbd><span>Fly up / down</span></div>
            <div className="legend-row"><kbd>E</kbd><span>Enter subway · board · step off</span></div>
          </div>
        )}

        {/* helicopter + its altitude pair sit under the legend, not over the map */}
        {hud && !hud.loading && !hud.error && hud.mode === 'street' && !hud.riding && (
          <button
            onClick={() => { const c = worldRef.current?.controlsRef; if (c) c.fly = !c.fly; }}
            className={`hud-panel heli-btn${hud.fly ? ' on' : ''}${isTouch ? ' touch' : ''}`}
          >
            <span className="heli-ico">🚁</span>
            {hud.fly ? 'Land' : 'Helicopter'}
            {!isTouch && <kbd>F</kbd>}
          </button>
        )}
        {isTouch && hud?.mode === 'street' && hud?.fly && (
          <div className="alt-pair">
            <button
              className="hud-panel alt-btn"
              onPointerDown={() => worldRef.current?.controlsRef.setTouchVertical(1)}
              onPointerUp={() => worldRef.current?.controlsRef.setTouchVertical(0)}
              onPointerLeave={() => worldRef.current?.controlsRef.setTouchVertical(0)}
              aria-label="Ascend"
            >▲</button>
            <button
              className="hud-panel alt-btn"
              onPointerDown={() => worldRef.current?.controlsRef.setTouchVertical(-1)}
              onPointerUp={() => worldRef.current?.controlsRef.setTouchVertical(0)}
              onPointerLeave={() => worldRef.current?.controlsRef.setTouchVertical(0)}
              aria-label="Descend"
            >▼</button>
          </div>
        )}
        {/* walk/run toggle — touch has no Shift key, so sprint needs a button.
            Shown on the street AND on subway platforms (both honour sprint). */}
        {isTouch && (hud?.mode === 'street' || hud?.mode === 'station') && !hud?.riding && !hud?.fly && (
          <button
            onClick={toggleRun}
            className={`hud-panel run-btn${running ? ' on' : ''}`}
            aria-label={running ? 'Switch to walking' : 'Switch to running'}
          >
            <span className="run-ico">{running ? '🏃' : '🚶'}</span>
            {running ? 'Running' : 'Walk'}
          </button>
        )}
      </div>

      {/* minimap: bottom-right corner in every view, half size on touch */}
      {worldRef.current && hud && !hud.loading && !hud.error && (hud.mode === 'street' || hud.mode === 'bus') && (
        <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div className="layer-toggle" role="tablist" aria-label="Map layer">
            <button
              role="tab"
              aria-selected={mapLayer === 'transit'}
              className={mapLayer === 'transit' ? 'on' : ''}
              onClick={() => setMapLayer('transit')}
              title="Subway stations"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.2" y="1.8" width="9.6" height="10" rx="2.2" />
                <line x1="3.2" y1="7.4" x2="12.8" y2="7.4" />
                <circle cx="5.7" cy="9.9" r="0.4" fill="currentColor" />
                <circle cx="10.3" cy="9.9" r="0.4" fill="currentColor" />
                <line x1="5.4" y1="14.2" x2="4.2" y2="12" />
                <line x1="10.6" y1="14.2" x2="11.8" y2="12" />
              </svg>
            </button>
            <button
              role="tab"
              aria-selected={mapLayer === 'bikes'}
              className={mapLayer === 'bikes' ? 'on' : ''}
              onClick={() => setMapLayer('bikes')}
              title="Bike docks"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="3.6" cy="11" r="2.6" />
                <circle cx="12.4" cy="11" r="2.6" />
                <path d="M3.6 11 L6.2 5.6 L10.6 5.6" />
                <path d="M6.2 5.6 L8.6 11 L3.6 11" />
                <line x1="9.9" y1="3.6" x2="11.2" y2="3.6" />
                <line x1="10.6" y1="3.6" x2="12.4" y2="11" />
              </svg>
            </button>
            <button
              role="tab"
              aria-selected={mapLayer === 'bus'}
              className={mapLayer === 'bus' ? 'on' : ''}
              onClick={() => setMapLayer('bus')}
              title="Bus stops + live buses"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="1.8" width="10" height="11.2" rx="1.6" />
                <line x1="3" y1="6.6" x2="13" y2="6.6" />
                <line x1="5.2" y1="3.2" x2="10.8" y2="3.2" />
                <circle cx="5.6" cy="10.4" r="0.5" fill="currentColor" />
                <circle cx="10.4" cy="10.4" r="0.5" fill="currentColor" />
                <line x1="4.6" y1="14.6" x2="4.6" y2="13" />
                <line x1="11.4" y1="14.6" x2="11.4" y2="13" />
              </svg>
            </button>
          </div>
          <MiniMap world={worldRef.current} size={isTouch ? 104 : 208} layer={mapLayer} />
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
              {/* while moving, RideWorld has already advanced idx to the station
                  we're pulling into, so thisStop IS the next stop (nextStop is the
                  one after — showing it here announced a stop too far ahead). */}
              {hud.ride.state === 'moving' && <>Next stop: <b>{hud.ride.thisStop}</b></>}
            </div>
            {hud.ride.state === 'dwell' && (
              <div style={{ fontSize: 11, opacity: 0.6 }}>{isTouch ? 'tap GO to step off' : 'press E to step off'}</div>
            )}
          </div>
        </div>
      )}

      {/* bus riding panel */}
      {hud?.mode === 'bus' && hud.bus && (
        <div className="hud-panel" style={{
          position: 'absolute', bottom: isTouch ? 170 : 84, left: '50%', transform: 'translateX(-50%)',
          padding: '12px 20px', display: 'flex', gap: 12, alignItems: 'center', whiteSpace: 'nowrap',
        }}>
          <BusChips badges={[{ id: hud.bus.route, color: hud.bus.color, sbs: hud.bus.sbs }]} size={28} />
          <div style={{ lineHeight: 1.45 }}>
            <div style={{ fontSize: 12, opacity: 0.65 }}>to {hud.bus.dest}</div>
            <div style={{ fontSize: 15 }}>
              {hud.bus.state === 'dwell' && (hud.bus.atEnd
                ? <>Last stop — <b>{hud.bus.thisStop}</b></>
                : <>This is <b>{hud.bus.thisStop}</b></>)}
              {hud.bus.state === 'closing' && <span className="pulse">Doors closing</span>}
              {hud.bus.state === 'moving' && <>Next stop: <b>{hud.bus.thisStop}</b></>}
            </div>
            {hud.bus.state === 'dwell' && (
              <div style={{ fontSize: 11, opacity: 0.6 }}>{isTouch ? 'tap GO to step off' : 'press E to step off'}</div>
            )}
          </div>
        </div>
      )}

      {/* entrance / exit prompt */}
      {hud?.prompt && hud.mode !== 'ride' && hud.mode !== 'bus' && (
        <div className="hud-panel pulse" style={{
          position: 'absolute', bottom: isTouch ? 170 : 96, left: '50%', transform: 'translateX(-50%)',
          padding: '10px 18px', fontSize: 15, display: 'flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap',
        }}>
          {hud.promptRoutes.length > 0 && <Bullets routes={hud.promptRoutes} />}
          {hud.promptBus.length > 0 && <BusChips badges={hud.promptBus} />}
          <span>{hud.prompt}</span>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {hud.promptHint
              ? (isTouch ? `· ${hud.promptHint} (GO)` : `· ${hud.promptHint} (E)`)
              : (isTouch ? '· walk in / tap GO' : '· walk in or press E')}
          </span>
        </div>
      )}

      {/* touch buttons */}
      {isTouch && worldRef.current && (
        <>
          <TouchControls world={worldRef.current} />
          {/* GO sits above the minimap, which now owns the bottom-right corner */}
          {(hud?.prompt
            || (hud?.mode === 'ride' && hud.ride?.state === 'dwell')
            || (hud?.mode === 'bus' && hud.bus?.state === 'dwell')) && (
            <button
              onClick={() => worldRef.current?.action()}
              className="go-btn"
              style={{ bottom: hud?.mode === 'street' || hud?.mode === 'bus' ? 128 : 24 }}
            >GO</button>
          )}
        </>
      )}

      {/* attribution — always visible, above the intro overlay */}
      <a className="credit hud-panel" href="https://www.alexandriaredmon.com"
        target="_blank" rel="noopener noreferrer">
        <span className="credit-dot" />
        Made by Alexandria
        <span className="credit-arrow">↗</span>
      </a>

      {/* intro overlay = the loading screen, kept as a frosted-glass welcome card
          over the (blurred) loaded world until the visitor taps Explore */}
      {intro && !error && (
        <div className={`intro-overlay${introLeaving ? ' leaving' : ''}`}
          onClick={loading ? undefined : dismissIntro}>
          <div className="intro-card">
            <img src="/mark.png" alt="" width={64} height={64} className="intro-mark" draggable={false} />
            <div className="intro-word">NYC ROAM</div>
            <div className="intro-bullets">
              {['1', 'A', 'N', '7', 'B', 'L'].map((r) => (
                <span key={r} className={`bullet${loading ? ' pulse' : ''}`}
                  style={{ background: routeColor(r), color: bulletTextColor(r) }}>{r}</span>
              ))}
            </div>
            <p className="intro-msg">
              An explorable <b>Manhattan</b> built from real map &amp; transit
              data. Ride any <b>subway</b>, <b>bus</b>, or <b>bike</b> along its true routes
              &amp; stops, or take <b>helicopter mode</b> and fly above the city to explore.
            </p>
            {loading ? (
              <button className="intro-cta loading" disabled>
                <span className="intro-spinner" />Loading Manhattan…
              </button>
            ) : (
              <button className="intro-cta" autoFocus>
                Explore Manhattan
              </button>
            )}
          </div>
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
