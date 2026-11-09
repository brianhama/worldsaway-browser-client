import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldRenderer, activePresentationSpeech} from '../../dist/public/renderer.js';

const region = {noid: 0, classNumber: 20, fields: {horizon: 70}};
const avatar = (extra = {}) => ({noid: 15, classNumber: 21, fields: {
  name: 'Alice', container_noid: 0, position: [200, 300, 0], ...extra,
}});
const nativeQuipKey = 'o.quips1.img@0#131076';

function harness({speaker = avatar(), width = 512} = {}) {
  const calls = [], loaded = [], layouts = [], nativeStates = [], surfaces = [];
  const context = new Proxy({
    measureText: text => ({width: text.length * 6}),
  }, {get(target, key) {
    return target[key] ?? ((...args) => calls.push({name: key, args, color: target.fillStyle}));
  }});
  const renderer = Object.create(WorldRenderer.prototype);
  Object.assign(renderer, {
    canvas: {width, height: 288}, context, width, height: 288, destroyed: false,
    state: {status: 'connected', region, objects: [region, speaker], history: [], viewport: {width, height: 288}},
    bounds: [], hitRegions: [], preferences: {names: false}, motions: new Map(), assets: new Map(),
    conversationQuip: null,
    onLayout(bounds, measuredWidth) { layouts.push({bounds: [...bounds], width: measuredWidth}); },
    drawObject(object) {
      if (object === region) return null;
      const bound = {object, x: object.fields.position[0] - 12, y: 100, width: 24, height: 60};
      this.bounds.push(bound);
      this.hitRegions.push(bound);
      return bound;
    },
    load(name, version, resourceId) {
      loaded.push({name, version, resourceId});
      this.assets.set(`${name}@${version}#${resourceId}`, null);
      return Promise.resolve(null);
    },
    surface(image, index, map, fixedPalette) {
      surfaces.push({index, map, fixedPalette});
      const surface = {width: index === 0 ? 11 : 12, height: index === 0 ? 36 : 38};
      return surface;
    },
  });
  const nativeImage = {
    namedStates: [{name: 'talkdown'}, {name: 'thinkdow'}], cels: [{}, {}],
    choreography(_names, state) { nativeStates.push(state); return [state]; },
    frameFor(state) {
      return {width: state === 0 ? 11 : 12, height: state === 0 ? 36 : 38,
        parts: [{cel: state, x: 0, y: 0, flags: 0}]};
    },
  };
  return {renderer, speaker, calls, loaded, layouts, nativeImage, nativeStates, surfaces};
}

test('room messages, thoughts, status replies, and presentation text stay out of the scene canvas', () => {
  const h = harness({speaker: avatar({presentationSpeech: {text: 'Script text', until: Date.now() + 10000}})});
  h.renderer.state.history = [
    {id: 73, noid: 15, requestId: 72, fields: {success: 0, speaker: 15, type: 0, text: 'Spoken text'}},
    {id: 74, noid: 15, fields: {speaker: 15, type: 1, text: 'Thought text'}},
    {id: 73, noid: 15, requestId: 1916, fields: {success: 0, speaker: 15, text: 'Status text'}},
  ];
  h.renderer.draw();
  assert.deepEqual(h.calls.filter(call => call.name === 'fillText'), []);
  assert.equal(activePresentationSpeech(h.speaker), 'Script text', 'presentation text remains available to the conversation pane');
  assert.deepEqual(h.loaded, [], 'ordinary canvas rendering does not load quip art without a current message');
});

test('speech and thought quips use distinct native art at the transcript boundary', () => {
  const h = harness();
  h.renderer.assets.set(nativeQuipKey, h.nativeImage);
  for (const type of [0, 1]) {
    h.calls.length = 0;
    h.renderer.setConversationQuip({speakerNoid: 15, type, until: Date.now() + 10000});
    assert.equal(h.nativeStates.at(-1), type);
    assert.equal(h.surfaces.at(-1).index, type);
    assert.deepEqual(h.surfaces.at(-1).map, Array(16).fill(6), 'native customizable colors match transcript green');
    assert.equal(h.surfaces.at(-1).fixedPalette, true, 'region lighting cannot change transcript green');
    const translation = h.calls.find(call => call.name === 'translate').args;
    assert.deepEqual(translation, [Math.round(200 - (type === 0 ? 11 : 12) / 2), 0]);
    assert.equal(h.calls.filter(call => call.name === 'drawImage').length, 1);
    assert.equal(h.renderer.hitTest(200, 10), null, 'the decorative pointer creates no world hit region');
  }
});

