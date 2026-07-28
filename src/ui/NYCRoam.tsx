'use client';

import { useEffect, useRef, useState } from 'react';
import { World, LANDMARKS, type HudState } from '../engine/World';
import { routeColor, bulletTextColor } from '../engine/subway/types';
import { LANDMARKS_REG } from '../engine/landmarks/registry';
import { abbreviateStreet } from '../engine/streetFurniture';
import MiniMap from './MiniMap';
import GoalsModal, { TrophyIcon } from './GoalsModal';
import InfoModal from './InfoModal';
import type { PlaqueInfo } from '../engine/PlaqueManager';
import {
  QUALITY_LEVELS, detectedQuality, qualityOverride, setQualityOverride, type QualityLevel,
} from '../engine/quality';

// Every premium landmark (skip alias entries — they resolve to another's build),
// sorted, for the "Jump to…" menu. Pairs with the ?landmark=<id> deep link.
const LANDMARK_JUMPS = LANDMARKS_REG
  .filter((l) => !l.aliasOf)
  .map((l) => ({ id: l.id, name: l.name, lat: l.lat, lon: l.lon }))
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
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [gfxOpen, setGfxOpen] = useState(false);
  const [gfx, setGfx] = useState<QualityLevel | null>(null); // null = auto-detected
  const [infoTarget, setInfoTarget] = useState<PlaqueInfo | null>(null); // building-info modal
  const [goalsDone, setGoalsDone] = useState(false); // all goals complete → gold trophy
  const [flashes, setFlashes] = useState<{ id: number; text: string }[]>([]);
  const flashId = useRef(0);

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
    // ?touch=1 forces the complete mobile QA path on desktop: this touch
    // layout plus World/quality's mobile stream radius, LOD and render tier.
    setIsTouch(navigator.maxTouchPoints > 1 || new URLSearchParams(location.search).has('touch'));
    setGfx(qualityOverride());
    const world = new World(canvasRef.current);
    worldRef.current = world;
    (window as unknown as { __nyc: World }).__nyc = world;
    world.onHud = setHud;
    world.onFade = setFade;
    world.onInfo = (info) => setInfoTarget(info);
    world.init();
    setMuted(world.audio.isMuted);
    // goals: flash messages (queued, max 2 pending) + the all-complete tint
    const unsubProgress = world.goals.onProgress((text) => {
      setFlashes((q) => {
        const next = [...q, { id: ++flashId.current, text }];
        return next.length > 3 ? next.slice(next.length - 3) : next; // 1 shown + 2 pending
      });
    });
    const syncDone = () => setGoalsDone(world.goals.allComplete());
    const unsubChange = world.goals.onChange(syncDone);
    syncDone();
    return () => {
      unsubProgress(); unsubChange();
      world.destroy(); worldRef.current = null;
    };
  }, []);

  // flash auto-dismiss: 4s per message, restarted only when the head changes
  const flashHead = flashes[0];
  useEffect(() => {
    if (!flashHead) return;
    const t = window.setTimeout(() => setFlashes((q) => q.slice(1)), 4000);
    return () => window.clearTimeout(t);
  }, [flashHead?.id]);

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

  // Graphics quality is baked into the scene at construction (shadow maps,
  // draw distance, worker count, texture filtering), so changing it reloads.
  // Rebuilding every material and worker pool in place would be a much larger
  // surface for very little gain -- this is a once-in-a-while setting.
  const pickQuality = (level: QualityLevel | null) => {
    setQualityOverride(level);
    window.location.reload();
  };

  // Live transit readout (which train/bus, next stop). Shared between the
  // desktop placement (centred, bottom) and mobile (tucked under the top-left
  // location panel so it doesn't cover the joystick/GO).
  const transitInner = hud?.mode === 'ride' && hud.ride ? (
    <>
      <Bullets routes={[hud.ride.route]} size={isTouch ? 24 : 28} />
      <div style={{ lineHeight: 1.4 }}>
        <div style={{ fontSize: 12, opacity: 0.65 }}>to {hud.ride.terminal}</div>
        <div style={{ fontSize: isTouch ? 14 : 15 }}>
          {hud.ride.state === 'dwell' && (hud.ride.atEnd
            ? <>Last stop: <b>{hud.ride.thisStop}</b></>
            : <>This is <b>{hud.ride.thisStop}</b></>)}
          {hud.ride.state === 'closing' && <span className="pulse">Stand clear of the closing doors</span>}
          {hud.ride.state === 'moving' && <>Next stop: <b>{hud.ride.thisStop}</b></>}
        </div>
        {hud.ride.state === 'dwell' && (
          <div style={{ fontSize: 11, opacity: 0.6 }}>{isTouch ? 'tap GO to step off' : 'press E to step off'}</div>
        )}
      </div>
    </>
  ) : hud?.mode === 'bus' && hud.bus ? (
    <>
      <BusChips badges={[{ id: hud.bus.route, color: hud.bus.color, sbs: hud.bus.sbs }]} size={isTouch ? 24 : 28} />
      <div style={{ lineHeight: 1.4 }}>
        <div style={{ fontSize: 12, opacity: 0.65 }}>to {hud.bus.dest}</div>
        <div style={{ fontSize: isTouch ? 14 : 15 }}>
          {hud.bus.state === 'dwell' && (hud.bus.atEnd
            ? <>Last stop: <b>{hud.bus.thisStop}</b></>
            : <>This is <b>{hud.bus.thisStop}</b></>)}
          {hud.bus.state === 'closing' && <span className="pulse">Doors closing</span>}
          {hud.bus.state === 'moving' && <>Next stop: <b>{hud.bus.thisStop}</b></>}
        </div>
        {hud.bus.state === 'dwell' && (
          <div style={{ fontSize: 11, opacity: 0.6 }}>{isTouch ? 'tap GO to step off' : 'press E to step off'}</div>
        )}
      </div>
    </>
  ) : null;

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />

      {/* fade for subway transitions */}
      <div style={{
        position: 'absolute', inset: 0, background: '#000', pointerEvents: 'none',
        opacity: fade ? 1 : 0, transition: 'opacity 0.4s ease',
      }} />

      {/* top-left: location panel, with the mobile transit readout stacked under it */}
      <div style={{
        position: 'absolute', top: 12, left: 12,
        display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start',
      }}>
        <div className="hud-panel" style={{
          padding: '7px 12px', display: 'flex', flexDirection: 'column', gap: 5,
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
        {/* mobile: which train/bus + next stop, right under the location panel */}
        {isTouch && transitInner && (
          <div className="hud-panel" style={{
            padding: '9px 14px', display: 'flex', gap: 10, alignItems: 'center',
            maxWidth: 'calc(100vw - 130px)',
          }}>
            {transitInner}
          </div>
        )}
      </div>

      {/* stats + teleport */}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
        {/* row 1: jump-to + share link side by side (like desktop, tidier on mobile) */}
        <div className="hud-row">
        <select
          className="hud-panel jumpto"
          defaultValue=""
          onChange={(e) => {
            const [kind, a, b] = e.target.value.split('|');
            if (kind === 'landmark') {
              const lm = LANDMARK_JUMPS.find((l) => l.id === a);
              if (lm) worldRef.current?.teleport(lm.lat, lm.lon, lm.id);
            } else {
              const la = Number(a), lo = Number(b);
              if (Number.isFinite(la) && Number.isFinite(lo)) worldRef.current?.teleport(la, lo);
            }
            e.target.value = '';
          }}
        >
          <option value="" disabled>Jump to…</option>
          <optgroup label="Popular">
            {LANDMARKS.map((l) => <option key={l.name} value={`place|${l.lat}|${l.lon}`}>{l.name}</option>)}
          </optgroup>
          <optgroup label="Landmarks">
            {LANDMARK_JUMPS.map((l) => <option key={l.name} value={`landmark|${l.id}`}>{l.name}</option>)}
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
        </div>
        {/* row 2: fps readout + sound on/off on one line */}
        <div className="hud-row">
        <div className="hud-panel stats">
          {hud ? `${hud.fps} fps · ${hud.tilesLoaded} tiles${hud.tilesPending ? ` (+${hud.tilesPending})` : ''}${hud.fly ? ' · HELI' : ''}${hud.riding ? ' · BIKE' : ''}${hud.mode === 'bus' ? ' · BUS' : ''}` : '–'}
        </div>
        {/* goals / achievements — opens the checklist modal */}
        <button
          className={`hud-panel share-btn goals-btn${goalsDone ? ' complete' : ''}`}
          onClick={() => setGoalsOpen(true)}
          title="Goals"
          aria-label="Goals"
        >
          <TrophyIcon size={15} />
        </button>
        {/* the same spot on the real map, and the real view from this corner */}
        {hud?.mode === 'street' && (
          <>
            <button
              className="hud-panel share-btn"
              onClick={() => {
                const u = worldRef.current?.mapsLink();
                if (u) window.open(u, '_blank', 'noopener');
              }}
              title="Open this spot in Google Maps"
              aria-label="Open this spot in Google Maps"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 4.2 5.8 2.4 10.2 4.2 14.5 2.4 V11.8 L10.2 13.6 5.8 11.8 1.5 13.6 Z" />
                <line x1="5.8" y1="2.4" x2="5.8" y2="11.8" />
                <line x1="10.2" y1="4.2" x2="10.2" y2="13.6" />
              </svg>
            </button>
            <button
              className="hud-panel share-btn"
              onClick={() => {
                const u = worldRef.current?.streetViewLink();
                if (u) window.open(u, '_blank', 'noopener');
              }}
              title="See the real view here in Google Street View"
              aria-label="See the real view here in Google Street View"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 8 C3.2 4.9 5.4 3.4 8 3.4 C10.6 3.4 12.8 4.9 14.5 8 C12.8 11.1 10.6 12.6 8 12.6 C5.4 12.6 3.2 11.1 1.5 8 Z" />
                <circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none" />
              </svg>
            </button>
          </>
        )}
        {/* graphics quality: auto-detected from the GPU, pinnable by the player */}
        <div className="gfx-wrap">
          <button
            className={`hud-panel share-btn${gfxOpen ? ' on' : ''}`}
            onClick={() => setGfxOpen((v) => !v)}
            title="Graphics quality"
            aria-label="Graphics quality"
            aria-expanded={gfxOpen}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <rect x="2" y="10" width="2.6" height="4" rx="0.6" fill="currentColor" stroke="none" />
              <rect x="5.9" y="7" width="2.6" height="7" rx="0.6" fill="currentColor" stroke="none" />
              <rect x="9.8" y="4" width="2.6" height="10" rx="0.6" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {gfxOpen && (
            <div className="hud-panel gfx-menu" role="menu" aria-label="Graphics quality">
              <button
                role="menuitemradio"
                aria-checked={gfx === null}
                className={gfx === null ? 'on' : ''}
                onClick={() => pickQuality(null)}
              >
                Auto <span>{detectedQuality()}</span>
              </button>
              {QUALITY_LEVELS.map((lv) => (
                <button
                  key={lv}
                  role="menuitemradio"
                  aria-checked={gfx === lv}
                  className={gfx === lv ? 'on' : ''}
                  onClick={() => pickQuality(lv)}
                >
                  {lv}
                </button>
              ))}
              <p>Reloads the world.</p>
            </div>
          )}
        </div>
        {/* sound on/off — the world's footsteps, engines, doors & rotors */}
        <button
          className={`hud-panel share-btn${muted ? ' muted' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Sound off: click to unmute' : 'Sound on: click to mute'}
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

      {/* desktop: the live transit readout stays centred at the bottom
          (on mobile it lives under the top-left location panel instead) */}
      {!isTouch && transitInner && (
        <div className="hud-panel" style={{
          position: 'absolute', bottom: 84, left: '50%', transform: 'translateX(-50%)',
          padding: '12px 20px', display: 'flex', gap: 12, alignItems: 'center', whiteSpace: 'nowrap',
        }}>
          {transitInner}
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

      {/* building-info plaque within reach — separate affordance from the transit
          prompt, so both can show. Tap/click opens the modal; desktop also has `i`. */}
      {hud?.nearInfo && hud.mode === 'street' && !infoTarget && (
        <button
          className={`hud-panel info-chip-hud${hud.nearInfo.lm ? ' lm' : ''}`}
          onClick={() => worldRef.current?.info()}
          style={{
            position: 'absolute', bottom: isTouch ? 222 : 140, left: '50%', transform: 'translateX(-50%)',
          }}
          aria-label={`Info: ${hud.nearInfo.label}`}
        >
          <span className="info-chip-glyph">ⓘ</span>
          <span className="info-chip-label">{hud.nearInfo.label}</span>
          <span className="info-chip-key">{isTouch ? 'tap' : 'press i'}</span>
        </button>
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

      {/* attribution — always visible, above the intro overlay. The OSM credit is
          not decoration: the world is a derivative database of OpenStreetMap, and
          ODbL 4.3 requires the notice to travel with any public display of it. */}
      <div className="credit hud-panel">
        <a className="credit-link" href="https://www.alexandriaredmon.com"
          target="_blank" rel="noopener noreferrer">
          <span className="credit-dot" />
          Made by Alexandria
          <span className="credit-arrow">↗</span>
        </a>
        <span className="credit-sep">·</span>
        <a className="credit-link" href="https://www.openstreetmap.org/copyright"
          target="_blank" rel="noopener noreferrer">
          © OpenStreetMap
          <span className="credit-arrow">↗</span>
        </a>
      </div>

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
            <p className="intro-msg intro-new">
              Every building wears its <b>address plaque</b>: walk up for its story,
              with <b>Wikipedia</b> info &amp; historic photos from <b>Old&nbsp;NYC</b>.
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
            <p className="intro-attrib">
              Map data ©{' '}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
                OpenStreetMap
              </a>{' '}
              contributors (ODbL) · MTA · NYC Open Data · USGS
            </p>
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

      {/* goal progress flash — click to open the Goals modal */}
      {flashHead && (
        <div className="goal-flash-wrap">
          <button
            key={flashHead.id}
            className="goal-flash"
            onClick={() => { setGoalsOpen(true); setFlashes([]); }}
          >
            <TrophyIcon size={15} />
            <span>{flashHead.text}</span>
          </button>
        </div>
      )}

      {/* goals / achievements modal */}
      {goalsOpen && worldRef.current && (
        <GoalsModal tracker={worldRef.current.goals} onClose={() => setGoalsOpen(false)} />
      )}

      {/* building-info modal */}
      {infoTarget && (
        <InfoModal info={infoTarget} world={worldRef.current} onClose={() => setInfoTarget(null)} />
      )}
    </div>
  );
}
