import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationRequest, submitRegistration, rememberedConnection, canRegister } from '../../dist/public/registration.js';

const input = { account: 'new.player', password: 'A private password!', confirmation: 'A private password!', avatar: 'New Player', launcherUrl: 'http://127.0.0.1:8080' };

test('browser registration submits one credential POST and excludes password confirmation and privilege fields', async () => {
    const calls = [], state = { status: 'connected', avatar: 'New Player', worldName: 'WorldsAway.app' };
    const result = await submitRegistration({ ...input, role: 'admin', capacity: 8 }, async (path, body) => {
        calls.push({ path, body }); return { created: { account: { name: input.account } }, state };
    });
    assert.deepEqual(calls, [{ path: '/api/register', body: { account: input.account, password: input.password, avatar: input.avatar, launcherUrl: input.launcherUrl } }]);
    assert.equal(result.state, state);
    assert(!JSON.stringify(calls).includes('confirmation'));
});

test('invalid native names, password characters and confirmation errors prevent all registration requests', async () => {
    for (const invalid of [
        { account: 'a'.repeat(25) }, { account: 'Name with spaces' }, { account: 'bad\nname' },
        { password: 'é', confirmation: 'é' }, { password: 'a'.repeat(25), confirmation: 'a'.repeat(25) },
        { confirmation: 'a different password' }, { avatar: 'A'.repeat(30) }, { avatar: '_not-valid' },
        { avatar: 'Create new' }, { avatar: 'bad\nname' },
    ]) {
        let sent = false;
        await assert.rejects(submitRegistration({ ...input, ...invalid }, async () => { sent = true; }));
        assert.equal(sent, false);
    }
});

test('registration accepts the full native name and password limits without silently changing user credentials', () => {
    const boundary = { account: 'A'.repeat(24), password: ' '.repeat(24), confirmation: ' '.repeat(24), avatar: 'A'.repeat(29), launcherUrl: input.launcherUrl };
    assert.deepEqual(registrationRequest(boundary), { account: boundary.account, password: boundary.password, avatar: boundary.avatar, launcherUrl: boundary.launcherUrl });
    assert.equal(registrationRequest({ ...input, account: 'a', password: '!', confirmation: '!', avatar: 'A' }).account, 'a');
});

test('a failed account creation request is never automatically retried', async () => {
    let calls = 0;
    await assert.rejects(submitRegistration(input, async () => { calls++; throw new Error('Account already exists'); }), /already exists/);
    assert.equal(calls, 1);
});

test('remembered connection choices cannot retain passwords, confirmations, native tickets or session IDs', () => {
    const saved = rememberedConnection({ ...input, world: 'WorldsAway.app', token: 'private-ticket', sessionId: 'private-session' });
    assert.deepEqual(saved, { account: input.account, world: 'WorldsAway.app', launcherUrl: input.launcherUrl });
    assert(!JSON.stringify(saved).includes('private'));
});

test('registration is available for the configured hosted WorldsAway backend and never for AltAway', () => {
    const config = { hosted: true, backendName: 'WorldsAway.app', launcherUrl: 'https://world.example', registrationEnabled: true };
    assert.equal(canRegister(config, 'WorldsAway.app', config.launcherUrl), true);
    assert.equal(canRegister({ ...config, registrationEnabled: false }, 'WorldsAway.app', config.launcherUrl), false);
    assert.equal(canRegister({ ...config, hosted: false, registrationEnabled: false }, 'WorldsAway.app', config.launcherUrl + '/'), false);
    assert.equal(canRegister({ ...config, hosted: false }, 'AltAway', 'https://altaway.xyz/'), false);
    assert.equal(canRegister({ ...config, hosted: false, registrationEnabled: false }, 'WorldsAway.app', 'http://127.0.0.1:8180'), true);
});
