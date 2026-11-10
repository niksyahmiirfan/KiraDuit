import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import {
  createSession, verifySession, readCookie, lockState, authenticate, login, logout,
  SESSION_SECONDS, MAX_FAILURES, LOCK_SECONDS,
} from '../src/auth.js';

// Workers provide this; Node does not.
crypto.subtle.timingSafeEqual ??= (a, b) => nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Just enough of D1 for the auth_failures statements.
function fakeEnv(token = 'correct-key') {
  const rows = new Map();
  const run = (sql, args) => {
    if (sql.startsWith('DELETE FROM auth_failures WHERE window_start')) {
      for (const [k, v] of rows) if (v.window_start <= args[0]) rows.delete(k);
    } else if (sql.startsWith('DELETE FROM auth_failures WHERE client')) {
      rows.delete(args[0]);
    } else if (sql.startsWith('INSERT INTO auth_failures')) {
      const [client, now, cutoff] = args;
      const row = rows.get(client);
      if (!row) rows.set(client, { count: 1, window_start: now });
      else if (row.window_start <= cutoff) rows.set(client, { count: 1, window_start: now });
      else row.count += 1;
    }
  };
  const prepare = (sql) => ({
    bind: (...args) => ({
      first: async () => rows.get(args[0]) ?? null,
      run: async () => run(sql, args),
      _run: () => run(sql, args),
    }),
  });
  return { API_TOKEN: token, DB: { prepare, batch: async (stmts) => stmts.forEach((s) => s._run()) }, rows };
}

const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  new Request(`https://kira.test${path}`, { method, headers: { 'cf-connecting-ip': '1.2.3.4', ...headers }, body });
const bearer = (key) => ({ authorization: `Bearer ${key}` });
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

test('session tokens verify, expire, and reject tampering or a different secret', async () => {
  const now = Date.now();
  const token = await createSession('secret', now);
  assert.equal(await verifySession('secret', token, now), true);
  assert.equal(await verifySession('other-secret', token, now), false);
  assert.equal(await verifySession('secret', token, now + (SESSION_SECONDS + 1) * 1000), false);
  const [exp, nonce, sig] = token.split('.');
  assert.equal(await verifySession('secret', `${Number(exp) + 999}.${nonce}.${sig}`, now), false);
  assert.equal(await verifySession('secret', `${exp}.${nonce}.${'0'.repeat(64)}`, now), false);
  assert.equal(await verifySession('secret', 'garbage', now), false);
  assert.equal(await verifySession('secret', undefined, now), false);
  assert.equal(await verifySession('', token, now), false);
});

test('readCookie finds the named cookie among several', () => {
  const r = call('/', { headers: { cookie: 'a=1; kd_session=abc.def; b=2' } });
  assert.equal(readCookie(r, 'kd_session'), 'abc.def');
  assert.equal(readCookie(r, 'missing'), null);
});

test('lockState locks after the limit and unlocks when the window passes', () => {
  const start = 1000;
  assert.equal(lockState(null, start).locked, false);
  assert.equal(lockState({ count: MAX_FAILURES - 1, window_start: start }, start + 1).locked, false);
  const locked = lockState({ count: MAX_FAILURES, window_start: start }, start + 60);
  assert.equal(locked.locked, true);
  assert.equal(locked.retryAfter, LOCK_SECONDS - 60);
  assert.equal(lockState({ count: MAX_FAILURES, window_start: start }, start + LOCK_SECONDS).locked, false);
});

test('Bearer key works for shortcuts; wrong or missing key does not', async () => {
  const env = fakeEnv();
  assert.deepEqual(await authenticate(call('/api/home', { headers: bearer('correct-key') }), env), { ok: true });
  assert.equal((await authenticate(call('/api/home', { headers: bearer('nope') }), env)).status, 401);
  assert.equal((await authenticate(call('/api/home'), env)).status, 401);
  assert.equal((await authenticate(call('/api/home', { headers: bearer('x') }), fakeEnv(''))).ok, false);
});

