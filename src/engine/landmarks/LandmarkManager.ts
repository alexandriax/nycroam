import * as THREE from 'three';
import { LANDMARKS_PLACED, type Landmark } from './registry';
import { mergeByMaterial, disposeGroup } from '../EntranceManager';
import { heightAt } from '../terrain';
import type { LandmarkCtx } from './kit';

type BuilderMap = Record<string, (ctx: LandmarkCtx) => THREE.Group>;

interface Fit {
  cx: number; cz: number; rot: number;
  w: number; d: number; roofH: number; keptH: number; topW: number; topD: number;
}

/**
 * Streams premium landmark detail by proximity. Each themed set module
 * (./sets/<name>.ts) is a separate webpack chunk, dynamic-imported the first
 * time the player nears one of its landmarks; the built groups are merged
 * per material and disposed once the player leaves (activation radius +
 * 150m hysteresis). Distant districts therefore cost nothing — no bytes,
 * no triangles — and a landmark's cost while inactive is one distance check
 * per second.
 */
export class LandmarkManager {
  private scene: THREE.Scene;
  private placed = new Map<string, THREE.Group>();
  private building = new Set<string>();
  private sets = new Map<string, Promise<BuilderMap | null>>();
  private timer = 0;
  private initialPlaced = false;
  private fits: Record<string, Fit> | null = null;
  private fitsLoading: Promise<void> | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  private loadSet(name: string): Promise<BuilderMap | null> {
    let p = this.sets.get(name);
    if (!p) {
      p = import(`./sets/${name}`).then(
        (m: { builders: BuilderMap }) => m.builders,
        () => null, // a broken/missing set disables its landmarks, not the world
      );
      this.sets.set(name, p);
    }
    return p;
  }

  private loadFits(): Promise<void> {
    if (!this.fitsLoading) {
      this.fitsLoading = fetch('/geo/landmarks-fit.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { this.fits = j?.fits ?? {}; })
        .catch(() => { this.fits = {}; });
    }
    return this.fitsLoading;
  }

  private async build(lm: Landmark) {
    if (this.building.has(lm.id) || this.placed.has(lm.id)) return;
    this.building.add(lm.id);
    try {
      await this.loadFits();
      const builders = await this.loadSet(lm.set);
      const make = builders?.[lm.id];
      if (!make) return;
      // building-attached landmarks snap to the measured host massing: its
      // oriented-bbox center and edge rotation beat any hand-typed anchor
      const fit = this.fits?.[lm.id];
      const px = fit ? fit.cx : lm.x;
      const pz = fit ? fit.cz : lm.z;
      const rot = fit ? fit.rot : (lm.rot ?? 0);
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const ctx: LandmarkCtx = {
        // local offset -> world, so builders can terrace onto real terrain
        groundAt: (dx, dz) => heightAt(px + dx * cos + dz * sin, pz - dx * sin + dz * cos),
        fit: fit ? { w: fit.w, d: fit.d, roofH: fit.roofH, keptH: fit.keptH, topW: fit.topW, topD: fit.topD } : undefined,
      };
      const group = mergeByMaterial(make(ctx));
      group.position.set(px, heightAt(px, pz), pz);
      group.rotation.y = rot;
      this.scene.add(group);
      this.placed.set(lm.id, group);
    } catch {
      /* a single failed landmark must never take the frame loop down */
    } finally {
      this.building.delete(lm.id);
    }
  }

  update(x: number, z: number, dt: number) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1.0;

    if (!this.initialPlaced) {
      this.initialPlaced = true;
      for (const lm of LANDMARKS_PLACED) if (lm.alwaysOn) void this.build(lm);
    }

    let started = 0;
    for (const lm of LANDMARKS_PLACED) {
      if (lm.alwaysOn) continue;
      const dx = lm.x - x, dz = lm.z - z;
      const d2 = dx * dx + dz * dz;
      const has = this.placed.has(lm.id);
      if (!has && d2 < lm.r * lm.r) {
        // stagger builds so approaching a dense district doesn't hitch a frame
        if (started < 2 && !this.building.has(lm.id)) {
          started++;
          void this.build(lm);
        }
      } else if (has && d2 > (lm.r + 150) * (lm.r + 150)) {
        const g = this.placed.get(lm.id)!;
        this.scene.remove(g);
        disposeGroup(g);
        this.placed.delete(lm.id);
      }
    }
  }

  /** Active landmark count (debug/stats). */
  get activeCount() { return this.placed.size; }

  destroy() {
    for (const g of this.placed.values()) {
      this.scene.remove(g);
      disposeGroup(g);
    }
    this.placed.clear();
  }
}
