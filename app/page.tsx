'use client';

import dynamic from 'next/dynamic';

const NYCRoam = dynamic(() => import('../src/ui/NYCRoam'), {
  ssr: false,
  loading: () => (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#0b0e12', color: '#e8eaed',
      fontSize: 18, letterSpacing: 2,
    }}>
      NYC ROAM
    </div>
  ),
});

export default function Page() {
  return <NYCRoam />;
}
