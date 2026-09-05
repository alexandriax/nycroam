import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { clampBusCabinPosition, atOpenBusDoor } = await import('../../src/engine/bus/cabinNavigation.ts');

test('both bus doors are reachable without walking through the driver cab or seat rows', () => {
  assert.deepEqual(clampBusCabinPosition(4.1, 0, true), { x: 3.3, z: 0 });
  assert.deepEqual(clampBusCabinPosition(2.05, 2, true), { x: 2.05, z: .62 });
  const vestibule = clampBusCabinPosition(4.1, .5, true);
  assert.equal(vestibule.x, 4.1);
  assert.equal(clampBusCabinPosition(5.7, .5, true).x, 4.1, 'farebox/dash stay outside walking area');
  for (const x of [4.1, -1.15]) {
    const threshold = clampBusCabinPosition(x, 2, true);
    assert.equal(atOpenBusDoor(threshold.x, threshold.z, true), true);
    assert.equal(atOpenBusDoor(threshold.x, threshold.z, false), false);
  }
});

test('bus exit triggers require the real open aperture, not nearby solid panels', () => {
  for (const x of [3.3, 4.8, -2.15, -.15, 0]) assert.equal(atOpenBusDoor(x, 1.3, true), false);
  assert.equal(atOpenBusDoor(-1.15, .6, true), false, 'middle of aisle is not a walk-off');
  assert.equal(atOpenBusDoor(-1.15, -1.3, true), false, 'street-side wall never opens');
});
