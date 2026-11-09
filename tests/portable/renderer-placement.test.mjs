import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldRenderer, projectPosition} from '../../dist/public/renderer.js';

const ghost = (extra = {}) => ({noid: 101, classNumber: 22, fields: {
  container_noid: 0, position: [37, 255, 80], imageURL: 'ghost.img', ...extra,
}});
const image = (name, anchor = {x: 0, y: 0}, transparentCorner = false) => ({
  name, cels: [{}], frame: {width: 24, height: 30, anchor,
    parts: [{cel: 0, x: 0, y: 0, flags: 0}]},
  alpha: Uint8Array.from({length: 24 * 30}, (_, i) => transparentCorner && i === 0 ? 0 : 255),
});

function harness(objects, {width = 512, height = 288, names = false} = {}) {
  const region = {noid: 0, classNumber: 20, fields: {horizon: 70}};
  const painted = [], labels = [];
  const context = new Proxy({
    drawImage(surface) { painted.push(surface.name); },
    fillText(text, x, y) { labels.push({text, x, y}); },
    measureText(text) { return {width: text.length * 6}; },
  }, {get: (target, key) => target[key] ?? (() => {})});
  const renderer = Object.create(WorldRenderer.prototype);
  Object.assign(renderer, {
    canvas: {width, height}, context, destroyed: false,
    state: {status: 'connected', region, objects: [region, ...objects], history: [], viewport: {width, height}},
    preferences: {names}, assets: new Map(), motions: new Map(), selected: null,
    frame: (_object, asset) => asset.frame,
    surface: asset => ({name: asset.name, width: 24, height: 30, waAlpha: asset.alpha}),
  });
  renderer.assets.set('ghost.img@0#0', image('ghost', {x: 7, y: -4}, true));
  return {renderer, region, painted, labels};
}

test('ghost frames stay in the top right across world coordinates, horizons, and viewport sizes', () => {
  const object = ghost(), h = harness([object]);
  for (const [position, horizon, common_flags] of [
    [[37, 255, 80], 70, 0], [[-200, 0, 1000], 120, 4], [[1500, 512, -50], 40, 0],
  ]) {
    object.fields.position = Object.freeze(position);
    object.fields.common_flags = common_flags;
    h.region.fields.horizon = horizon;
    const before = structuredClone(object.fields);
    h.renderer.draw();
    const bound = h.renderer.bounds.find(bound => bound.object === object);
    assert.deepEqual([bound.x, bound.y, bound.width, bound.height], [480, 8, 24, 30]);
    assert.equal(h.renderer.hitTest(492, 23), object);
    assert.deepEqual(object.fields, before, 'corner rendering preserves authoritative fields');
  }
  for (const [width, height] of [[800, 450], [320, 200]]) {
    h.renderer.state.viewport = {width, height};
    h.renderer.draw();
    const bound = h.renderer.bounds.find(bound => bound.object === object);
    assert.equal(width - bound.x - bound.width, 8);
    assert.equal(bound.y, 8);
    assert.equal(h.renderer.canvas.width, width);
    assert.equal(h.renderer.canvas.height, height);
    assert.equal(h.renderer.hitTest(width - 20, 23), object);
  }
});

test('corner ghosts paint above foreground props and preserve transparent hit testing', () => {
  const object = ghost(), prop = {noid: 102, classNumber: 27, fields: {
    container_noid: 0, position: [480, 0, 250], imageURL: 'prop.img',
  }};
  const h = harness([object, prop]);
  h.renderer.assets.set('prop.img@0#0', image('prop'));
  h.renderer.draw();
  assert.deepEqual(h.painted, ['prop', 'ghost']);
  assert.equal(h.renderer.hitTest(492, 23), object, 'opaque ghost pixels win over a foreground prop');
  assert.equal(h.renderer.hitTest(480.5, 8.5), prop, 'transparent ghost pixels reveal the prop');
  object.fields.common_flags = 1;
  h.painted.length = 0;
  h.renderer.draw();
  assert.deepEqual(h.painted, ['prop']);
  assert.equal(h.renderer.hitTest(492, 23), prop);
  assert.equal(h.renderer.bounds.some(bound => bound.object === object), false);
});

test('pending and failed ghost art retains a selectable top-right fallback', () => {
  for (const asset of [null, {error: 'Unavailable'}]) {
    const object = ghost(), h = harness([object], {width: 640, height: 360});
    h.renderer.assets.set('ghost.img@0#0', asset);
    h.renderer.draw();
    const hit = h.renderer.hitRegions.find(hit => hit.object === object);
    assert.deepEqual([hit.x, hit.y, hit.width, hit.height], [620, 8, 12, 12]);
    assert.equal(h.renderer.hitTest(626, 14), object);
    assert.equal(h.renderer.hitTest(619, 14), null);
  }
});

test('materialized avatars resume ground placement with the same native frame anchor', () => {
  const object = ghost(), h = harness([object]);
  h.renderer.draw();
  object.classNumber = 21;
  object.fields.position = [200, 300, 0];
  h.renderer.draw();
  const [x, y] = projectPosition(object.fields.position);
  const bound = h.renderer.bounds.find(bound => bound.object === object);
  assert.deepEqual([bound.x, bound.y], [x - 7, y - 4 - 30]);
  assert.equal(h.renderer.hitTest(bound.x + 12, bound.y + 15), object);
  assert.equal(h.renderer.hitTest(492, 23), null);
  assert.deepEqual(object.fields.position, [200, 300, 0]);
});

test('ghost names sit below the corner sprite and remain within the viewport', () => {
  const object = ghost({name: 'A long ghost name near the right edge'}), h = harness([object], {names: true});
  h.renderer.draw();
  const label = h.labels.find(label => label.text === object.fields.name);
  assert.ok(label);
  assert.ok(label.y > 38, 'the name sits below the entire ghost frame');
  const halfWidth = (object.fields.name.length * 6 + 10) / 2;
  assert.ok(label.x - halfWidth >= 4);
  assert.ok(label.x + halfWidth <= 508);
});
