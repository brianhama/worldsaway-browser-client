import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldRenderer} from '../../dist/public/renderer.js';

const FRAME_TIME = 175;
const prop = (noid = 30, extra = {}) => ({noid, classNumber: 27, fields: {
  noid, container_noid: 0, position: [100, 300, 0], choreState: 0, ...extra,
}});
const region = {noid: 0, classNumber: 20, fields: {noid: 0, horizon: 70}};
const scene = objects => ({status: 'connected', region, objects: [region, ...objects],
  history: [{seq: 1, type: 'message', id: 101, noid: 0, fields: {}}]});

function imageFixture({transition = false} = {}) {
  const calls = [];
  const defaults = transition
    ? [{states: [10, 11], endState: 1}, {states: [20, 21], endState: 1}]
    : [{states: [10, 11, 12], endState: 0}, {states: [20, 21], endState: 1}];
  return {
    calls,
    chores: [],
    namedStates: defaults.map((_, i) => ({name: `state${i}`, entries: []})),
    choreography(names, namedState = 0, includeEndState = false) {
      calls.push({names, namedState});
      const plan = names[0] === 'wave'
        ? {states: [90, 91], endState: 1}
        : defaults[namedState] ?? defaults[0];
      return includeEndState ? {...plan, states: [...plan.states]} : [...plan.states];
    },
    frameFor(state, orientation, mood) { return {state, orientation, mood}; },
  };
}

function harness(objects = [prop()]) {
  let now = 1000;
  const renderer = Object.create(WorldRenderer.prototype);
  Object.assign(renderer, {
    state: {objects: []}, preferences: {animation: true},
    assets: new Map(), playbacks: new Map(), motions: new Map(), idles: new Map(),
    walkFacings: new Map(), paletteId: 0, tick: 0,
    draw() {}, time: () => now,
  });
  renderer.setState(scene(objects));
  return {renderer, at(time) { now = time; }, frame(object, image) {
    return renderer.frame(object, image).state;
  }};
}

test('native default animation advances at its own cadence and loops without rebuilding the plan', () => {
  const object = prop(), image = imageFixture(), h = harness([object]);
  assert.equal(h.frame(object, image), 10);
  const compiledCalls = image.calls.length;
  h.at(1000 + FRAME_TIME - 1); assert.equal(h.frame(object, image), 10);
  h.at(1000 + FRAME_TIME); assert.equal(h.frame(object, image), 11);
  h.at(1000 + FRAME_TIME * 2); assert.equal(h.frame(object, image), 12);
  h.at(1000 + FRAME_TIME * 3); assert.equal(h.frame(object, image), 10);
  h.at(1000 + FRAME_TIME * 30001); assert.equal(h.frame(object, image), 11);
  assert.equal(image.calls.length, compiledCalls, 'the same native plan is reused on later redraws');
});

test('default animation follows a state transition once, then loops the terminal default', () => {
  const object = prop(), image = imageFixture({transition: true}), h = harness([object]);
  const sampled = [];
  for (let step = 0; step < 8; step++) {
    h.at(1000 + step * FRAME_TIME);
    sampled.push(h.frame(object, image));
  }
  assert.deepEqual(sampled, [10, 11, 20, 21, 20, 21, 20, 21]);
  assert.equal(object.fields.choreState, 0, 'presentation does not modify authoritative world fields');
});

test('each object keeps its animation origin through unrelated cloned snapshots', () => {
  const first = prop(30), second = prop(31), image = imageFixture(), h = harness([first, second]);
  assert.equal(h.frame(first, image), 10);
  h.at(1100); assert.equal(h.frame(second, image), 10);
  h.at(1200);
  const cloned = structuredClone(scene([first, second]));
  h.renderer.setState(cloned);
  assert.equal(h.frame(cloned.objects[1], image), 11);
  assert.equal(h.frame(cloned.objects[2], image), 10);
  h.at(1275); assert.equal(h.frame(cloned.objects[2], image), 11);
});

