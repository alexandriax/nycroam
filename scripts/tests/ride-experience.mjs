import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
registerHooks({
resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
      throw error;
    }
  }
});
const { rideStationLayout, cabinRailSegments, RIDE_SIGN_HALF_THICKNESS, rideTravelDistance, rideLegDistance } = await import('../../src/engine/subway/rideLayout.ts');
const { COMPLEXES } = await import('../../src/engine/subway/complexes.ts');
const subway = JSON.parse(readFileSync(new URL('../../public/subway/subway.json', import.meta.url)));
const stations = new Map(subway.stations.map(s => [s.id, s]));
const context = new Proxy({ measureText: s => ({ width: s.length * 10 }), createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), createLinearGradient: () => ({ addColorStop() { } }) }, { get: (o, k) => k in o ? o[k] : () => { }, set: (o, k, v) => (o[k] = v, true) });
globalThis.document = { createElement: () => ({ getContext: () => context, width: 0, height: 0 }) };
const { RideWorld } = await import('../../src/engine/subway/RideWorld.ts');
const network = { routes: { '1': { stops: ['127', '126'], t: [40], color: '#ee352e' }, '2': { stops: ['127', '120'], t: [80], color: '#ee352e' } } };

test('ride scenery resolves the actual local/express side and double-level direction', () => {
  assert.equal(rideStationLayout(stations.get('127'), '1', 1).platformSide, -1);
  assert.equal(rideStationLayout(stations.get('127'), '2', 1).platformSide, 1);
  for (const route of ['1', '2']) {
    const layout = rideStationLayout(stations.get('127'), route, 1);
    const nearest = Math.min(...layout.platforms.flatMap(p => [Math.abs(p.zMin), Math.abs(p.zMax)]));
    assert.ok(Math.abs(nearest - 1.43) < 1e-8, 'IRT exterior half-width1.35 plus physical clearance.08');
  }
  for (const route of ['B', 'D', 'E']) for (const dir of [-1, 1]) {
    const layout = rideStationLayout(stations.get('D14'), route, dir);
    const group = COMPLEXES.flatMap(c => c.groups).find(g => g.id === 'D14' && g.tracks.some(t => t.routes.includes(route) && t.dir === dir));
    assert.ok(group);
    const track = group.tracks.findIndex(t => t.routes.includes(route) && t.dir === dir);
    const physical = track === 0 ? 1 : -1;
    const travel = group.tracks[track].flip ? -dir : dir;
    assert.equal(layout.platformSide, physical * travel, `${route} direction ${dir}`);
  }
});

test('all served authored platforms have a finite footprint and selected track at zero', () => {
  for (const complex of COMPLEXES) for (const group of complex.groups) {
    const station = stations.get(group.id); if (!station) continue;
    for (const track of group.tracks.filter(t => !t.pass)) for (const route of track.routes) {
      const layout = rideStationLayout(station, route, track.dir);
      assert.ok(layout.tracks.includes(0));
      assert.ok(layout.platforms.every(p => Number.isFinite(p.zMin) && p.zMax > p.zMin));
      assert.ok(layout.platforms.some(p => Math.sign(p.zMin + p.zMax) === layout.platformSide));
      assert.equal(layout.length, group.length);
    }
  }
});

test('grab rails physically clear the complete indicator casing', () => {
  for (const length of [15.4, 18.2]) for (const [a, b] of cabinRailSegments(length)) {
    assert.ok(a < b);
    assert.ok(b < -RIDE_SIGN_HALF_THICKNESS - .023 || a > RIDE_SIGN_HALF_THICKNESS + .023);
  }
});

test('travel integrates to the same distance across frame partitions, with zero endpoint speed', () => {
  const total = rideLegDistance(14, 156, 183);
  let sum = 0;
  for (let i = 1; i <= 840; i++)sum += rideTravelDistance(i / 840, total) - rideTravelDistance((i - 1) / 840, total);
  assert.ok(Math.abs(sum - total) < 1e-8);
  assert.ok(total >= 156 / 2 + 183 / 2 + 55);
  assert.ok(rideTravelDistance(.001, total) < .001 * total * .01);
  assert.equal(rideTravelDistance(1, total), total);
});