test('no credentials at all is not counted as a failed guess', async () => {
  const env = fakeEnv();
  for (let i = 0; i < 10; i++) await authenticate(call('/api/home'), env);
  assert.equal(env.rows.size, 0);
});

test('the sixth wrong Bearer key is blocked, even if it is correct', async () => {
  const env = fakeEnv();
  for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await authenticate(call('/api/home', { headers: bearer(`guess${i}`) }), env)).status, 401);
  const blocked = await authenticate(call('/api/home', { headers: bearer('correct-key') }), env);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.retryAfter > 0);
  // A different client is unaffected.
  const other = call('/api/home', { headers: { ...bearer('correct-key'), 'cf-connecting-ip': '9.9.9.9' } });
  assert.equal((await authenticate(other, env)).ok, true);
});

test('login sets an HttpOnly, SameSite=Strict cookie that then authenticates', async () => {
  const env = fakeEnv();
  const res = await login(call('/api/login', { method: 'POST', body: JSON.stringify({ key: '  correct-key ' }) }), env, true);
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  const cookie = cookieOf(res);
  assert.deepEqual(await authenticate(call('/api/home', { headers: { cookie } }), env), { ok: true });
});

test('cookie sessions need the custom header for writes', async () => {
  const env = fakeEnv();
  const cookie = cookieOf(await login(call('/api/login', { method: 'POST', body: JSON.stringify({ key: 'correct-key' }) }), env, true));
  assert.equal((await authenticate(call('/api/transactions', { method: 'POST', headers: { cookie }, body: '{}' }), env)).status, 403);
  assert.equal((await authenticate(call('/api/transactions', { method: 'POST', headers: { cookie, 'x-requested-with': 'kiraduit' }, body: '{}' }), env)).ok, true);
  assert.equal((await authenticate(call('/api/transactions/abc', { method: 'DELETE', headers: { cookie } }), env)).status, 403);
});

test('rotating API_TOKEN signs out existing cookies', async () => {
  const env = fakeEnv();
  const cookie = cookieOf(await login(call('/api/login', { method: 'POST', body: JSON.stringify({ key: 'correct-key' }) }), env, true));
  env.API_TOKEN = 'new-key';
  assert.equal((await authenticate(call('/api/home', { headers: { cookie } }), env)).status, 401);
});

test('login rejects a wrong key, locks after repeated failures, and clears on success', async () => {
  const env = fakeEnv();
  const attempt = (key) => login(call('/api/login', { method: 'POST', body: JSON.stringify({ key }) }), env, true);
  for (let i = 0; i < MAX_FAILURES - 1; i++) assert.equal((await attempt('bad')).status, 401);
  assert.equal((await attempt('correct-key')).status, 200); // success resets the count
  for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await attempt('bad')).status, 401);
  const locked = await attempt('correct-key');
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal(locked.headers.get('set-cookie'), null);
});

test('login rejects malformed bodies without counting them as guesses', async () => {
  const env = fakeEnv();
  assert.equal((await login(call('/api/login', { method: 'POST', body: 'not json' }), env, true)).status, 401);
  assert.equal((await login(call('/api/login', { method: 'POST', body: JSON.stringify({}) }), env, true)).status, 401);
  assert.equal(env.rows.size, 0);
});

test('the throttle stores a hash, never the raw address', async () => {
  const env = fakeEnv();
  await authenticate(call('/api/home', { headers: bearer('bad') }), env);
  const [client] = [...env.rows.keys()];
  assert.match(client, /^[0-9a-f]{32}$/);
  assert.ok(!client.includes('1.2.3.4'));
});

test('logout expires the cookie', () => {
  const setCookie = logout(true).headers.get('set-cookie');
  assert.match(setCookie, /kd_session=;/);
  assert.match(setCookie, /Max-Age=0/);
});
