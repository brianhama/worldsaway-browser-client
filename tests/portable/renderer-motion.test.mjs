import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldRenderer} from '../../dist/public/renderer.js';

const region = {noid: 0, classNumber: 20, fields: {horizon: 70}};
const avatar = position => ({noid: 16, classNumber: 21,
  fields: {container_noid: 0, position, imageURL: 'avatar.img'}});
const scene = object => ({status: 'connected', actorNoid: 16, region,
  objects: [region, object], history: [{seq: 1, type: 'message', id: 101, noid: 0, fields: {}}]});
const image = {
  chores: [],
  choreography(names, state = 0, includeEndState = false) {
    const states = names[0] === 'default' ? [0] : Array.from({length: 20}, (_, i) => i + 1);
    return includeEndState ? {states, endState: state} : states;
  },
  frameFor(state, orientation, mood) { return {state, orientation, mood}; },
};

function harness(state) {
  let now = 1000;
  const drawn = [];
  const renderer = Object.create(WorldRenderer.prototype);
  const context = new Proxy({}, {get: () => () => {}});
  Object.assign(renderer, {
    canvas: {width: 512, height: 288}, context, state: {objects: []}, destroyed: false,
    assets: new Map(), playbacks: new Map(), idles: new Map(), motions: new Map(),
    walkFacings: new Map(), preferences: {animation: true, names: false}, paletteId: 0,
    time: () => now, drawLabels() {},
    drawObject(object, x, y) { drawn.push({noid: object.noid, x, y}); },
  });
  renderer.setState(state);
  return {renderer, drawn, at(time) { now = time; }, draw() {
    drawn.length = 0; renderer.draw(); return drawn;
  }};
}

test('cached walking art sets native duration before the first interpolated draw', () => {
  const original = avatar([0, 300, 0]), initial = scene(original), h = harness(initial);
  h.renderer.assets.set('avatar.img@0#0', image);
  const next = avatar([140, 300, 0]);
  h.renderer.setState({...initial, objects: [region, next], history: [...initial.history,
    {seq: 2, type: 'message', id: 1571, noid: 16, requestId: 1570, fields: {success: 0, coords: next.fields.position}}]});
  const motion = h.renderer.motions.get(16);
  assert.equal(motion.duration, 3500);
  assert.equal(motion.start, 1000);
  h.at(1875);
  assert.equal(h.draw().find(object => object.noid === 16).x, 35);
});

test('late walking art keeps displayed progress when native duration becomes available', () => {
  const object = avatar([140, 300, 0]), h = harness(scene(object));
  h.renderer.motions.set(16, {from: [0, 300, 0], to: [140, 300, 0],
    start: 1000, duration: 1400, distance: 140, orientation: 1, holding: false});
  h.at(1350);
  assert.equal(h.draw().find(object => object.noid === 16).x, 35);
  h.renderer.assets.set('avatar.img@0#0', image);
  assert.equal(h.draw().find(object => object.noid === 16).x, 35, 'loading art must not move the actor backward');
  const motion = h.renderer.motions.get(16);
  assert.equal(motion.duration, 3500);
  h.at(1525);
  assert.equal(h.draw().find(object => object.noid === 16).x, 42);
  h.at(motion.start + motion.duration);
  assert.equal(h.draw().find(object => object.noid === 16).x, 140);
  assert.equal(h.renderer.motions.size, 0);
});

test('walking actors cross scenery in displayed depth order', () => {
  const object = avatar([200, 400, 0]), prop = {noid: 40, classNumber: 27,
    fields: {container_noid: 0, position: [200, 250, 0]}}, initial = scene(object);
  initial.objects.push(prop);
  const h = harness(initial);
  h.renderer.motions.set(16, {from: [200, 100, 0], to: [200, 400, 0],
    start: 1000, duration: 1000, distance: 300, orientation: 2, holding: false});
  h.at(1100);
  assert.deepEqual(h.draw().map(object => object.noid), [0, 40, 16], 'actor remains in front while its displayed depth is smaller');
  h.at(1600);
  assert.deepEqual(h.draw().map(object => object.noid), [0, 16, 40], 'actor moves behind the prop after crossing its depth');
  assert.deepEqual(object.fields.position, [200, 400, 0], 'presentation never changes authoritative coordinates');
});
