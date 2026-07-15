// Building color selection. Deterministic per building via hash.

export function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// Manhattan-ish material palettes [r,g,b] 0..1
const MASONRY: [number, number, number][] = [
  [0.62, 0.45, 0.36], // brick red-brown
  [0.71, 0.55, 0.44], // warm brick
  [0.76, 0.7, 0.58],  // limestone
  [0.8, 0.76, 0.68],  // pale limestone
  [0.55, 0.42, 0.34], // brownstone
  [0.67, 0.63, 0.57], // gray masonry
  [0.73, 0.66, 0.52], // tan
];

const TOWER: [number, number, number][] = [
  [0.62, 0.68, 0.74], // glass blue-gray
  [0.68, 0.72, 0.75], // silver glass
  [0.58, 0.62, 0.66], // dark glass
  [0.72, 0.7, 0.64],  // stone tower
  [0.55, 0.6, 0.68],  // blue curtain wall
];

export function buildingColor(seed: number, height: number): [number, number, number] {
  const r = hash01(seed);
  const pool = height > 90 ? TOWER : height > 45 ? (r > 0.4 ? TOWER : MASONRY) : MASONRY;
  const c = pool[Math.floor(hash01(seed + 7) * pool.length) % pool.length];
  // slight per-building jitter (also feeds the window shader's per-building randomness)
  const j = (hash01(seed + 13) - 0.5) * 0.08;
  return [
    Math.min(1, Math.max(0, c[0] + j)),
    Math.min(1, Math.max(0, c[1] + j)),
    Math.min(1, Math.max(0, c[2] + j * 0.8)),
  ];
}
