import * as THREE from 'three';
import { mergeByMaterial } from '../EntranceManager';
import { makeSubwayWallTexture, makeTerrazzoTexture } from '../textures';
import { makeTactileMaterial } from '../transitMaterials';
import { makeNameMosaicTexture, makeColumnSignTexture } from './signage';
import type { RideStationLayout } from './rideLayout';
import { TransitPassengerBatch, passengerSeed, passengerRandom } from './transitPassengers';
import { quality } from '../quality';

interface StationStage {
  layout: RideStationLayout;
  children: THREE.Object3D[];
  resources: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>;
  crowd?: TransitPassengerBatch;
}

/** A real-width platform cross section, viewed from the selected train track.
 * Architecture is one batch per material. Tunnel clipping follows its complete
 * longitudinal footprint, so the arriving platform is never behind tunnel walls. */
export class RideScenery {
  readonly station = new THREE.Group();
  private tunnel = new THREE.Group();
  private resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  private stationResources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  private aperture = { value: new THREE.Vector2(1e6, 1e6) };
  private scroll: { mesh: THREE.InstancedMesh; homes: number[]; span: number }[] = [];
  private layout?: RideStationLayout;
  private crowd?: TransitPassengerBatch;
  private prepared?: StationStage;
  private crowdTime = 0;
  private floor: THREE.Mesh;
  private sky = new THREE.Color('#718994');
  private darkness = new THREE.Color('#101316');
  private scene: THREE.Scene;
  private offset = 0;
  private matrix = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.station.name = 'ride-station-cross-section';
    scene.add(this.station, this.tunnel);
    const bed = this.own(new THREE.MeshStandardMaterial({ color: '#1e201f', roughness: 1 }));
    this.floor = this.box(650, .28, 50, bed, 0, -1.48, 0, this.tunnel);
    const wall = this.clipped(this.own(new THREE.MeshStandardMaterial({ color: '#25292b', roughness: .96 })));
    const metal = this.clipped(this.own(new THREE.MeshStandardMaterial({ color: '#3d4448', metalness: .52, roughness: .54 })));
    const lamp = this.clipped(this.own(new THREE.MeshBasicMaterial({ color: '#b7c9c8' })));
    const conduit = this.clipped(this.own(new THREE.MeshStandardMaterial({ color: '#555752', metalness: .35, roughness: .7 })));
    // Jointed tunnel lining: cross-track depth, sparse utility fixtures, subtle
    // wall panel breaks, and actual rail-height sleepers replace luminous streaks.
    for (const side of [-1, 1]) {
      this.box(650, 5.4, .25, wall, 0, 1.1, side * 3.25, this.tunnel);
      this.box(650, .05, .07, conduit, 0, .42, side * 3.08, this.tunnel);
      this.box(650, .05, .07, conduit, 0, .57, side * 3.08, this.tunnel);
      this.box(650, .11, .1, conduit, 0, 2.37, side * 3.09, this.tunnel);
    }
    const modules: [THREE.Material, THREE.Group, number][] = [[metal, new THREE.Group(), 4.4], [lamp, new THREE.Group(), 13.2], [conduit, new THREE.Group(), 4.4]];
    for (const side of [-1, 1]) {
      this.box(.10, 3.4, .12, metal, 0, .7, side * 2.75, modules[0][1]);
      this.box(.23, .14, .36, metal, 0, 2.37, side * 2.87, modules[0][1]);
      this.box(.46, .18, .065, lamp, 0, 1.76, side * 3.05, modules[1][1]);
      this.box(.64, .29, .11, conduit, 0, 1.76, side * 3.12, modules[2][1]);
      this.box(.07, 2.9, .04, conduit, .3, .66, side * 3.09, modules[2][1]);
    }
    for (const [mat, group, pitch] of modules) {
      const merged = mergeByMaterial(group), geo = (merged.children[0] as THREE.Mesh).geometry;
      this.resources.add(geo);
      const count = Math.ceil(220 / pitch), mesh = new THREE.InstancedMesh(geo, mat, count), homes = [];
      mesh.frustumCulled = false;
      for (let i = 0; i < count; i++) { const x = -110 + i * pitch; homes.push(x); mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, 0)); }
      this.scroll.push({ mesh, homes, span: count * pitch }); this.tunnel.add(mesh);
    }
  }
  private own<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(resource: T, station = false): T {
    (station ? this.stationResources : this.resources).add(resource); return resource;
  }
  private box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }
  private clipped<T extends THREE.MeshStandardMaterial | THREE.MeshBasicMaterial>(material: T): T {
    material.onBeforeCompile = shader => {
      shader.uniforms.rideAperture = this.aperture;
      shader.vertexShader = 'varying float vRideTunnelX;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
        vec4 tunnelPoint=vec4(transformed,1.0);
        #ifdef USE_INSTANCING
          tunnelPoint=instanceMatrix*tunnelPoint;
        #endif
        vRideTunnelX=(modelMatrix*tunnelPoint).x;
        #include <project_vertex>`);
      shader.fragmentShader = 'uniform vec2 rideAperture; varying float vRideTunnelX;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
        #include <clipping_planes_fragment>
        if(vRideTunnelX>rideAperture.x && vRideTunnelX<rideAperture.y) discard;`);
    };
    material.customProgramCacheKey = () => `ride-tunnel-station-aperture-v1`; return material;
  }
  setStation(layout: RideStationLayout): void {
    if (this.layout?.stationId === layout.stationId && this.layout.platformSide === layout.platformSide) return;
    if (this.prepared?.layout.stationId === layout.stationId && this.prepared.layout.platformSide === layout.platformSide) {
      const previous = this.captureStation();
      this.restoreStation(this.prepared); this.prepared = previous; return;
    }
    this.clearStation(); this.layout = layout;
    const { length: L, platforms, walls, tracks } = layout;
    const g = new THREE.Group();
    const contacts: { x: number; z: number; w: number; d: number }[] = [];
    const tileKit = makeSubwayWallTexture(layout.bandColor);
    const tile = this.own(tileKit.map.clone(), true), normal = this.own(tileKit.normal.clone(), true);
    tile.repeat.set(Math.ceil(L / 7), 1); normal.repeat.copy(tile.repeat);
    const wall = this.own(new THREE.MeshStandardMaterial({ map: tile, normalMap: normal, roughness: .4, metalness: .03 }), true);
    const floorKit = makeTerrazzoTexture();
    const floorMap = this.own(floorKit.map.clone(), true), floorNormal = this.own(floorKit.normal.clone(), true);
    floorMap.repeat.set(L / 4, 1.3); floorNormal.repeat.copy(floorMap.repeat);
    const floor = this.own(new THREE.MeshStandardMaterial({ map: floorMap, normalMap: floorNormal, roughness: .77 }), true);
    const edge = this.own(makeTactileMaterial(), true);
    const ceiling = this.own(new THREE.MeshStandardMaterial({ color: '#b8b6ae', roughness: .85 }), true);
    const steel = this.own(new THREE.MeshStandardMaterial({ color: layout.elevated ? '#76847b' : '#365c55', roughness: .65, metalness: .35 }), true);
    const dark = this.own(new THREE.MeshStandardMaterial({ color: '#333a3a', roughness: .77 }), true);
    const rail = this.own(new THREE.MeshStandardMaterial({ color: '#7a8184', roughness: .37, metalness: .78 }), true);
    const glow = this.own(new THREE.MeshBasicMaterial({ color: '#fff6da' }), true);
    const bench = this.own(new THREE.MeshStandardMaterial({ color: '#73563b', roughness: .68 }), true);
    if (!layout.elevated) {
      for (const z of walls) this.box(L, 3.6, .18, wall, 0, 1.8, z, g);
      this.box(L, .15, walls[1] - walls[0], ceiling, 0, 3.68, (walls[0] + walls[1]) / 2, g);
    }
    for (const z of tracks) {
      this.box(L, .25, 4.15, dark, 0, -1.57, z, g);
      for (const rz of [-.72, .72]) this.box(L, .16, .12, rail, 0, -1.2, z + rz, g);
      this.box(L, .10, .25, dark, 0, -.95, z + 1.35, g);
      // Batched sleepers preserve depth when looking down toward the opposite track.
      for (let x = -L / 2 + .7; x < L / 2; x += 1.3)this.box(.22, .14, 2.6, bench, x, -1.42, z, g);
    }
    const mosaic = makeNameMosaicTexture(layout.name, layout.bandColor);
    this.own(mosaic.texture, true);
    const mosaicMat = this.own(new THREE.MeshStandardMaterial({ map: mosaic.texture, roughness: .56 }), true);
    const columnTexture = makeColumnSignTexture(layout.name);
    this.own(columnTexture.texture, true);
    const sign = this.own(new THREE.MeshBasicMaterial({ map: columnTexture.texture }), true);
    for (const p of platforms) {
      const width = p.zMax - p.zMin, center = (p.zMin + p.zMax) / 2;
      const slabDepth = layout.elevated ? .7 : 1.5;
      this.box(L, slabDepth, width, floor, 0, -slabDepth / 2, center, g);
      const edges = [p.zMin, p.zMax].filter(z => tracks.some(t => Math.abs(t - z) < 2.3));
      for (const z of edges) this.box(L, .035, .61, edge, 0, .018, z + (z < center ? .305 : -.305), g);
      if (layout.elevated) {
        this.box(L * .93, .17, width + .5, steel, 0, 3.2, center, g);
        for (const z of [p.zMin, p.zMax].filter(z => !edges.includes(z))) {
          this.box(L, 1.2, .08, steel, 0, .6, z, g);
          this.box(L, .7, .025, dark, 0, .45, z, g);
        }
      }
      for (let x = -L / 2 + 5; x < L / 2 - 3; x += 5.2) {
        for (const z of [center]) {
          this.box(.15, 3.5, .15, steel, x, 1.75, z, g);
          for (const dz of [-.14, .14]) this.box(.31, 3.5, .06, steel, x, 1.75, z + dz, g);
          this.box(.47, .12, .47, dark, x, .06, z, g);
          contacts.push({ x, z, w: 1.2, d: 1.1 });
          for (const side of [-1, 1]) {
            const plaque = new THREE.Mesh(new THREE.PlaneGeometry(.43, .72), sign);
            plaque.position.set(x, 1.62, z + side * .179); if (side === -1) plaque.rotation.y = Math.PI; g.add(plaque);
          }
        }
        this.box(2.4, .13, .29, dark, x, 3.15, center, g);
        this.box(2.2, .032, .23, glow, x, 3.068, center, g);
        this.box(.24, .24, width + .2, steel, x, 3.43, center, g);
      }
      for (let x = -L / 2 + 17; x < L / 2 - 8; x += 27) {
        this.box(2.45, .11, .54, bench, x, .49, center + .65, g);
        contacts.push({ x, z: center + .65, w: 3.0, d: 1.4 });
        this.box(2.45, .48, .10, bench, x, .77, center + .89, g);
        for (const dx of [-.87, .87]) this.box(.13, .48, .46, dark, x + dx, .24, center + .65, g);
        this.box(.56, .87, .56, dark, x + 2.2, .435, center + .66, g);
      }
      // Side-platform mosaics sit on the real outside wall; islands have no
      // invented tiled wall blocking the view across their second track.
      const outerWall = walls.find(z => Math.abs(z - center) < width / 2 + 1);
      if (outerWall !== undefined && !layout.elevated) for (let x = -L / 2 + 12; x < L / 2; x += 21) {
        const tablet = new THREE.Mesh(new THREE.PlaneGeometry(.65 * mosaic.aspect, .65), mosaicMat);
        const toward = outerWall < center ? 1 : -1; tablet.position.set(x, 1.85, outerWall + toward * .115);
        if (toward === -1) tablet.rotation.y = Math.PI; g.add(tablet);
      }
    }
    const batch = mergeByMaterial(g); batch.name = `ride-platform:${layout.stationId}`;
    this.station.add(batch);
    this.station.traverse(o => { if (o instanceof THREE.Mesh) this.stationResources.add(o.geometry); });
    const count = quality().level === 'low' ? 16 : 24, rng = passengerRandom(passengerSeed(layout.stationId));
    this.crowd = new TransitPassengerBatch(this.station, count, passengerSeed(layout.stationId));
    for (let i = 0; i < count; i++) {
      const p = platforms[i % platforms.length], center = (p.zMin + p.zMax) / 2;
      const x = (rng() - .5) * Math.min(L - 12, 100), z = center + (rng() - .5) * (p.zMax - p.zMin - 1.8);
      this.crowd.set(i, { x, y: 0, z, yaw: (rng() - .5) * Math.PI * 2 });
      contacts.push({ x, z, w: .65, d: .55 });
    }
    this.crowd.commit(count);
    const shadowGeometry = this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), true);
    const shadowMaterial = this.own(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: `varying vec2 shadowUV;
        void main(){shadowUV=uv;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
      fragmentShader: `varying vec2 shadowUV;
        void main(){vec2 p=(shadowUV-.5)*2.;float a=smoothstep(1.,.08,dot(p,p))*.22;gl_FragColor=vec4(.025,.028,.024,a);}`,
    }), true);
    const shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, contacts.length);
    shadows.name = 'ride-platform-contact-shadows'; shadows.renderOrder = 1;
    const q = new THREE.Quaternion(), m = new THREE.Matrix4();
    contacts.forEach((p, i) => shadows.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, .038, p.z), q, new THREE.Vector3(p.w, 1, p.d))));
    shadows.computeBoundingSphere(); this.station.add(shadows);
  }
  /** Build at most one upcoming station while stopped. No canvas painting,
   * geometry merging or passenger allocation happens during the moving leg. */
  prepareStation(layout: RideStationLayout): void {
    if (this.layout?.stationId === layout.stationId || this.prepared?.layout.stationId === layout.stationId) return;
    if (this.prepared) this.disposeStage(this.prepared);
    this.prepared = undefined;
    const active = this.captureStation();
    this.station.clear(); this.stationResources = new Set(); this.crowd = undefined; this.layout = undefined;
    this.setStation(layout);
    const prepared = this.captureStation();
    if (active) this.restoreStation(active);
    this.prepared = prepared;
  }
  private captureStation(): StationStage | undefined {
    return this.layout ? { layout: this.layout, children: [...this.station.children], resources: this.stationResources, crowd: this.crowd } : undefined;
  }
  private restoreStation(stage: StationStage): void {
    this.station.clear(); this.layout = stage.layout; this.stationResources = stage.resources; this.crowd = stage.crowd;
    for (const child of stage.children) this.station.add(child);
  }
  private disposeStage(stage: StationStage): void {
    for (const child of stage.children) child.traverse(o => { if (o instanceof THREE.InstancedMesh && o.name === 'ride-platform-contact-shadows') o.dispose(); });
    stage.crowd?.dispose(); for (const resource of stage.resources) resource.dispose();
}

  update(scrollOffset: number, stationX: number, visible: boolean): void {
    this.offset = stationX; this.station.position.x = stationX; this.station.visible = visible;
    const half = (this.layout?.length ?? 0) / 2;
    this.aperture.value.set(visible ? stationX - half : 1e6, visible ? stationX + half : 1e6);
    const openAir = this.layout?.elevated ?? false;
    this.tunnel.visible = !openAir;
    this.scene.background = openAir ? this.sky : this.darkness;
    for (const { mesh, homes, span } of this.scroll) {
      for (let i = 0; i < homes.length; i++) {
        const x = ((homes[i] - scrollOffset + span / 2) % span + span) % span - span / 2;
        this.matrix.makeTranslation(x, 0, 0); mesh.setMatrixAt(i, this.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  animate(dt: number): void { this.crowdTime += dt; this.crowd?.update(this.crowdTime); }
  get platformInterval(): readonly [number, number] { const h = (this.layout?.length ?? 0) / 2; return [this.offset - h, this.offset + h]; }
  private clearStation(): void { this.station.traverse(o => { if (o instanceof THREE.InstancedMesh && o.name === 'ride-platform-contact-shadows') o.dispose(); }); this.crowd?.dispose(); this.crowd = undefined; this.station.clear(); for (const resource of this.stationResources) resource.dispose(); this.stationResources.clear(); }
  dispose(): void {
    this.clearStation(); if (this.prepared) this.disposeStage(this.prepared); this.prepared = undefined; this.station.removeFromParent();
    this.tunnel.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); if (o instanceof THREE.InstancedMesh) o.dispose(); } });
    this.tunnel.removeFromParent(); for (const resource of this.resources) resource.dispose(); this.resources.clear();
  }
}
