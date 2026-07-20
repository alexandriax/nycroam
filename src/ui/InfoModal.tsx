'use client';

import { useEffect, useState } from 'react';
import type { PlaqueInfo } from '../engine/PlaqueManager';
import { oldNycUrl } from '../engine/PlaqueManager';
import { fetchWiki, type WikiSummary } from '../engine/wiki';
import { xzToLonLat, googleMapsUrl } from '../engine/geo';
import type { World } from '../engine/World';

/** Prettify an OSM building=* value for display ("apartments" -> "Apartments"). */
const KIND_LABEL: Record<string, string> = {
  yes: 'Building', residential: 'Residential', apartments: 'Apartment building',
  commercial: 'Commercial', office: 'Office building', retail: 'Retail',
  house: 'House', detached: 'House', hotel: 'Hotel', church: 'Church',
  cathedral: 'Cathedral', chapel: 'Chapel', synagogue: 'Synagogue', mosque: 'Mosque',
  school: 'School', university: 'University', college: 'College', hospital: 'Hospital',
  civic: 'Civic building', government: 'Government building', public: 'Public building',
  industrial: 'Industrial', warehouse: 'Warehouse', train_station: 'Station',
  museum: 'Museum', theatre: 'Theater', hall: 'Hall', dormitory: 'Dormitory',
};
function kindLabel(k?: string): string | null {
  if (!k) return null;
  return KIND_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function InfoIcon({ lm }: { lm?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {lm ? (
        <>
          <path d="M3 21h18" />
          <path d="M5 21V8l7-4 7 4v13" />
          <path d="M9 21v-6h6v6" />
        </>
      ) : (
        <>
          <path d="M4 21h16" />
          <path d="M6 21V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v16" />
          <path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1" />
        </>
      )}
    </svg>
  );
}

export default function InfoModal({ info, world, onClose }: { info: PlaqueInfo; world: World | null; onClose: () => void }) {
  const [wiki, setWiki] = useState<WikiSummary | null>(null);
  const [wikiState, setWikiState] = useState<'idle' | 'loading' | 'done' | 'none'>('idle');

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Release pointer lock while the modal is open so its links are clickable
  // with a normal cursor, and restore it on close if the player had been
  // click-to-look (mirrors PlayerControls' own lock/drag state, not the
  // modal's — this only touches the lock, never movement/keys).
  useEffect(() => {
    const controls = world?.controlsRef;
    const wasLocked = controls?.releasePointerLock() ?? false;
    return () => { if (wasLocked) controls?.requestPointerLock(); };
  }, [world]);

  // live Wikipedia lookup (only when there's something to look up)
  useEffect(() => {
    const hasHint = info.wp || info.wd || (info.lm && info.nm);
    if (!hasHint) { setWikiState('none'); return; }
    let cancelled = false;
    setWikiState('loading');
    fetchWiki({ wp: info.wp, wd: info.wd, name: info.lm ? info.nm : undefined }).then((w) => {
      if (cancelled) return;
      setWiki(w);
      setWikiState(w ? 'done' : 'none');
    });
    return () => { cancelled = true; };
  }, [info]);

  const address = [info.num, info.st].filter(Boolean).join(' ');
  const title = info.nm || address || 'Building';
  const subtitle = info.nm && address ? address : null;
  const kind = kindLabel(info.k);
  const oldnyc = oldNycUrl(info.o);
  const [lon, lat] = xzToLonLat(info.x, info.z);
  const maps = googleMapsUrl(lat, lon);
  const streetView = world?.streetViewLinkForPlaque(info.x, info.z, info.a) ?? null;

  return (
    <div className="info-backdrop" onClick={onClose}>
      <div className="info-modal" role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()}>
        <div className={`info-head${info.lm ? ' lm' : ''}`}>
          <InfoIcon lm={info.lm} />
          <div className="info-title-wrap">
            <h2>{title}</h2>
            {subtitle && <div className="info-sub">{subtitle}</div>}
          </div>
          <button className="info-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="info-body">
          <div className="info-meta">
            {info.lm && <span className="info-chip lm">Landmark</span>}
            {kind && <span className="info-chip">{kind}</span>}
            {info.lv ? <span className="info-chip">{info.lv} floors</span> : null}
          </div>

          {wikiState === 'loading' && (
            <div className="info-wiki-loading">Looking up Wikipedia…</div>
          )}
          {wikiState === 'done' && wiki && (
            <div className="info-wiki">
              {wiki.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="info-thumb" src={wiki.thumbnail} alt="" />
              )}
              <p className="info-extract">{wiki.extract}</p>
              <a className="info-link" href={wiki.url} target="_blank" rel="noopener noreferrer">
                Read on Wikipedia <span className="info-arrow">↗</span>
              </a>
            </div>
          )}

          <div className="info-links">
            <a className="info-linkcard" href={maps} target="_blank" rel="noopener noreferrer">
              <span className="info-linkcard-icon">🗺️</span>
              <span><strong>Open in Google Maps</strong></span>
              <span className="info-arrow">↗</span>
            </a>
            {streetView && (
              <a className="info-linkcard" href={streetView} target="_blank" rel="noopener noreferrer">
                <span className="info-linkcard-icon">👁️</span>
                <span><strong>See it in Street View</strong></span>
                <span className="info-arrow">↗</span>
              </a>
            )}
            {oldnyc && (
              <a className="info-linkcard" href={oldnyc} target="_blank" rel="noopener noreferrer">
                <span className="info-linkcard-icon">🖼️</span>
                <span>
                  <strong>Historic photos nearby</strong>
                  <em>Old NYC · NYPL collection</em>
                </span>
                <span className="info-arrow">↗</span>
              </a>
            )}
          </div>

          <div className="info-attrib">
            Address © OpenStreetMap contributors
            {wikiState === 'done' && wiki ? ' · summary © Wikipedia' : ''}
            {oldnyc ? ' · photos via OldNYC / NYPL' : ''}
          </div>
        </div>
      </div>
    </div>
  );
}