test('image and chore-state changes start the new default at its first pose', () => {
  const object = prop(), image = imageFixture(), h = harness([object]);
  h.frame(object, image);
  h.at(1200); assert.equal(h.frame(object, image), 11);
  const replacement = imageFixture();
  assert.equal(h.frame(object, replacement), 10, 'a newly loaded image has a new animation origin');
  h.at(1400); assert.equal(h.frame(object, replacement), 11);
  const changed = {...object, fields: {...object.fields, choreState: 1}};
  assert.equal(h.frame(changed, replacement), 20);
  h.at(1575); assert.equal(h.frame(changed, replacement), 21);
});

test('removed objects and a new HereIs discard retained animation clocks', () => {
  const object = prop(), image = imageFixture(), h = harness([object]);
  h.frame(object, image);
  h.at(1200); assert.equal(h.frame(object, image), 11);
  h.renderer.setState(scene([]));
  h.renderer.setState(scene([object]));
  assert.equal(h.frame(object, image), 10, 'reused object number begins a fresh animation');
  h.at(1400); assert.equal(h.frame(object, image), 11);
  const nextScene = scene([object]);
  nextScene.history.push({seq: 2, type: 'message', id: 101, noid: 0, fields: {}});
  h.renderer.setState(nextScene);
  assert.equal(h.frame(object, image), 10, 'room changes do not carry old object playback');
});

test('a gesture plays once then animates its resulting default from the completion time', () => {
  const object = prop(30, {gesture: 'wave', gestureSeq: 1}), image = imageFixture(), h = harness([object]);
  assert.equal(h.frame(object, image), 90);
  h.at(1175); assert.equal(h.frame(object, image), 91);
  h.at(1350); assert.equal(h.frame(object, image), 20);
  h.at(1525); assert.equal(h.frame(object, image), 21);
  h.at(1700); assert.equal(h.frame(object, image), 20);
  const cloned = structuredClone(scene([object]));
  h.renderer.setState(cloned);
  h.at(1875); assert.equal(h.frame(cloned.objects[1], image), 21, 'retained gesture fields never replay a completed gesture');
  const delayed = harness([object]), secondImage = imageFixture();
  delayed.frame(object, secondImage);
  delayed.at(1525);
  assert.equal(delayed.frame(object, secondImage), 21, 'a delayed browser redraw uses the actual gesture completion time');
});

test('an explicit Tcl graphic-state pin wins over ambient animation', () => {
  const object = prop(30, {tclGraphicState: 77}), image = imageFixture(), h = harness([object]);
  assert.equal(h.frame(object, image), 77);
  h.at(2000); assert.equal(h.frame(object, image), 77);
});

test('disabling animation settles walking and consumes gestures until explicitly re-enabled', () => {
  const object = prop(30, {gesture: 'wave', gestureSeq: 1}), image = imageFixture(), h = harness([object]);
  assert.equal(h.frame(object, image), 90);
  h.renderer.motions.set(30, {from: [0, 0, 0], to: [100, 0, 0], start: 1000, duration: 1000});
  h.renderer.setPreferences({animation: false});
  assert.equal(h.renderer.motions.size, 0);
  const frozen = h.frame(object, image);
  h.at(2000); assert.equal(h.frame(object, image), frozen);
  const newer = {...object, fields: {...object.fields, gestureSeq: 2}};
  assert.ok(![90, 91].includes(h.frame(newer, image)), 'new gestures stay still while animation is disabled');
  h.renderer.setPreferences({animation: true});
  assert.ok(![90, 91].includes(h.frame(newer, image)), 'enabling does not replay a gesture received while disabled');
  const latest = {...newer, fields: {...newer.fields, gestureSeq: 3}};
  assert.equal(h.frame(latest, image), 90, 'a subsequent gesture still plays normally');
});

