import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SubwayData, StationSpec, EntranceSpec } from './subway/types';
import { buildEntranceKit } from './streetprops';
import { hash01 } from './palette';
import { heightAt } from './terrain';

/**
 * Collapse a prop group into one mesh per material (a kit is otherwise ~40
 * meshes — railing posts, steps, rails — which wrecks the draw-call budget).
 */
function mergeByMaterial(group: THREE.Group): THREE.Group {
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

  constructor(scene: THREE.Scene) {
    this.scene = scene;
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
        const group = mergeByMaterial(buildEntranceKit(station.routes, kind, station.name));
        group.position.set(e.pos[0], heightAt(e.pos[0], e.pos[1]) + 0.02, e.pos[1]);
        group.rotation.y = Math.floor(hash01(i * 31 + 7) * 4) * (Math.PI / 2);
        this.scene.add(group);
        this.placed.set(i, { spec: e, station, group });
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
      const dx = p.spec.pos[0] - x, dz = p.spec.pos[1] - z;
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

function disposeGroup(g: THREE.Group) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      // materials are module-shared in streetprops except canvas sign textures
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const std = m as THREE.MeshLambertMaterial;
        if (std.map && std.map instanceof THREE.CanvasTexture) { std.map.dispose(); m.dispose(); }
      }
    }
  });
}
