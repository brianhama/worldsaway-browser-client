import test from 'node:test';
import assert from 'node:assert/strict';
import { RegionEntryTracker } from '../../dist/public/region-entry.js';

const hereIs = seq => ({ type: 'message', id: 101, noid: 0, seq });
const snapshot = (name = 'Outside The Rose', seq = 10, extra = {}) => ({
    status: 'connected', worldName: 'WorldsAway.app', avatar: 'RiverFork',
    region: { noid: 0, classNumber: 20, fields: { name } },
    history: [hereIs(seq)], ...extra,
});

test('each region delivery announces its name as a system message, including repeated names', () => {
    const tracker = new RegionEntryTracker();
    assert.deepEqual(tracker.ingest(snapshot()).message,
        { kind: 'system', author: 'World', text: 'You arrived in Outside The Rose.' });
    assert.equal(tracker.ingest(snapshot()).message, null);
    assert.equal(tracker.ingest(snapshot('The Rose', 20)).message.text, 'You arrived in The Rose.');
    assert.equal(tracker.ingest(snapshot('The Rose', 30, { history: [
        { type: 'message', id: 70, requestId: 103, seq: 25, fields: { success: 0 } }, hereIs(30),
    ] })).message.text, 'You arrived in The Rose.');
});

test('peer materialization refreshes the scene without announcing arrival again', () => {
    const tracker = new RegionEntryTracker(), first = tracker.ingest(snapshot());
    const materialized = snapshot(undefined, 20, { objects: [
        { noid: 25, classNumber: 21, fields: { name: 'Visitor', position: [100, 200, 0] } },
    ] });
    const refreshed = tracker.ingest(materialized);
    assert.notEqual(refreshed.scene, first.scene, 'HereIs still resets scene presentation');
    assert.equal(refreshed.message, null);
    assert.equal(tracker.ingest(materialized).message, null);
    assert.equal(tracker.ingest(snapshot(undefined, 30, { history: [
        { type: 'message', id: 70, requestId: 103, seq: 25, fields: { success: 16 } }, hereIs(30),
    ] })).message, null, 'failed exit does not turn a refresh into travel');
});

test('successful same-signature travel announces once and old acknowledgements do not repeat', () => {
    const tracker = new RegionEntryTracker();
    tracker.ingest(snapshot());
    const acknowledgement = { type: 'message', id: 70, requestId: 103, seq: 15, fields: { success: 0 } };
    const destination = snapshot(undefined, 20, { history: [acknowledgement, hereIs(20)] });
    assert.equal(tracker.ingest(destination).message.text, 'You arrived in Outside The Rose.');
    assert.equal(tracker.ingest(destination).message, null);
    assert.equal(tracker.ingest(snapshot(undefined, 30, { history: [acknowledgement, hereIs(30)] })).message, null);
});

test('ordinary snapshots, SSE replay, and history eviction do not repeat arrival messages', () => {
    const tracker = new RegionEntryTracker(), first = tracker.ingest(snapshot());
    for (const next of [snapshot(), snapshot(undefined, 10, { history: [] }), snapshot(undefined, 9)]) {
        const result = tracker.ingest(next);
        assert.equal(result.scene, first.scene);
        assert.equal(result.message, null);
    }
    assert.equal(tracker.ingest(snapshot('Garden', 40)).message.text, 'You arrived in Garden.');
});

test('offline retained objects do not announce, and reentry or changed player context does', () => {
    const tracker = new RegionEntryTracker();
    assert.equal(tracker.ingest(snapshot(undefined, 10, { status: 'entering' })).message, null);
    assert.ok(tracker.ingest(snapshot()).message);
    assert.equal(tracker.ingest(snapshot(undefined, 10, { status: 'disconnected' })).message, null);
    assert.ok(tracker.ingest(snapshot()).message);
    assert.ok(tracker.ingest(snapshot(undefined, 10, { avatar: 'Other avatar' })).message);
    tracker.reset();
    assert.ok(tracker.ingest(snapshot()).message);
});

test('a delayed region name is announced once without a synthetic object label', () => {
    const tracker = new RegionEntryTracker();
    const initial = tracker.ingest(snapshot(undefined, 10, { region: null }));
    assert.equal(initial.message, null);
    const named = tracker.ingest(snapshot());
    assert.equal(named.scene, initial.scene);
    assert.equal(named.message.text, 'You arrived in Outside The Rose.');
    assert.equal(tracker.ingest(snapshot('Renamed region')).message, null);
    const fallback = new RegionEntryTracker();
    assert.equal(fallback.ingest(snapshot(undefined, 10, { region: null,
        objects: [{ noid: 0, fields: { name: 'Garden' } }] })).message.text, 'You arrived in Garden.');
});