test('pending and failed quip artwork keep distinct green speech and thought pointers', () => {
  const h = harness();
  h.renderer.setConversationQuip({speakerNoid: 15, type: 0, until: Date.now() + 10000});
  assert.deepEqual(h.loaded, [{name: 'o.quips1.img', version: 0, resourceId: 0x20004}]);
  assert.ok(h.calls.some(call => call.name === 'lineTo' && call.args[1] > 0));
  assert.ok(h.calls.some(call => call.name === 'fill' && call.color === '#009f00'));
  assert.equal(h.calls.some(call => call.name === 'arc'), false);

  h.renderer.assets.set(nativeQuipKey, {error: 'Unavailable'});
  h.calls.length = 0;
  h.renderer.setConversationQuip({speakerNoid: 15, type: 1, until: Date.now() + 10000});
  assert.equal(h.calls.filter(call => call.name === 'arc').length, 3);
  assert.equal(h.calls.some(call => call.name === 'lineTo'), false);
  assert.ok(h.calls.some(call => call.name === 'fill' && call.color === '#009f00'));
  assert.equal(h.loaded.length, 1, 'failed art does not start repeated downloads');
});

test('quip placement follows displayed avatar bounds and reports each layout for the conversation pane', () => {
  const h = harness();
  h.renderer.assets.set(nativeQuipKey, h.nativeImage);
  h.renderer.setConversationQuip({speakerNoid: 15, type: 0, until: Date.now() + 10000});
  h.speaker.fields.position[0] = 350;
  h.calls.length = 0;
  h.renderer.draw();
  assert.deepEqual(h.calls.find(call => call.name === 'translate').args, [345, 0]);
  assert.equal(h.layouts.at(-1).width, 512);
  assert.equal(h.layouts.at(-1).bounds[0].x + h.layouts.at(-1).bounds[0].width / 2, 350);
});

test('pending and unavailable avatar artwork retains bounds for speech and quip placement', () => {
  for (const asset of [null, {error: 'Unavailable'}]) {
    const h = harness({speaker: avatar({imageURL: 'missing.img'})});
    h.renderer.drawObject = WorldRenderer.prototype.drawObject;
    h.renderer.assets.set('missing.img@0#0', asset);
    h.renderer.assets.set(nativeQuipKey, h.nativeImage);
    h.renderer.setConversationQuip({speakerNoid: 15, type: 0, until: Date.now() + 10000});
    const bound = h.layouts.at(-1).bounds.find(item => item.object.noid === 15);
    assert.ok(bound, 'the conversation pane receives the selectable fallback avatar');
    assert.equal(bound.x + bound.width / 2, 200);
    assert.deepEqual(h.calls.find(call => call.name === 'translate').args, [195, 0]);
    h.speaker.fields.position[0] = 300;
    h.calls.length = 0;
    h.renderer.draw();
    const moved = h.layouts.at(-1).bounds.find(item => item.object.noid === 15);
    assert.equal(moved.x + moved.width / 2, 300);
    assert.deepEqual(h.calls.find(call => call.name === 'translate').args, [295, 0]);
  }
});

test('expired, absent, hidden, and disconnected speakers have no active quip', () => {
  for (const mode of ['expired', 'absent', 'hidden', 'disconnected']) {
    const h = harness();
    h.renderer.assets.set(nativeQuipKey, h.nativeImage);
    if (mode === 'absent') h.renderer.state.objects = [region];
    if (mode === 'hidden') h.speaker.fields.common_flags = 1;
    if (mode === 'disconnected') h.renderer.state.status = 'disconnected';
    h.renderer.setConversationQuip({speakerNoid: 15, type: 0, until: Date.now() + (mode === 'expired' ? -1 : 10000)});
    assert.deepEqual(h.nativeStates, [], mode);
    assert.equal(h.calls.some(call => ['arc', 'lineTo', 'drawImage'].includes(call.name)), false, mode);
  }
});

test('a current conversation quip suppresses the native object fourteen without adding a clickable duplicate', () => {
  const h = harness();
  h.renderer.state.objects.push({noid: 14, classNumber: 23, fields: {position: [0, 0, 288]}});
  h.renderer.setConversationQuip({speakerNoid: 15, type: 0, until: Date.now() + 10000});
  assert.deepEqual(h.renderer.bounds.map(bound => bound.object.noid), [15]);
  assert.deepEqual(h.renderer.hitRegions.map(bound => bound.object.noid), [15]);
  h.renderer.setConversationQuip(null);
  assert.deepEqual(h.renderer.bounds.map(bound => bound.object.noid).sort((a, b) => a - b), [14, 15]);
});
