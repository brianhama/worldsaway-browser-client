import type { WorldState, WorldObject, ActionDescriptor } from './types.js';
/** Strict receiver selection for the recovered request catalog. */
function noid(value: unknown) {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string' && !/^\d+$/.test(value))
        return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 65535 ? number : null;
}
function classNumber(object: WorldObject | null | undefined) {
    const value = object?.classNumber ?? object?.fields?.classNumber;
    return value === null || value === undefined ? null : noid(value);
}
// Region 0 may appear both in objects and as state.region. Deduplicate its
// wire identity before evaluating receiver compatibility.
function objectsIn(state: WorldState) {
    const objects: WorldObject[] = [], seen = new Set();
    for (const object of [...(state?.objects ?? []), state?.region]) {
        const id = noid(object?.noid);
        if (!object || id === null || seen.has(id))
            continue;
        seen.add(id);
        objects.push(object);
    }
    return objects;
}
/** Apply both class compatibility and the request's actor/region/selection scope. */
export function compatibleTargets(action: ActionDescriptor | null | undefined, state: WorldState) {
    if (!action || !Array.isArray(action.classes))
        return [];
    const classes = new Set(action.classes.map(noid).filter((value: unknown) => value !== null));
    const objects = objectsIn(state), matches = (object: WorldObject | null | undefined) => classes.has(classNumber(object));
    if (action.receiver === 'region')
        return classes.has(20) ? objects.filter((object: WorldObject) => noid(object.noid) === 0 && classNumber(object) === 20) : [];
    if (action.receiver === 'actor') {
        const own = noid(state?.actorNoid);
        return own !== null && own > 0 ? objects.filter((object: WorldObject) => noid(object.noid) === own && matches(object)) : [];
    }
    return objects.filter(matches);
}
/** An explicit incompatible target is an error; it never redirects a request. */
export function selectActionTarget(action: ActionDescriptor | null | undefined, state: WorldState, selectedNoid: unknown, explicitNoid?: unknown) {
    const candidates = compatibleTargets(action, state);
    if (explicitNoid !== undefined && explicitNoid !== null) {
        const id = noid(explicitNoid);
        return id === null ? null : candidates.find((object: WorldObject) => noid(object.noid) === id) ?? null;
    }
    // An implicit selection may use a unique candidate; multiple matches require
    // a choice instead of silently operating on an arbitrary object.
    const selected = noid(selectedNoid);
    return (selected === null ? null : candidates.find((object: WorldObject) => noid(object.noid) === selected)) ?? (candidates.length === 1 ? candidates[0] : null);
}
/** The server may send a synthesized own-avatar label before its real name. */
export function displaySelfName(state: WorldState) {
    const own = noid(state?.actorNoid);
    const self = own !== null && own > 0 ? objectsIn(state).find((object: WorldObject) => noid(object.noid) === own) : null;
    const name = self?.fields?.name;
    const synthetic = typeof name !== 'string' || !name.trim() || /^Avatar \d+$/.test(name);
    return synthetic && typeof state?.avatar === 'string' && state.avatar.length ? state.avatar : name ?? self?.name ?? state?.avatar ?? '';
}
/** Preserve input identity unless the own actor needs the login name projected. */
export function withPlayerName(state: WorldState) {
    if (!state || !Array.isArray(state.objects))
        return state;
    const own = noid(state.actorNoid);
    if (own === null || own <= 0)
        return state;
    const index = state.objects.findIndex((object: WorldObject) => noid(object?.noid) === own);
    if (index < 0)
        return state;
    const self = state.objects[index], name = displaySelfName(state);
    if (!name || self.fields?.name === name)
        return state;
    const objects = [...state.objects];
    objects[index] = { ...self, fields: { ...self.fields, name } };
    return { ...state, objects };
}
