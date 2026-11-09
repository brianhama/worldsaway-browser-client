import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldRenderer} from '../../dist/public/renderer.js';
import {getObjectMenu} from '../../dist/public/menus.js';
import {nativeGroundWalkRequest} from '../../dist/public/approach.js';

test('Walk to retains the opening scene click through scaled-canvas selection and menu activation', t => {
  const previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  let renderer;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    renderer?.destroy();
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    if (previousCancel === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = previousCancel;
  });
  const region = {noid: 0, classNumber: 20, fields: {horizon: 70}};
  const actor = {noid: 16, classNumber: 21, fields: {position: [250, 300, 12], container_noid: 0}};
  // Both clicks hit the same broad backdrop, whose fixed origin caused the bug.
  const target = {noid: 40, classNumber: 27, fields: {name: 'Backdrop', position: [200, 20, 0], container_noid: 0, common_flags: 4}};
  const state = {status: 'connected', actorNoid: 16, region, objects: [region, actor, target]};
  let rect = {left: 50, top: 100, width: 1024, height: 576}, menu;
  const canvas = {getContext: () => ({}), getBoundingClientRect: () => rect, addEventListener() {}, removeEventListener() {}};
  renderer = new WorldRenderer(canvas, {
    onSelect(object, destination) { menu = getObjectMenu(object, state, destination); },
  });
  renderer.state = state;
  renderer.hitTest = () => target;

  for (const size of [[1024, 576], [256, 144]]) {
    rect = {...rect, width: size[0], height: size[1]};
    for (const x of [80, 420]) {
      renderer.click({clientX: rect.left + x * rect.width / 512, clientY: rect.top + 253 * rect.height / 288});
      const walk = menu.items[0];
      assert.equal(walk.disabled, false);
      assert.deepEqual(walk.fields.coords, [x, 256, 0]);
      // Menu activation uses the retained fields, even after the selected object moves.
      target.fields.position = [999, 999, 99];
      assert.deepEqual(nativeGroundWalkRequest(walk.fields.coords, state), {
        id: 1570, noid: 16, fields: {coords: [x, 256, 0]},
      });
    }
  }
});

test('scene Walk to uses ground coordinates without requiring a physical destination on the hit object', () => {
  const actor = {noid: 16, classNumber: 21, fields: {position: [20, 300, 0], container_noid: 0}};
  const ghost = {noid: 40, classNumber: 22, fields: {name: 'Ghost', position: [0, 0, 255]}};
  const state = {status: 'connected', actorNoid: 16, objects: [actor, ghost]};
  const point = [160, 400, 0], walk = getObjectMenu(ghost, state, point).items[0];
  point[0] = 480;
  assert.equal(walk.disabled, false);
  assert.deepEqual(walk.fields.coords, [160, 400, 0], 'the opening point is copied into the menu');
  assert.equal(getObjectMenu(ghost, state).items[0].disabled, true, 'object-only menus retain native target rules');
  for (const change of [{status: 'disconnected'}, {permissions: {flags: 0}}, {tcl: {blockCount: 1}}]) {
    assert.equal(getObjectMenu(ghost, {...state, ...change}, [160, 400, 0]).items[0].disabled, true);
    assert.throws(() => nativeGroundWalkRequest(walk.fields.coords, {...state, ...change}));
  }
});
