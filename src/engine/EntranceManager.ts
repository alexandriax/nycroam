import * as THREE from 'three';
import { dataUrl } from './dataver';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SubwayData, StationSpec, EntranceSpec } from './subway/types';
import { buildEntranceKit } from './streetprops';
import { heightAt } from './terrain';
import { canvas2d } from './canvas2d';
import { quality } from './quality';

/**
 * Collapse a prop group into one mesh per material (a kit is otherwise ~40
 * meshes — railing posts, steps, rails — which wrecks the draw-call budget).
 *
 * Shadow state is part of the batch key. Collapsing a shadow-casting mesh into
 * a new Mesh used to silently reset both flags to false; landmarks then looked
 * detached even on tiers that had paid for the shadow pass.
 */
export function mergeByMaterial(
  group: THREE.Group,
  defaults: { castShadow?: boolean; receiveShadow?: boolean } = {},
): THREE.Group {
  group.updateMatrixWorld(true);
  interface Batch {
    geos: THREE.BufferGeometry[];
    castShadow: boolean;
    receiveShadow: boolean;
  }
  const byMat = new Map<THREE.Material, Map<string, Batch>>();
  group.traverse((o) => {
    if (o instanceof THREE.Mesh && !Array.isArray(o.material)) {
      const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      const castShadow = o.castShadow || defaults.castShadow === true;
      const receiveShadow = o.receiveShadow || defaults.receiveShadow === true;
      const key = `${castShadow ? 1 : 0}:${receiveShadow ? 1 : 0}`;
      let batches = byMat.get(o.material);
      if (!batches) {
        batches = new Map();
        byMat.set(o.material, batches);
      }
      let batch = batches.get(key);
      if (!batch) {
        batch = { geos: [], castShadow, receiveShadow };
        batches.set(key, batch);
      }
      batch.geos.push(g);
    }
  });
  const out = new THREE.Group();
  out.name = group.name;
  for (const [mat, batches] of byMat) {
    for (const { geos, castShadow, receiveShadow } of batches.values()) {
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
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      out.add(mesh);
    }
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

    const { cv, ctx } = canvas2d(32, 128);
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
  // Successful sidewalk solves remain valid across stream-out/in cycles until
  // a late landmark changes the local collision field.
  private resolvedPos = new Map<number, [number, number]>();
  // OSM nodes that collapse onto an already-represented station corner should
  // not pay the footprint solver again on every idle pass.
  private suppressed = new Set<number>();
  // Manhattan has 835 entrance records but only a few dozen kind/route designs.
  // Share each design's merged geometry and sign material across scene clones.
  private templates = new Map<string, THREE.Group>();
  private pendingTemplates = new Set<string>();
  private destroyed = false;
  private placeRadius = 260;
  private timer = 0;
  private scanCursor = 0;
  private lastScanX = Infinity;
  private lastScanZ = Infinity;
  private readonly detailRadius: number;
  private eject: ((x: number, z: number) => [number, number] | null) | null;
  private wallDir: ((x: number, z: number) => [number, number] | null) | null;
  private compile: ((g: THREE.Object3D) => Promise<void>) | null;

  constructor(
    scene: THREE.Scene,
    eject: ((x: number, z: number) => [number, number] | null) | null = null,
    wallDir: ((x: number, z: number) => [number, number] | null) | null = null,
    compile: ((g: THREE.Object3D) => Promise<void>) | null = null,
  ) {
    this.wallDir = wallDir;
    this.scene = scene;
    this.eject = eject;
    this.compile = compile;
    const level = quality().level;
    this.detailRadius = level === 'ultra' ? 130 : level === 'high' ? 95 : level === 'medium' ? 78 : 64;
  }

  async init(): Promise<boolean> {
    try {
      const res = await fetch(dataUrl('/subway/subway.json'));
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

  private templateKey(routes: string[], kind: string): string {
    return `${kind}\u001f${routes.join('\u001f')}`;
  }

  private buildTemplate(key: string, routes: string[], kind: string, name: string): void {
    if (this.templates.has(key) || this.destroyed) return;
    const q = quality();
    const template = mergeByMaterial(buildEntranceKit(routes, kind, name), {
      // Entrances are repeated, material-rich street props. They receive the
      // nearby building/hero map; submitting every railing/sign material as
      // a caster scales with station density and adds no readable silhouette.
      castShadow: false,
      receiveShadow: q.shadows,
    });
    // Cloned Mesh objects retain these geometry/material references. Mark
    // them so stream-out disposal leaves the owning template intact.
    template.traverse((o) => {
      if (o instanceof THREE.Mesh) o.userData.shared = true;
    });
    this.templates.set(key, template);
  }

  /**
   * Prepare a new route/kind kit between frames. Dense transfers introduce
   * several unique sign combinations at once; merging them synchronously in
   * the stream update stacked 20–30ms long tasks onto otherwise fast frames.
   */
  private prepareTemplate(key: string, routes: string[], kind: string, name: string): void {
    if (this.templates.has(key) || this.pendingTemplates.has(key)) return;
    this.pendingTemplates.add(key);
    const build = () => {
      this.pendingTemplates.delete(key);
      this.buildTemplate(key, routes, kind, name);
      if (!this.destroyed) this.timer = Math.min(this.timer, 0.05);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(build, { timeout: 500 });
    else window.setTimeout(build, 0);
  }

  /** A lightweight scene clone backed by one merged geometry set per design. */
  private entranceGroup(routes: string[], kind: string, name: string): THREE.Group {
    const key = this.templateKey(routes, kind);
    let template = this.templates.get(key);
    if (!template) {
      this.buildTemplate(key, routes, kind, name);
      template = this.templates.get(key)!;
    }
    const group = template.clone(true);
    group.name = name;
    return group;
  }

  update(x: number, z: number, dt: number) {
    if (!this.data) return;
    this.timer -= dt;
    // Idle scans normally run at 0.7 Hz, but large teleports and high-speed
    // flight must refresh immediately instead of trailing the player.
    const movedSq = (x - this.lastScanX) ** 2 + (z - this.lastScanZ) ** 2;
    if (this.timer > 0 && movedSq < 64 * 64) return;
    this.lastScanX = x;
    this.lastScanZ = z;

    const entrances = this.data.entrances;
    const r2 = this.placeRadius * this.placeRadius;

    // Dispose every out-of-range kit in one cheap pass. Placement is separate:
    // one expensive footprint attempt per frame, successful or not. Previously
    // only successful builds consumed the budget, so a single idle pass could
    // run the solver for 19 deferred/duplicate records and block 75–150 ms.
    for (let i = 0; i < entrances.length; i++) {
      const existing = this.placed.get(i);
      if (!existing) continue;
      const e = entrances[i];
      const dx = e.pos[0] - x, dz = e.pos[1] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2) {
        this.scene.remove(existing.group);
        disposeGroup(existing.group);
        this.placed.delete(i);
      } else {
        // From down the block the beacon is the readable entrance signal; ten
        // railing/stair/sign material batches occupy only a handful of pixels.
        // Preserve the complete interactive kit inside the tiered near radius.
        const detailed = d2 <= this.detailRadius * this.detailRadius;
        for (const child of existing.group.children) {
          child.visible = detailed || child.userData.entranceBeacon === true;
        }
      }
    }

    let attempted = false;
    let deferred = false;
    const count = entrances.length;
    for (let offset = 0; offset < count; offset++) {
      const i = (this.scanCursor + offset) % count;
      if (this.placed.has(i) || this.suppressed.has(i)) continue;
      const e = entrances[i];
      const dx = e.pos[0] - x, dz = e.pos[1] - z;
      if (dx * dx + dz * dz >= r2) continue;

      // Advance even when the tile is not ready so one deferred record cannot
      // starve the rest of the neighborhood.
      this.scanCursor = (i + 1) % count;
      attempted = true;
      const station = this.stations.get(e.stationId);
      if (!station) {
        this.suppressed.add(i);
        break;
      }

      // Elevated stations get the kiosk marker (their stairs go up, not down).
      const kind = /elev|viaduct/i.test(station.structure) ? 'elevator' : e.kind;
      const templateKey = this.templateKey(station.routes, kind);
      if (!this.templates.has(templateKey)) {
        this.prepareTemplate(templateKey, station.routes, kind, station.name);
        deferred = true;
        break;
      }
      // resolveFootprint already performs a full joint road/building fixpoint,
      // spiral fallback, and final lane-clear validation. Calling it four times
      // multiplied its most expensive work without changing the result.
      let pos = this.resolvedPos.get(i);
      if (!pos) {
        pos = [e.pos[0], e.pos[1]];
        if (this.eject) {
          const adjusted = this.eject(pos[0], pos[1]);
          if (adjusted === null) {
            deferred = true; // tile not resident yet — rotate and retry soon
            break;
          }
          pos = adjusted;
        }
        this.resolvedPos.set(i, pos);
      }

      // OSM maps several entrances per corner; once ejected onto the sidewalk
      // they can converge. Keep the first and remember rejected siblings so an
      // idle scan never pays the footprint solver for them again.
      let tooClose = false;
      for (const other of this.placed.values()) {
        if (other.spec.stationId !== e.stationId) continue;
        if (Math.hypot(other.pos[0] - pos[0], other.pos[1] - pos[1]) < 12) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) {
        this.suppressed.add(i);
        break;
      }

      const group = this.entranceGroup(station.routes, kind, station.name);
      // Sink slightly so the flat base tucks into sloping sidewalks.
      group.position.set(pos[0], heightAt(pos[0], pos[1]) - 0.12, pos[1]);
      // Real corner stairs lie along the building frontage and descend away
      // from the station; plazas without a nearby wall use the away bearing.
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
      beacon.userData.entranceBeacon = true;
      group.add(beacon);
      // Claim the slot synchronously, then reveal only after shader pre-warm.
      // If eviction wins the race, the record identity check prevents a stale
      // compiled group from returning to the scene.
      const rec: PlacedEntrance = { spec: e, station, group, pos };
      this.placed.set(i, rec);
      if (this.compile) {
        void this.compile(group).then(() => {
          if (this.placed.get(i) === rec) this.scene.add(group);
        });
      } else {
        this.scene.add(group);
      }
      break;
    }

    // A deferred tile gets a short breather; a completed/suppressed attempt
    // yields just this frame. With no backlog, return to the low-cost idle scan.
    this.timer = attempted ? (deferred ? 0.05 : 0) : 0.7;
  }

  /**
   * Evict placed entrance kits inside a world-space box (padded by the caller).
   * Used when a premium landmark finishes building over an already-placed kit:
   * the next update() re-places it, and the eject callback now sees the
   * landmark's collision, so the kit re-seats outside its walls.
   */
  evictWithin(x0: number, z0: number, x1: number, z1: number) {
    let evicted = false;
    for (const [i, p] of [...this.placed]) {
      if (p.pos[0] < x0 || p.pos[0] > x1 || p.pos[1] < z0 || p.pos[1] > z1) continue;
      this.scene.remove(p.group);
      disposeGroup(p.group);
      this.placed.delete(i);
      // A late landmark changes the collision field, so the cached sidewalk
      // seat must be solved again before this entrance returns.
      this.resolvedPos.delete(i);
      this.scanCursor = i;
      // The canonical entrance may move to a different side of the new
      // landmark. Let same-station siblings compete again under that new
      // collision field instead of preserving a now-stale duplicate decision.
      if (this.data) {
        for (const j of [...this.suppressed]) {
          if (this.data.entrances[j]?.stationId !== p.spec.stationId) continue;
          this.suppressed.delete(j);
          this.resolvedPos.delete(j);
        }
      }
      evicted = true;
    }
    // Only force a re-place scan if we actually removed something — every landmark
    // build calls this, and zeroing the timer each time otherwise churned the
    // stream loop into running every frame for no reason.
    if (evicted) this.timer = 0;
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
    this.destroyed = true;
    for (const p of this.placed.values()) {
      this.scene.remove(p.group);
      disposeGroup(p.group);
    }
    this.placed.clear();
    this.resolvedPos.clear();
    this.suppressed.clear();
    // Placed clones deliberately do not own these shared resources; dispose
    // each template once when the manager itself is destroyed.
    for (const template of this.templates.values()) {
      template.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          const std = m as THREE.MeshLambertMaterial;
          if (std.map instanceof THREE.CanvasTexture) {
            std.map.dispose();
            m.dispose();
          }
        }
      });
    }
    this.templates.clear();
    this.pendingTemplates.clear();
  }
}

export function disposeGroup(g: THREE.Group) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (o.userData.shared) {
        // Shares module-level geometry/material (the beacon, a rack's docked
        // bikes). Its own per-instance buffer is still ours to free.
        if (o instanceof THREE.InstancedMesh) o.dispose();
        return;
      }
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