test('only the real fully open doorway permits exit, with no escape through windows', () => {
  for (const route of ['1', '2']) {
    const ride = new RideWorld(route, 1, '127', network, stations, null);
    ride.update(.01);
    const side = ride.platformSide;
    assert.equal(ride.isAtOpenDoor(ride.doorBays[0], side * 1.30), true);
    assert.equal(ride.isAtOpenDoor(ride.doorBays[0], -side * 1.30), false);
    assert.equal(ride.isAtOpenDoor(1.9, side * 1.30), false);
    assert.ok(Math.abs(ride.clampPosition(1.9, side * 9).z) <= ride.interiorBounds.halfWidth);
    for (const panel of ride.doorPanels) assert.ok(Math.abs(panel.mesh.position.x - panel.home - (panel.side === side ? panel.dir * .67 : 0)) < 1e-8);
    ride.update(8.1); assert.equal(ride.canExit, false);
    ride.dispose();
  }
});

test('walking stays in the clear aisle beside seats and keeps full access to door bays', () => {
  for (const route of ['1', '2']) {
    const ride = new RideWorld(route, 1, '127', network, stations, null);
    const bay = ride.doorBays[0], seatBand = (bay + ride.doorBays[1]) / 2;
    const aisle = ride.carWidth / 2 - .72;
    for (const side of [-1, 1]) {
      assert.equal(ride.clampPosition(seatBand, side * 10).z, side * aisle);
    }
    const open = ride.clampPosition(bay, ride.platformSide * 10);
    assert.ok(Math.abs(open.z) > ride.interiorBounds.halfWidth);
    assert.equal(ride.isAtOpenDoor(open.x, open.z), true);
    ride.update(8.1);
    assert.equal(ride.canExit, false);
    for (const side of [-1, 1]) {
      assert.equal(ride.clampPosition(bay, side * 10).z, side * ride.interiorBounds.halfWidth);
      assert.equal(ride.clampPosition(seatBand, side * 10).z, side * aisle);
    }
    ride.dispose();
  }
});

test('station rolls past windows before arrival; tunnel aperture follows complete platform', () => {
  const ride = new RideWorld('1', 1, '127', network, stations, null);
  const prepared = ride.scenery.prepared.children[0];
  ride.jumpTo(.90);
  assert.equal(ride.scenery.station.children[0], prepared, 'arrival reuses the station built while dwelling');
  assert.equal(ride.hudInfo.state, 'moving');
  assert.equal(ride.scenery.station.visible, true);
  const [a, b] = ride.scenery.platformInterval;
  assert.ok(a < ride.carHalf && b > -ride.carHalf);
  assert.deepEqual(ride.scenery.aperture.value.toArray(), [a, b]);
  assert.equal(ride.scenery.layout.stationId, '126');
  const x = ride.scenery.station.position.x; ride.update(.1);
  assert.ok(ride.scenery.station.position.x < x, 'approaching station advances toward train without a pop');
  ride.update(20); assert.equal(ride.currentStationId, '126');
  assert.equal(ride.hudInfo.state, 'dwell'); assert.equal(ride.scenery.station.position.x, 0);
  ride.dispose();
});

test('coarse ride steps retain journey duration and boarded cabin stays batched', () => {
  const fine = new RideWorld('1', 1, '127', network, stations, null), coarse = new RideWorld('1', 1, '127', network, stations, null);
  for (let i = 0; i < 1200; i++)fine.update(1 / 60); coarse.update(20);
  assert.equal(fine.hudInfo.state, coarse.hudInfo.state);
  assert.ok(Math.abs(fine.shareInfo.prog - coarse.shareInfo.prog) < 1e-7);
  assert.ok(Math.abs(fine.scrollOffset - coarse.scrollOffset) < 1e-6);
  let exterior = 0; coarse.scenery.station.traverse(o => { if (o instanceof THREE.Mesh) exterior++; });
  assert.ok(exterior <= 14, `station backdrop ${exterior} draws must remain bounded`);
  assert.equal(coarse.passengers.batch.group.children.length, 2);
  fine.dispose(); coarse.dispose();
});
