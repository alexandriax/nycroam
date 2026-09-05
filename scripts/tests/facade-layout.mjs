import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    if (/^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { buildResponseByteLength } = await import('../../src/engine/tileTypes.ts');
const { buildFoliageGeometry } = await import('../../src/engine/foliageGeometry.ts');
let response, buffers;
globalThis.self = { postMessage(result, transfer) { response = result; buffers = transfer; } };
await import('../../src/engine/tileWorker.ts');

async function build(base, variant = 31) {
  const tile = { v: 2, x: 100, z: 100, buildings: [{p: [[0,0,180,0,180,120,0,120]], h: 21, b: base, a: 7, v: variant}], roads: [], areas: [] };
  const source = new TextEncoder().encode(JSON.stringify(tile)).buffer;
  await self.onmessage({ data: {type: 'build', key: 'test', url: `fixture:${base}:${variant}`, source, detail: 0} });
  assert.equal(response.error, undefined);
  assert.equal(response.timing.transferBytes, buildResponseByteLength(response));
  assert.ok(buffers.includes(response.buildings.facade.buffer), 'layout must transfer, not structured clone');
  return response.buildings;
}

test('facade coordinates follow the footprint and stay at street datum on elevated terrain', async () => {
  const flat = await build(0), hill = await build(47.3);
  assert.deepEqual(flat.facade, hill.facade, 'a hillside building must have identical opening positions');
  assert.equal(hill.facade.length, hill.position.length / 3 * 4);
  const widths = new Set(), heights = new Set();
  for (let i = 0; i < hill.normal.length / 3; i++) {
    if (hill.normal[i*3+1] !== 0) continue;
    const [u,v,width,seed] = hill.facade.slice(i*4,i*4+4);
    assert.ok(Math.abs(u) < .001 || Math.abs(u-width) < .001, 'bays start and end at the actual facade corners');
    assert.ok(seed >= 0 && seed <= 1);
    widths.add(width); heights.add(v);
  }
  assert.deepEqual([...widths].sort((a,b)=>a-b), [12,18]);
  assert.deepEqual([...heights].sort((a,b)=>a-b), [-2.5,21]);
  const neighbor = await build(0, 54);
  assert.notEqual(flat.facade[3], neighbor.facade[3], 'adjacent identities need stable different layouts');
});

test('near foliage has actual leaf gaps with fixed geometry cost and no alpha atlas', () => {
  const lobes = [{x:0,y:0,z:0,sx:1.5,sy:1.8,sz:1.5}];
  const g = buildFoliageGeometry(lobes, 11), repeated = buildFoliageGeometry(lobes, 11);
  assert.equal(g.index.count/3, 48 * 6 * 4);
  assert.deepEqual(g.attributes.position.array, repeated.attributes.position.array);
  for (const name of ['position','normal','color','uv']) assert.ok([...g.attributes[name].array].every(Number.isFinite));
  g.computeBoundingBox();
  assert.ok(g.boundingBox.max.x < 2 && g.boundingBox.min.x > -2);
  assert.ok(g.boundingBox.min.y > 0);
  g.dispose(); repeated.dispose();
});