test('the browser redraws between native poses only during walking and throttles static scenes', t => {
  const priorRaf = globalThis.requestAnimationFrame, priorCancel = globalThis.cancelAnimationFrame;
  let rafId = 0;
  globalThis.requestAnimationFrame = () => ++rafId;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    if (priorRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = priorRaf;
    if (priorCancel === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = priorCancel;
  });
  const canvas = {getContext: () => ({}), addEventListener() {}, removeEventListener() {}};
  const renderer = new WorldRenderer(canvas);
  let draws = 0;
  renderer.draw = () => draws++;
  renderer.motions.set(30,{from:[0,0,0],to:[100,0,0],start:0,duration:1000});
  renderer.animate(16); renderer.animate(32); renderer.animate(48);
  assert.equal(draws, 3, 'position interpolation redraws at browser refresh cadence');
  renderer.motions.clear(); draws = 0;
  renderer.animate(64); renderer.animate(80); renderer.animate(96);
  assert.equal(draws, 0, 'ambient sprite animation needs no extra redraws between native poses');
  renderer.animate(224); assert.equal(draws, 1);
  renderer.setPreferences({animation: false}); draws = 0;
  renderer.animate(240); renderer.animate(256); renderer.animate(272);
  assert.equal(draws, 0, 'disabled animation also keeps the native redraw throttle');
  renderer.animate(400); assert.equal(draws, 1);
  renderer.destroy();
});

function exitScene({ghost = false} = {}) {
  const room = {...region, fields: {...region.fields, name: 'Old region'}};
  const avatar = {noid: 16, classNumber: ghost ? 22 : 21,
    fields: {container_noid: 0, position: [256, 300, 0], orientation: 0}};
  return {...scene([avatar]), worldName: 'Test world', avatar: 'Me', actorNoid: 16,
    region: room, objects: [room, avatar]};
}
function exitDelivery(initial, direction, {success = 0} = {}) {
  const request = {...initial, history: [...initial.history,
    {seq: 2, type: 'request', noid: 0, id: 103, fields: {exitDir: direction}}]};
  const accepted = {...request, history: [...request.history,
    {seq: 3, type: 'message', noid: 0, id: 70, requestId: 103, requestSeq: 2, fields: {success}}]};
  const room = {...region, fields: {...region.fields, name: 'New region'}};
  const arrival = {...accepted, region: room, objects: [room, {...initial.objects[1], noid: 45}], actorNoid: 45,
    history: [...accepted.history, {seq: 5, type: 'message', id: 101, noid: 0, fields: {}}]};
  return {request, accepted, arrival};
}

test('accepted physical exits walk through each compass edge before displaying the new region', () => {
  const edges = [[256, 512, 0], [612, 300, 0], [256, -100, 0], [-100, 300, 0]];
  for (let direction = 0; direction < 4; direction++) {
    const initial = exitScene(), h = harness(initial.objects), states = exitDelivery(initial, direction);
    h.renderer.setState(initial);
    h.renderer.setState(states.request);
    h.renderer.setState(states.accepted);
    // Real delivery may remove the departing actor before the new HereIs.
    h.renderer.setState({...states.accepted, objects: [initial.region],
      history: [...states.accepted.history, {seq: 4, type: 'message', noid: 16, id: 68, fields: {}}]});
    h.renderer.setState(states.arrival);
    assert.equal(h.renderer.transitioning, true);
    assert.equal(h.renderer.state.region.fields.name, 'Old region');
    const motion = h.renderer.motions.get(16);
    assert.deepEqual(motion.to, edges[direction]);
    assert.equal(motion.orientation, [2, 1, 0, 3][direction]);
    const image = imageFixture();
    h.frame(initial.objects[1], image);
    assert.ok(image.calls.some(call => call.names.some(name => name.includes('stand_to_walk'))), 'uses the native walking choreography');
    h.at(motion.start + motion.duration);
    h.renderer.finishDeparture();
    assert.equal(h.renderer.transitioning, false);
    assert.equal(h.renderer.state.region.fields.name, 'New region');
    assert.equal(h.renderer.state.actorNoid, 45, 'arrival uses the new region-local actor identity');
    h.renderer.setState(structuredClone(states.arrival));
    assert.equal(h.renderer.transitioning, false, 'repeated history never repeats the departure');
  }
});

