import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const context = new Proxy({
  measureText: text => ({ width: text.length * 10 }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  createLinearGradient: () => ({ addColorStop() {} }),
}, { get: (object, key) => key in object ? object[key] : () => {}, set: (object, key, value) => (object[key] = value, true) });
globalThis.document = { createElement: () => ({ getContext: () => context, width: 0, height: 0 }) };
const idle = new Map();
let nextIdle = 1;
globalThis.requestIdleCallback = callback => { const id = nextIdle++; idle.set(id, callback); return id; };
globalThis.cancelIdleCallback = id => idle.delete(id);
const { BusModel } = await import('../../src/engine/bus/model.ts');

test('idle bus detail stays hidden until near LOD and cycles without duplicate wheels', () => {
  const bus = new BusModel({ route: 'M15', dest: 'SOUTH FERRY', color: '#1d59b3', sbs: false });
  bus.setViewerDistanceSq(150 ** 2);
  const callback = idle.get(bus.idleBuild);
  assert.ok(callback);
  idle.delete(bus.idleBuild); callback();
  assert.equal(bus.axles.length, 2);
  assert.equal(bus.hull.visible, false);
  assert.equal(bus.farHull.visible, true);
  assert.ok(bus.axles.every(axle => !axle.visible));
  bus.setViewerDistanceSq(140 ** 2);
  assert.ok(bus.axles.every(axle => !axle.visible), 'unchanged far state cannot reveal detailed wheels');

  for (let cycle = 0; cycle < 3; cycle++) {
    bus.setViewerDistanceSq(70 ** 2);
    assert.equal(bus.hull.visible, true);
    assert.equal(bus.farHull.visible, false);
    assert.ok(bus.axles.every(axle => axle.visible));
    bus.setViewerDistanceSq(110 ** 2);
    assert.equal(bus.hull.visible, false);
    assert.equal(bus.farHull.visible, true);
    assert.ok(bus.axles.every(axle => !axle.visible));
  }
  bus.setViewerDistanceSq(200 ** 2, true);
  assert.equal(bus.hull.visible, true, 'a ridden bus retains its full cabin');
  assert.ok(bus.axles.every(axle => axle.visible));
  bus.dispose();
});

test('disposing a bus cancels idle detail construction', () => {
  const bus = new BusModel({ route: 'M15', dest: 'SOUTH FERRY', color: '#1d59b3', sbs: false });
  const id = bus.idleBuild;
  assert.ok(idle.has(id));
  bus.dispose();
  assert.equal(idle.has(id), false);
  assert.equal(bus.axles.length, 0);
});
