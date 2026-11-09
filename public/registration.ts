/** Registration uses one credential POST and retains only non-secret connection choices. */
import { bridgeRequest } from './connection.js';

export interface RegistrationInput {
    account: string;
    password: string;
    confirmation: string;
    avatar: string;
    launcherUrl: string;
}

export function registrationRequest(input: RegistrationInput) {
    const { account, password, confirmation, avatar, launcherUrl } = input;
    if (typeof account !== 'string' || !/^[A-Za-z0-9_.-]{1,24}$/.test(account))
        throw new Error('Account names use 1–24 letters, numbers, dots, underscores or hyphens.');
    if (typeof password !== 'string' || !/^[\x20-\x7e]{1,24}$/.test(password))
        throw new Error('Passwords use 1–24 printable ASCII characters.');
    if (password !== confirmation)
        throw new Error('The passwords do not match.');
    if (typeof avatar !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,28}$/.test(avatar) || avatar.toLowerCase() === 'create new')
        throw new Error('Avatar names use 1–29 letters, numbers, spaces, dots, underscores or hyphens, starting with a letter or number. Choose a name other than “Create new”.');
    return { account, password, avatar, launcherUrl };
}

export async function submitRegistration(input: RegistrationInput, request = bridgeRequest) {
    return request('/api/register', registrationRequest(input));
}

/** Do not spread request objects here: they can also contain passwords or tickets. */
export function rememberedConnection(input: { account?: unknown; world?: unknown; launcherUrl?: unknown }) {
    return { account: typeof input.account === 'string' ? input.account : '',
        world: typeof input.world === 'string' ? input.world : '',
        launcherUrl: typeof input.launcherUrl === 'string' ? input.launcherUrl : '' };
}

export function canRegister(config: { hosted?: boolean; backendName?: string; registrationEnabled?: boolean; launcherUrl?: string },
    service: string, launcherUrl: string): boolean {
    if (service !== 'WorldsAway.app') return false;
    // A local user may select another WorldsAway server; registration is then
    // checked by that server when submitted rather than by unrelated config.
    let sameBackend = launcherUrl === config.launcherUrl;
    try { sameBackend = new URL(launcherUrl).href === new URL(config.launcherUrl ?? '').href; } catch { }
    return Boolean(!config.hosted && config.launcherUrl && !sameBackend) || config.registrationEnabled !== false;
}
