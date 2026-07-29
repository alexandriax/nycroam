import * as THREE from 'three';
import type { RoadPaths } from './tileTypes';
import { PATH_KIND_ROAD } from './tileTypes';
import { heightAt } from './terrain';
import type { QualityLevel } from './quality';

interface CarPlacement {
  x: number;
  z: number;
  yaw: number;
  color: THREE.Color;
  moving?: {
    x: number;
    z: number;
    dx: number;
    dz: number;
    length: number;
    offset: number;
    speed: number;
    phase: number;
    reverse: boolean;
  };
}

interface LampPlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface SignalPlacement extends LampPlacement {}

const CAR_COLORS = [
  0x17191d, 0x30353b, 0x5c6167, 0xb7b8b5, 0xe4e1d8,
  0x233a50, 0x4e1820, 0x4d5540, 0xb9974f, 0xf1eee5,
];

const LIMITS: Record<
  QualityLevel,
  { parked: number; moving: number; lamps: number; signals: number; radius: number }
> = {
  low: { parked: 28, moving: 5, lamps: 22, signals: 10, radius: 145 },
  medium: { parked: 64, moving: 10, lamps: 42, signals: 18, radius: 190 },
  high: { parked: 105, moving: 18, lamps: 68, signals: 28, radius: 235 },
  ultra: { parked: 150, moving: 26, lamps: 92, signals: 38, radius: 275 },
};

function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function segmentSeed(x: number, z: number, i: number): number {
  return Math.round(x * 0.31) * 73856093 ^ Math.round(z * 0.31) * 19349663 ^ i * 83492791;
}

/**
 * A deliberately tiny street-life layer: parked cars, sparse moving traffic,
 * and cobra-head lamps are pooled into six instanced draws. Placements are
 * regenerated only after a meaningful camera move or as nearby tiles arrive.
 */