test('departure retains the newest incoming scene without restarting its stride', () => {
  const initial = exitScene(), h = harness(initial.objects), states = exitDelivery(initial, 1);
  h.renderer.setState(initial); h.renderer.setState(states.request); h.renderer.setState(states.arrival);
  const motion = h.renderer.motions.get(16);
  h.at(1200);
  const newer = structuredClone(states.arrival);
  newer.objects[1].fields.position = [90, 350, 0];
  newer.history.push({seq: 6, type: 'message', noid: 45, id: 1572, fields: {coords: [90, 350, 0]}});
  h.renderer.setState(newer);
  assert.equal(h.renderer.motions.get(16), motion);
  assert.equal(h.renderer.state.region.fields.name, 'Old region');
  h.at(motion.start + motion.duration); h.renderer.finishDeparture();
  assert.deepEqual(h.renderer.state.objects[1].fields.position, [90, 350, 0]);
});

test('a coalesced request, acknowledgement and HereIs still animate departure once', () => {
  const initial = exitScene(), h = harness(initial.objects), {arrival} = exitDelivery(initial, 1);
  h.renderer.setState(initial);
  h.renderer.setState(arrival);
  assert.equal(h.renderer.transitioning, true);
  assert.equal(h.renderer.state.region.fields.name, 'Old region');
  const motion = h.renderer.motions.get(16);
  h.at(motion.start + motion.duration); h.renderer.finishDeparture();
  h.renderer.setState(structuredClone(arrival));
  assert.equal(h.renderer.transitioning, false);
  assert.equal(h.renderer.state.region.fields.name, 'New region');
});

test('an actor removed before HereIs departs from its displayed walking position', () => {
  const initial = exitScene(), h = harness(initial.objects), states = exitDelivery(initial, 1);
  h.renderer.setState(initial);
  const walking = {from: [100, 300, 0], to: [256, 300, 0], start: 1000, duration: 1000};
  h.renderer.motions.set(16, walking);
  h.at(1100); h.renderer.setState(states.request);
  h.at(1200); h.renderer.setState({...states.accepted, objects: [initial.region]});
  assert.equal(h.renderer.motions.has(16), false);
  h.at(1500); h.renderer.setState(states.arrival);
  assert.equal(h.renderer.transitioning, true);
  assert.deepEqual(h.renderer.motions.get(16).from, [178, 300, 0]);
});

test('ghost travel, failed exits, teleports and disabled animation change scenes immediately', () => {
  for (const mode of ['ghost', 'failed', 'teleport', 'disabled']) {
    const initial = exitScene({ghost: mode === 'ghost'}), h = harness(initial.objects);
    h.renderer.setState(initial);
    const states = exitDelivery(initial, 1, {success: mode === 'failed' ? 16 : 0});
    if (mode === 'disabled') h.renderer.setPreferences({animation: false});
    if (mode !== 'teleport') h.renderer.setState(states.request);
    const next = mode === 'teleport' ? {...states.arrival, history: [initial.history[0], states.arrival.history.at(-1)]} : states.arrival;
    h.renderer.setState(next);
    assert.equal(h.renderer.transitioning, false, mode);
    assert.equal(h.renderer.state.region.fields.name, 'New region', mode);
  }
});

test('disconnecting or disabling animation ends a departure without retaining a stale scene', () => {
  for (const reason of ['disconnect', 'disabled', 'other avatar']) {
    const initial = exitScene(), h = harness(initial.objects), states = exitDelivery(initial, 3);
    h.renderer.setState(initial); h.renderer.setState(states.request); h.renderer.setState(states.arrival);
    assert.equal(h.renderer.transitioning, true);
    if (reason === 'disconnect') h.renderer.setState({status: 'disconnected', objects: [], history: []});
    else if (reason === 'disabled') h.renderer.setPreferences({animation: false});
    else h.renderer.setState({...states.arrival, avatar: 'Someone else'});
    assert.equal(h.renderer.transitioning, false, reason);
    assert.equal(h.renderer.state.status, reason === 'disconnect' ? 'disconnected' : 'connected');
    if (reason === 'disabled') assert.equal(h.renderer.state.region.fields.name, 'New region');
  }
});
