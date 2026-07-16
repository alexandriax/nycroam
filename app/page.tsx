'use client';

import dynamic from 'next/dynamic';

const NYCRoam = dynamic(() => import('../src/ui/NYCRoam'), {
  ssr: false,
  loading: () => (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14,
      background: '#0b0e12', color: '#e8eaed', fontSize: 18, letterSpacing: 2,
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/mark.png" alt="" width={64} height={64}
        style={{ filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.5))' }} />
      NYC ROAM
    </div>
  ),
});

export default function Page() {
  return <NYCRoam />;
}
