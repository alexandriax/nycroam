'use client';

import { useEffect, useRef, useState } from 'react';
import type { GoalTracker, Goal } from '../engine/goals';

/** Shared trophy cup — HUD button, modal header, and the progress flash. */
export function TrophyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

export default function GoalsModal({ tracker, onClose }: { tracker: GoalTracker; onClose: () => void }) {
  const [goals, setGoals] = useState<Goal[]>(() => tracker.snapshot());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const confirmTimer = useRef(0);

  // live-refresh while open
  useEffect(() => {
    setGoals(tracker.snapshot());
    return tracker.onChange(() => setGoals(tracker.snapshot()));
  }, [tracker]);

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const doneCount = goals.filter((g) => g.done).length;

  const armResetAll = () => {
    if (confirmReset) {
      tracker.resetAll();
      setConfirmReset(false);
      window.clearTimeout(confirmTimer.current);
    } else {
      setConfirmReset(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmReset(false), 3000);
    }
  };

  return (
    <div className="goals-backdrop" onClick={onClose}>
      <div className="goals-modal" role="dialog" aria-modal="true" aria-label="Goals"
        onClick={(e) => e.stopPropagation()}>
        <div className="goals-head">
          <TrophyIcon size={18} />
          <h2>Goals</h2>
          <span className="goals-tally">{doneCount}/{goals.length}</span>
          <button className="goals-close" onClick={onClose} aria-label="Close goals">×</button>
        </div>

        <div className="goals-list">
          {goals.map((g) => {
            const hasList = !!g.items;
            const isOpen = expanded === g.id;
            return (
              <div key={g.id} className={`goal${g.done ? ' done' : ''}`}>
                <div
                  className="goal-row"
                  role={hasList ? 'button' : undefined}
                  aria-expanded={hasList ? isOpen : undefined}
                  onClick={hasList ? () => setExpanded(isOpen ? null : g.id) : undefined}
                  style={{ cursor: hasList ? 'pointer' : 'default' }}
                >
                  <span className="goal-glyph" aria-hidden="true">{g.done ? '✓' : '○'}</span>
                  <span className="goal-label">{g.label}</span>
                  {g.hint && <span className="goal-hint">{g.hint}</span>}
                  {g.count && <span className="goal-count">{g.count.have}/{g.count.total}</span>}
                  {g.resettable && (
                    <button
                      className="goal-reset"
                      title="Reset this goal"
                      aria-label={`Reset ${g.label}`}
                      onClick={(e) => { e.stopPropagation(); tracker.resetGoal(g.id); }}
                    >↺</button>
                  )}
                  {hasList && <span className={`goal-chev${isOpen ? ' open' : ''}`} aria-hidden="true">›</span>}
                </div>
                {hasList && isOpen && (
                  <div className="goal-sub">
                    {g.items!.map((it) => (
                      <div key={it.name} className={`goal-item${it.done ? ' done' : ''}`}>{it.name}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="goals-foot">
          <button
            className={`goals-resetall${confirmReset ? ' armed' : ''}`}
            onClick={armResetAll}
            onBlur={() => { setConfirmReset(false); window.clearTimeout(confirmTimer.current); }}
          >
            {confirmReset ? 'Really reset all?' : 'Reset all'}
          </button>
        </div>
      </div>
    </div>
  );
}
