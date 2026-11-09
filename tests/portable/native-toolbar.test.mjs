import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeToolbarTurn } from '../../dist/public/native-toolbar.js';

function world(orientation = 0) {
    return { status: 'connected', actorNoid: 16, objects: [
        { noid: 0, classNumber: 20 },
        { noid: 16, classNumber: 21, fields: { orientation, container_noid: 0 } },
    ] };
}

test('Windows turn controls send relative facing in all four native orientations', () => {
    for (let facing = 0; facing < 4; facing++) {
        for (const [turn, delta] of [['left', 1], ['right', -1], ['around', 2]]) {
            const state = world(facing);
            assert.deepEqual(nativeToolbarTurn(state, turn), {
                id: 1688, noid: 16, fields: { facing: (facing + delta + 4) % 4 },
            });
            assert.equal(state.objects[1].fields.orientation, facing, 'wait for server acknowledgement before changing facing');
        }
    }
});

test('turning refuses ghosts, seated or blocked actors, and unavailable facing data', () => {
    const seated = world();
    seated.objects.push({ noid: 40, classNumber: 53 });
    seated.objects[1].fields.container_noid = 40;
    const ghost = world(); ghost.objects[1].classNumber = 22;
    const missing = world(); delete missing.objects[1].fields.orientation;
    for (const state of [seated, ghost, missing, world(4), world(-1), world(0.5),
        { ...world(), status: 'disconnected' }, { ...world(), actorNoid: 99 },
        { ...world(), tcl: { blockCount: 1 } }])
        assert.equal(nativeToolbarTurn(state, 'left'), null);
    assert.equal(nativeToolbarTurn(world(), 'unknown'), null);
});
