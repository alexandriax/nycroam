import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SubwayData, StationSpec, EntranceSpec } from './subway/types';
import { buildEntranceKit } from './streetprops';
import { heightAt } from './terrain';

/**
 * Collapse a prop group into one mesh per material (a kit is otherwise ~40
 * meshes — railing posts, steps, rails — which wrecks the draw-call budget).
 */
export function mergeByMaterial(group: THREE.Group): THREE.Group {
  group.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  group.traverse((o) => {
    if (o instanceof THREE.Mesh && !Array.isArray(o.material)) {
      const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      // drop UVs mismatches: mergeGeometries needs consistent attributes
      const list = byMat.get(o.material) ?? [];
      list.push(g);
      byMat.set(o.material, list);
    }
  });
  const out = new THREE.Group();
  out.name = group.name;
  for (const [mat, geos] of byMat) {
    // normalize attribute sets (some builder geometries lack uv)
    const attrNames = ['position', 'normal', 'uv'];
    const allHaveUv = geos.every((g) => g.getAttribute('uv'));
    for (const g of geos) {
      for (const name of Object.keys(g.attributes)) {
        if (!attrNames.includes(name)) g.deleteAttribute(name);
      }
      if (!allHaveUv && g.getAttribute('uv')) g.deleteAttribute('uv');
      if (g.index === null) g.setIndex([...Array(g.getAttribute('position').count).keys()]);
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.matrixAutoUpdate = false;
    out.add(mesh);
  }
  // dispose source geometries from the original group
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  return out;
}

interface PlacedEntrance {
  spec: EntranceSpec;
  station: StationSpec;
  group: THREE.Group;
  pos: [number, number]; // building-ejected position (kits at building lines get pushed to the sidewalk)
}

// soft additive light column so entrances read from down the block
let beaconGeo: THREE.BufferGeometry | null = null;
let beaconMat: THREE.MeshBasicMaterial | null = null;
function makeBeacon(): THREE.Mesh {
  if (!beaconGeo) {
    const a = new THREE.PlaneGeometry(1.0, 5.4);
    const b = a.clone().rotateY(Math.PI / 2);
    const pos = new Float32Array([...a.getAttribute('position').array, ...b.getAttribute('position').array]);
    const uv = new Float32Array([...a.getAttribute('uv').array, ...b.getAttribute('uv').array]);
    const idx: number[] = [];
    const ia = a.getIndex()!, ib = b.getIndex()!;
    for (let i = 0; i < ia.count; i++) idx.push(ia.getX(i));
    for (let i = 0; i < ib.count; i++) idx.push(ib.getX(i) + a.getAttribute('position').count);
    beaconGeo = new THREE.BufferGeometry();
    beaconGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    beaconGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    beaconGeo.setIndex(idx);
    a.dispose(); b.dispose();

    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 128;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(72,255,143,0)');
    g.addColorStop(0.75, 'rgba(72,255,143,0.28)');
    g.addColorStop(1, 'rgba(72,255,143,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    beaconMat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
  }
  const m = new THREE.Mesh(beaconGeo, beaconMat!);
  m.userData.shared = true; // disposeGroup must not free the shared geometry
  m.renderOrder = 5;
  return m;
}

/**
 * Streams subway entrance kits in/out around the player and reports the
 * nearest enterable entrance for HUD prompts + transitions.
 */
export class EntranceManager {
  private scene: THREE.Scene;
  private data: SubwayData | null = null;
  private stations = new Map<string, StationSpec>();
  private placed = new Map<number, PlacedEntrance>();
  private placeRadius = 420;
  private timer = 0;
  private eject: ((x: number, z: number) => [number, number] | null) | null;
  private wallDir: ((x: number, z: number) => [number, number] | null) | null;

  constructor(
    scene: THREE.Scene,
    eject: ((x: number, z: number) => [number, number] | null) | null = null,
    wallDir: ((x: number, z: number) => [number, number] | null) | null = null,
  ) {
    this.wallDir = wallDir;
    this.scene = scene;
    this.eject = eject;
  }

  async init(): Promise<boolean> {
    try {
      const res = await fetch('/subway/subway.json');
      if (!res.ok) return false;
      this.data = (await res.json()) as SubwayData;
      for (const s of this.data.stations) this.stations.set(s.id, s);
      return true;
    } catch {
      return false;
    }
  }

  get stationCount() { return this.stations.size; }
  get entranceCount() { return this.data?.entrances.length ?? 0; }

  stationFor(e: EntranceSpec): StationSpec | undefined {
    return this.stations.get(e.stationId);
  }

  findStation(pred: (s: StationSpec) => boolean): StationSpec | null {
    for (const s of this.stations.values()) if (pred(s)) return s;
    return null;
  }

  get stationsMap(): Map<string, StationSpec> {
    return this.stations;
  }

  entrancePositions(): [number, number][] {
    return (this.data?.entrances ?? []).map((e) => e.pos);
  }

  /** A street entrance position for the given station (nearest to the station point). */
  entranceFor(spec: StationSpec): [number, number] {
    let best: [number, number] = spec.pos;
    let bestD = Infinity;
    if (this.data) {
      for (const e of this.data.entrances) {
        if (e.stationId !== spec.id) continue;
        const d = Math.hypot(e.pos[0] - spec.pos[0], e.pos[1] - spec.pos[1]);
        if (d < bestD) { bestD = d; best = e.pos; }
      }
    }
    return best;
  }

  update(x: number, z: number, dt: number) {
    if (!this.data) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.7;

    const r2 = this.placeRadius * this.placeRadius;
    for (let i = 0; i < this.data.entrances.length; i++) {
      const e = this.data.entrances[i];
      const dx = e.pos[0] - x, dz = e.pos[1] - z;
      const inRange = dx * dx + dz * dz < r2;
      const existing = this.placed.get(i);
      if (inRange && !existing) {
        const station = this.stations.get(e.stationId);
        if (!station) continue;
        // elevated stations get the kiosk marker (their stairs go up, not down)
        const kind = /elev|viaduct/i.test(station.structure) ? 'elevator' : e.kind;
        // OSM maps many entrances at/inside building frontages — push the kit
        // out of any footprint so it lands visibly on the sidewalk
        let pos: [number, number] = [e.pos[0], e.pos[1]];
        if (this.eject) {
          let deferred = false;
          for (let k = 0; k < 4; k++) {
            const adj = this.eject(pos[0], pos[1]);
            if (adj === null) { deferred = true; break; } // tile not resident yet — retry next cycle
            pos = adj;
          }
          if (deferred) continue;
        }
        // OSM maps several entrances per corner; once ejected onto the
        // sidewalk they can converge. Two stairheads of the same station
        // within a few meters reads as a glitch — keep the first, skip the rest.
        let tooClose = false;
        for (const other of this.placed.values()) {
          if (other.spec.stationId !== e.stationId) continue;
          if (Math.hypot(other.pos[0] - pos[0], other.pos[1] - pos[1]) < 12) { tooClose = true; break; }
        }
        if (tooClose) continue;
        const group = mergeByMaterial(buildEntranceKit(station.routes, kind, station.name));
        // sink slightly so the flat base tucks into sloping sidewalks
        group.position.set(pos[0], heightAt(pos[0], pos[1]) - 0.12, pos[1]);
        // Orientation, the way real corner stairs sit: the stair run lies
        // ALONG the nearest building frontage, descending AWAY from the
        // station (you enter from the corner side). With no wall nearby
        // (plazas, parks) the stair simply descends away from the station.
        const away = Math.atan2(pos[0] - station.pos[0], pos[1] - station.pos[1]);
        const w = this.wallDir ? this.wallDir(pos[0], pos[1]) : null;
        if (w) {
          const a1 = Math.atan2(w[0], w[1]);
          const angDiff = (a: number) => Math.abs(Math.atan2(Math.sin(a - away), Math.cos(a - away)));
          group.rotation.y = angDiff(a1) <= angDiff(a1 + Math.PI) ? a1 : a1 + Math.PI;
        } else {
          group.rotation.y = away;
        }
        const beacon = makeBeacon();
        beacon.position.set(0, 3.1, 0);
        group.add(beacon);
        this.scene.add(group);
        this.placed.set(i, { spec: e, station, group, pos });
      } else if (!inRange && existing) {
        this.scene.remove(existing.group);
        disposeGroup(existing.group);
        this.placed.delete(i);
      }
    }
  }

  /** Nearest entrance within `dist` meters of (x,z), or null. */
  nearest(x: number, z: number, dist: number): PlacedEntrance | null {
    let best: PlacedEntrance | null = null;
    let bestD = dist * dist;
    for (const p of this.placed.values()) {
      const dx = p.pos[0] - x, dz = p.pos[1] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = p; }
    }
    return best;
  }

  destroy() {
    for (const p of this.placed.values()) {
      this.scene.remove(p.group);
      disposeGroup(p.group);
    }
    this.placed.clear();
  }
}

export function disposeGroup(g: THREE.Group) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (o.userData.shared) return;
      o.geometry.dispose();
      // materials are module-shared in streetprops except canvas sign textures
      if (o.userData.shared) return; // beacon shares module-level geo/material
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const std = m as THREE.MeshLambertMaterial;
        if (std.map && std.map instanceof THREE.CanvasTexture) { std.map.dispose(); m.dispose(); }
      }
    }
  });
}
