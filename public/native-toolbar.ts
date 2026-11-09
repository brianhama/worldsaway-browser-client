import type { ActionRequest, WorldState } from './types.js';
import { objectClass, objectParent } from './model.js';

/** Windows toolbar turns use command 1687 (00050612.tcl), which derives a
 * relative facing and sends 1688. Left adds one, right subtracts one, and
 * around adds two. Seated avatars cannot turn. */
export function nativeToolbarTurn(state: WorldState, turn: string): ActionRequest | null {
    const actor = state.objects?.find(object => Number(object.noid) === Number(state.actorNoid));
    const delta = ({ left: 1, right: -1, around: 2 } as Record<string, number>)[turn];
    const facing = Number(actor?.fields?.orientation);
    const parent = state.objects?.find(object => Number(object.noid) === objectParent(actor));
    if (state.status !== 'connected' || Number(state.tcl?.blockCount) > 0 || objectClass(actor) !== 21
        || objectClass(parent) === 53 || delta === undefined || !Number.isInteger(facing) || facing < 0 || facing > 3)
        return null;
    return { id: 1688, noid: Number(actor!.noid), fields: { facing: (facing + delta + 4) % 4 } };
}