export class StreetLife {
  private readonly group = new THREE.Group();
  private readonly limits: (typeof LIMITS)[QualityLevel];
  private readonly body: THREE.InstancedMesh;
  private readonly cabin: THREE.InstancedMesh;
  private readonly wheels: THREE.InstancedMesh;
  private readonly lampPoles: THREE.InstancedMesh;
  private readonly lampArms: THREE.InstancedMesh;
  private readonly lampHeads: THREE.InstancedMesh;
  private readonly signalPoles: THREE.InstancedMesh;
  private readonly signalHeads: THREE.InstancedMesh;
  private readonly signalLights: THREE.InstancedMesh;
  private readonly cars: CarPlacement[] = [];
  private readonly lamps: LampPlacement[] = [];
  private readonly signals: SignalPlacement[] = [];
  private lastBuildX = Number.NaN;
  private lastBuildZ = Number.NaN;
  private lastBuildAt = -Infinity;
  private populationScale = 1;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly yawQ = new THREE.Quaternion();
  private readonly wheelQ = new THREE.Quaternion();
  private readonly cabinColor = new THREE.Color();
  private readonly glassTint = new THREE.Color(0x78909a);
  private readonly wheelTurn = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 2,
  );

  constructor(scene: THREE.Scene, level: QualityLevel) {
    this.limits = LIMITS[level];

    const bodyGeo = new THREE.BoxGeometry(4.25, 0.62, 1.78);
    bodyGeo.translate(0, 0.5, 0);
    const cabinGeo = new THREE.BoxGeometry(2.25, 0.58, 1.52);
    cabinGeo.translate(-0.15, 1.06, 0);
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.22, 10);
    const poleGeo = new THREE.CylinderGeometry(0.055, 0.095, 7.1, 7);
    poleGeo.translate(0, 3.55, 0);
    const armGeo = new THREE.BoxGeometry(2.15, 0.075, 0.075);
    armGeo.translate(1.02, 6.98, 0);
    const headGeo = new THREE.BoxGeometry(0.72, 0.18, 0.34);
    headGeo.translate(2.05, 6.82, 0);
    const signalPoleGeo = new THREE.CylinderGeometry(0.045, 0.065, 4.3, 7);
    signalPoleGeo.translate(0, 2.15, 0);
    const signalHeadGeo = new THREE.BoxGeometry(0.34, 0.88, 0.34);
    signalHeadGeo.translate(0.24, 4.05, 0);
    const signalLightGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.035, 10);
    signalLightGeo.rotateX(Math.PI / 2);
    signalLightGeo.translate(0.24, 3.81, 0.19);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.48,
      metalness: 0.08,
    });
    const cabinMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      metalness: 0,
    });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.88 });
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x3f382b,
      roughness: 0.72,
      metalness: 0.38,
    });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x4a4438,
      roughness: 0.64,
      metalness: 0.3,
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffe6ad,
      emissive: 0xffd78b,
      emissiveIntensity: 0.22,
      roughness: 0.4,
    });
    const signalPoleMat = new THREE.MeshStandardMaterial({
      color: 0x5a5732,
      roughness: 0.72,
      metalness: 0.3,
    });
    const signalHeadMat = new THREE.MeshStandardMaterial({ color: 0x171916, roughness: 0.66 });
    const signalLightMat = new THREE.MeshStandardMaterial({
      color: 0x2bff58,
      emissive: 0x18d943,
      emissiveIntensity: 0.8,
      roughness: 0.32,
    });

    const carCapacity = this.limits.parked + this.limits.moving;
    this.body = new THREE.InstancedMesh(bodyGeo, bodyMat, carCapacity);
    this.cabin = new THREE.InstancedMesh(cabinGeo, cabinMat, carCapacity);
    this.wheels = new THREE.InstancedMesh(wheelGeo, tyreMat, carCapacity * 4);
    this.lampPoles = new THREE.InstancedMesh(poleGeo, poleMat, this.limits.lamps);
    this.lampArms = new THREE.InstancedMesh(armGeo, lampMat, this.limits.lamps);
    this.lampHeads = new THREE.InstancedMesh(headGeo, headMat, this.limits.lamps);
    this.signalPoles = new THREE.InstancedMesh(signalPoleGeo, signalPoleMat, this.limits.signals);
    this.signalHeads = new THREE.InstancedMesh(signalHeadGeo, signalHeadMat, this.limits.signals);
    this.signalLights = new THREE.InstancedMesh(signalLightGeo, signalLightMat, this.limits.signals);

    for (const mesh of [this.body, this.cabin, this.wheels]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    }
    for (const mesh of [
      this.lampPoles,
      this.lampArms,
      this.lampHeads,
      this.signalPoles,
      this.signalHeads,
      this.signalLights,
    ]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
    }
    this.body.castShadow = level === 'high' || level === 'ultra';
    this.cabin.castShadow = level === 'ultra';
    this.lampPoles.castShadow = level === 'ultra';
    this.body.count = this.cabin.count = this.wheels.count = 0;
    this.lampPoles.count = this.lampArms.count = this.lampHeads.count = 0;
    this.signalPoles.count = this.signalHeads.count = this.signalLights.count = 0;
    this.group.name = 'Street life (instanced)';
    this.group.add(
      this.body,
      this.cabin,
      this.wheels,
      this.lampPoles,
      this.lampArms,
      this.lampHeads,
      this.signalPoles,
      this.signalHeads,
      this.signalLights,
    );
    scene.add(this.group);
  }

  update(
    camX: number,
    camZ: number,
    paths: RoadPaths[] | (() => RoadPaths[]),
    nowSeconds: number,
  ): void {
    const movedSq = (camX - this.lastBuildX) ** 2 + (camZ - this.lastBuildZ) ** 2;
    if (
      !Number.isFinite(movedSq)
      || movedSq > 38 * 38
      || nowSeconds - this.lastBuildAt > 2.5
    ) {
      const resolvedPaths = typeof paths === 'function' ? paths() : paths;
      this.rebuild(camX, camZ, resolvedPaths);
      this.lastBuildX = camX;
      this.lastBuildZ = camZ;
      this.lastBuildAt = nowSeconds;
    }
    this.updateCars(nowSeconds);
  }

  setPopulationScale(scale: number): void {
    const next = Math.max(0.35, Math.min(1, scale));
    if (Math.abs(next - this.populationScale) < 0.04) return;
    this.populationScale = next;
    this.lastBuildAt = -Infinity;
  }

  get stats(): { cars: number; movingCars: number; lamps: number; signals: number } {
    return {
      cars: this.cars.length,
      movingCars: this.cars.reduce((count, car) => count + (car.moving ? 1 : 0), 0),
      lamps: this.lamps.length,
      signals: this.signals.length,
    };
  }

  private rebuild(camX: number, camZ: number, paths: RoadPaths[]): void {
    this.cars.length = 0;
    this.lamps.length = 0;
    this.signals.length = 0;
    const radiusSq = this.limits.radius ** 2;
    const parkedLimit = Math.max(10, Math.round(this.limits.parked * this.populationScale));
    const movingLimit = Math.max(2, Math.round(this.limits.moving * this.populationScale));
    const lampLimit = Math.max(12, Math.round(this.limits.lamps * (0.72 + this.populationScale * 0.28)));
    const signalLimit = Math.max(6, Math.round(this.limits.signals * (0.75 + this.populationScale * 0.25)));
    const seen = new Set<string>();
    const junctions = new Map<string, {
      x: number;
      z: number;
      width: number;
      dirs: Array<[number, number]>;
    }>();
    let parkedCount = 0;
    let movingCount = 0;

    for (const rp of paths) {
      for (let r = 0; r < rp.start.length - 1; r++) {
        if (rp.kind[r] !== PATH_KIND_ROAD) continue;
        const width = rp.width[r];
        if (width < 6 || width > 23) continue;
        const a = rp.start[r];
        const b = rp.start[r + 1];
        for (let j = a; j < b - 1; j++) {
          const x1 = rp.pts[j * 2];
          const z1 = rp.pts[j * 2 + 1];
          const x2 = rp.pts[(j + 1) * 2];
          const z2 = rp.pts[(j + 1) * 2 + 1];
          const dx0 = x2 - x1;
          const dz0 = z2 - z1;
          const length = Math.hypot(dx0, dz0);
          if (length < 8) continue;
          const mx = (x1 + x2) * 0.5;
          const mz = (z1 + z2) * 0.5;
          if ((mx - camX) ** 2 + (mz - camZ) ** 2 > (this.limits.radius + length) ** 2) continue;
          const key = `${Math.round(mx)}:${Math.round(mz)}:${Math.round(length)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const dx = dx0 / length;
          const dz = dz0 / length;
          const nx = -dz;
          const nz = dx;
          const yaw = Math.atan2(-dz, dx);
          const seed = segmentSeed(mx, mz, j);
          for (const [px, pz, dirX, dirZ] of [
            [x1, z1, dx, dz],
            [x2, z2, -dx, -dz],
          ] as const) {
            if ((px - camX) ** 2 + (pz - camZ) ** 2 > radiusSq) continue;
            const junctionKey = `${Math.round(px / 3)}:${Math.round(pz / 3)}`;
            const junction = junctions.get(junctionKey) ?? {
              x: px,
              z: pz,
              width,
              dirs: [],
            };
            junction.width = Math.max(junction.width, width);
            if (!junction.dirs.some(([jx, jz]) => jx * dirX + jz * dirZ > 0.985)) {
              junction.dirs.push([dirX, dirZ]);
            }
            junctions.set(junctionKey, junction);
          }

          if (parkedCount < parkedLimit && length > 25) {
            const spacing = 16 + hash01(seed) * 9;
            for (let along = 9 + hash01(seed + 1) * 7; along < length - 8; along += spacing) {
              if (parkedCount >= parkedLimit) break;
              if (hash01(seed + Math.round(along) * 7) < 0.27) continue;
              const side = hash01(seed + Math.round(along) * 11) < 0.5 ? -1 : 1;
              const curbOffset = Math.max(2.1, width * 0.5 - 1.05);
              const x = x1 + dx * along + nx * curbOffset * side;
              const z = z1 + dz * along + nz * curbOffset * side;
              if ((x - camX) ** 2 + (z - camZ) ** 2 > radiusSq) continue;
              const colorIndex = Math.floor(hash01(seed + Math.round(along) * 17) * CAR_COLORS.length);
              this.cars.push({
                x,
                z,
                yaw: yaw + (side < 0 ? Math.PI : 0),
                color: new THREE.Color(CAR_COLORS[colorIndex]),
              });
              parkedCount++;
            }
          }

          if (
            movingCount < movingLimit
            && length > 34
            && hash01(seed + 31) > 0.58
            && (mx - camX) ** 2 + (mz - camZ) ** 2 < radiusSq
          ) {
            const reverse = hash01(seed + 37) < 0.5;
            const laneOffset = Math.min(width * 0.22, 2.7) * (reverse ? -1 : 1);
            const colorIndex = Math.floor(hash01(seed + 41) * CAR_COLORS.length);
            this.cars.push({
              x: mx,
              z: mz,
              yaw: yaw + (reverse ? Math.PI : 0),
              color: new THREE.Color(CAR_COLORS[colorIndex]),
              moving: {
                x: x1,
                z: z1,
                dx,
                dz,
                length,
                offset: laneOffset,
                speed: 5.5 + hash01(seed + 43) * 6,
                phase: hash01(seed + 47) * length,
                reverse,
              },
            });
            movingCount++;
          }

          if (this.lamps.length < lampLimit && length > 28) {
            const spacing = 34 + hash01(seed + 51) * 12;
            for (let along = 14; along < length - 10; along += spacing) {
              if (this.lamps.length >= lampLimit) break;
              const side = hash01(seed + Math.round(along) * 23) < 0.5 ? -1 : 1;
              const offset = width * 0.5 + 2.35;
              const x = x1 + dx * along + nx * offset * side;
              const z = z1 + dz * along + nz * offset * side;
              if ((x - camX) ** 2 + (z - camZ) ** 2 > radiusSq) continue;
              this.lamps.push({
                x,
                y: heightAt(x, z),
                z,
                // The arm reaches from the sidewalk back over the roadway,
                // perpendicular to the parked cars.
                yaw: Math.atan2(dx * side, dz * side),
              });
            }
          }
        }
      }
    }
    for (const junction of junctions.values()) {
      if (this.signals.length >= signalLimit || junction.dirs.length < 3) continue;
      const [dx, dz] = junction.dirs[0];
      const nx = -dz;
      const nz = dx;
      const offset = junction.width * 0.5 + 2.1;
      const x = junction.x + nx * offset - dx * 1.2;
      const z = junction.z + nz * offset - dz * 1.2;
      this.signals.push({
        x,
        y: heightAt(x, z),
        z,
        // Signal lens geometry faces local +z, toward the approaching lane.
        yaw: Math.atan2(dx, dz),
      });
    }
    this.updateLamps();
    this.updateSignals();
  }

  private updateCars(nowSeconds: number): void {
    const wheelOffsets: ReadonlyArray<readonly [number, number]> = [
      [-1.35, -0.94],
      [-1.35, 0.94],
      [1.35, -0.94],
      [1.35, 0.94],
    ];
    const count = Math.min(this.cars.length, this.body.instanceMatrix.count);
    let wheelIndex = 0;
    for (let i = 0; i < count; i++) {
      const car = this.cars[i];
      let x = car.x;
      let z = car.z;
      let yaw = car.yaw;
      if (car.moving) {
        const m = car.moving;
        let along = (nowSeconds * m.speed + m.phase) % m.length;
        if (m.reverse) along = m.length - along;
        x = m.x + m.dx * along - m.dz * m.offset;
        z = m.z + m.dz * along + m.dx * m.offset;
        yaw = Math.atan2(-m.dz, m.dx) + (m.reverse ? Math.PI : 0);
      }
      const y = heightAt(x, z) + 0.05;
      this.yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      this.matrix.compose(this.position.set(x, y, z), this.yawQ, this.scale);
      this.body.setMatrixAt(i, this.matrix);
      this.cabin.setMatrixAt(i, this.matrix);
      this.body.setColorAt(i, car.color);
      this.cabin.setColorAt(
        i,
        this.cabinColor.copy(car.color).multiplyScalar(0.72).lerp(this.glassTint, 0.46),
      );

      this.wheelQ.copy(this.yawQ).multiply(this.wheelTurn);
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      for (const [localX, localZ] of wheelOffsets) {
        const wx = x + localX * c + localZ * s;
        const wz = z - localX * s + localZ * c;
        this.matrix.compose(this.position.set(wx, y + 0.36, wz), this.wheelQ, this.scale);
        this.wheels.setMatrixAt(wheelIndex++, this.matrix);
      }
    }
    this.body.count = this.cabin.count = count;
    this.wheels.count = wheelIndex;
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.cabin.instanceColor) this.cabin.instanceColor.needsUpdate = true;
  }

  private updateLamps(): void {
    const count = Math.min(this.lamps.length, this.lampPoles.instanceMatrix.count);
    for (let i = 0; i < count; i++) {
      const lamp = this.lamps[i];
      this.yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, lamp.yaw);
      this.matrix.compose(this.position.set(lamp.x, lamp.y, lamp.z), this.yawQ, this.scale);
      this.lampPoles.setMatrixAt(i, this.matrix);
      this.lampArms.setMatrixAt(i, this.matrix);
      this.lampHeads.setMatrixAt(i, this.matrix);
    }
    this.lampPoles.count = this.lampArms.count = this.lampHeads.count = count;
    this.lampPoles.instanceMatrix.needsUpdate = true;
    this.lampArms.instanceMatrix.needsUpdate = true;
    this.lampHeads.instanceMatrix.needsUpdate = true;
  }

  private updateSignals(): void {
    const count = Math.min(this.signals.length, this.signalPoles.instanceMatrix.count);
    for (let i = 0; i < count; i++) {
      const signal = this.signals[i];
      this.yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, signal.yaw);
      this.matrix.compose(this.position.set(signal.x, signal.y, signal.z), this.yawQ, this.scale);
      this.signalPoles.setMatrixAt(i, this.matrix);
      this.signalHeads.setMatrixAt(i, this.matrix);
      this.signalLights.setMatrixAt(i, this.matrix);
    }
    this.signalPoles.count = this.signalHeads.count = this.signalLights.count = count;
    this.signalPoles.instanceMatrix.needsUpdate = true;
    this.signalHeads.instanceMatrix.needsUpdate = true;
    this.signalLights.instanceMatrix.needsUpdate = true;
  }

  destroy(): void {
    this.group.removeFromParent();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
  }
}
