/** Browser login choices; hosted mode re-resolves untrusted destinations in the bridge. */
export interface LoginInput {
    mode?: string;
    connectionFile?: string;
    launcherUrl?: string;
    world?: string;
    loginUrl?: string;
    tunnel?: boolean;
    [key: string]: unknown;
}
interface WorldDirectoryEntry {
    name?: string;
    flags?: string;
    loginUrl?: string;
}
import type {} from './types.js';
/** Same-origin bridge requests. Never automatically repeat a credential POST. */
export async function bridgeRequest(path: string, data?: any, fetchRequest = globalThis.fetch) {
    const directory = data === undefined && path.startsWith('/api/worlds?');
    for (let attempt = 0;; attempt++) {
        let response;
        try {
            response = await fetchRequest(path, { credentials: 'same-origin', priority: 'high', ...(data !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}) });
        }
        catch (error: any) {
            throw new Error('Could not reach the browser bridge. Check that it is running at this browser address, then try again.', { cause: error });
        }
        let value;
        try {
            value = await response.json();
        }
        catch {
            throw new Error(`The local bridge returned an invalid response (HTTP ${response.status}). Please try again.`);
        }
        if (response.ok)
            return value;
        // Older bridges lose the upstream cause. A directory read is safe to repeat;
        // login and action requests must always remain a single submission.
        const legacyNetworkError = value?.error === 'fetch failed';
        if (directory && legacyNetworkError && attempt === 0)
            continue;
        if (legacyNetworkError && (directory || path === '/api/login'))
            throw new Error(`Could not reach the world's ${directory ? 'directory' : 'login service'}. Please try again.`);
        throw new Error(value?.error || `Bridge returned HTTP ${response.status}`);
    }
}
/** Resolve the directory before submitting credentials, with its own safe retry. */
export async function prepareLogin(input: LoginInput, request = bridgeRequest) {
    if (input.mode === 'direct' || input.connectionFile)
        return input;
    const directory = await request(`/api/worlds?url=${encodeURIComponent(input.launcherUrl || 'http://127.0.0.1:8080')}`);
    const worlds: WorldDirectoryEntry[] = directory.worlds ?? [];
    // Preserve an explicit world choice; otherwise prefer a direct entry before
    // falling back to a legacy tunnel entry from the same directory.
    const selected = worlds.find((world) => input.world && world.name === input.world) ?? worlds.find((world) => !String(world.flags ?? '').includes('w')) ?? worlds[0];
    if (!selected?.loginUrl)
        throw new Error('The login service did not return a world directory.');
    return { ...input, loginUrl: selected.loginUrl, tunnel: String(selected.flags ?? '').includes('w') };
}
