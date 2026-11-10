// Sign-in sessions and failed-attempt throttling.
//
// Shortcuts keep sending the access key as a Bearer token. The web app trades the key for
// an HttpOnly session cookie once, so the key is never kept in the browser where a script
// could read it.

export const SESSION_COOKIE = 'kd_session';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const MAX_FAILURES = 5;
export const LOCK_SECONDS = 15 * 60;

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));

// The signing key is derived from API_TOKEN, so setting a new API_TOKEN signs every browser out.
const hmacKey = (secret, usage) =>
  crypto.subtle.importKey('raw', enc.encode(`kiraduit-session-v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function createSession(secret, nowMs = Date.now()) {
  const expires = Math.floor(nowMs / 1000) + SESSION_SECONDS;
  const payload = `${expires}.${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(payload));
  return `${payload}.${toHex(sig)}`;
}

export async function verifySession(secret, token, nowMs = Date.now()) {
  if (!secret || typeof token !== 'string') return false;
  const m = token.match(/^(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/);
  if (!m || Number(m[1]) <= Math.floor(nowMs / 1000)) return false;
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromHex(m[3]), enc.encode(`${m[1]}.${m[2]}`));
}

export function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const sessionCookie = (value, secure, maxAge = SESSION_SECONDS) =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

export async function checkKey(given, expected) {
  if (!expected) return false;
  const hash = (s) => crypto.subtle.digest('SHA-256', enc.encode(s));
  const [a, b] = await Promise.all([hash(given), hash(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export const bearerKey = (request) => {
  const h = request.headers.get('authorization') || '';
  return /^Bearer\s/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null;
};

/* ---- failed-attempt throttle (one row per client, stored in D1) ---- */

// Only a hash of the address is stored, never the address itself.
export async function clientId(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(`kiraduit-ip:${ip}`))).slice(0, 32);
}

// Pure decision, so the rule can be tested without a database.
export function lockState(row, nowSec) {
  if (!row || nowSec - row.window_start >= LOCK_SECONDS || row.count < MAX_FAILURES) return { locked: false };
  return { locked: true, retryAfter: row.window_start + LOCK_SECONDS - nowSec };
}

export async function throttleStatus(env, id, nowSec = Math.floor(Date.now() / 1000)) {
  try {
    const row = await env.DB.prepare('SELECT count, window_start FROM auth_failures WHERE client = ?').bind(id).first();
    return lockState(row, nowSec);
  } catch (err) {
    // Until schema.sql has been re-run the table is missing; don't lock the owner out of the app.
    console.error('auth_failures unavailable, throttling is off:', err.message);
    return { locked: false };
  }
}

export async function recordFailure(env, id, nowSec = Math.floor(Date.now() / 1000)) {
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_failures WHERE window_start <= ?').bind(nowSec - LOCK_SECONDS),
      env.DB.prepare(
        `INSERT INTO auth_failures (client, count, window_start) VALUES (?, 1, ?)
         ON CONFLICT (client) DO UPDATE SET
           count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END`,
      ).bind(id, nowSec, nowSec - LOCK_SECONDS, nowSec - LOCK_SECONDS, nowSec),
    ]);
  } catch (err) {
    console.error('auth_failures unavailable, throttling is off:', err.message);
  }
}

export async function clearFailures(env, id) {
  try { await env.DB.prepare('DELETE FROM auth_failures WHERE client = ?').bind(id).run(); } catch { /* table not created yet */ }
}

/* ---- request authentication ---- */

// Returns { ok: true } or { ok: false, status, message, retryAfter? }.
export async function authenticate(request, env) {
  if (!env.API_TOKEN) return { ok: false, status: 401, message: 'Invalid access key.' };

  // A valid session cookie needs no further check. SameSite=Strict stops other sites from sending it,
  // and requiring this header on writes means a cross-site form cannot either.
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie && (await verifySession(env.API_TOKEN, cookie))) {
    const writes = !['GET', 'HEAD'].includes(request.method);
    if (writes && request.headers.get('x-requested-with') !== 'kiraduit') {
      return { ok: false, status: 403, message: 'Request blocked.' };
    }
    return { ok: true };
  }

  const given = bearerKey(request);
  if (given === null) return { ok: false, status: 401, message: 'Invalid access key.' };

  const id = await clientId(request);
  const state = await throttleStatus(env, id);
  if (state.locked) return { ok: false, status: 429, message: 'Too many wrong keys. Try again later.', retryAfter: state.retryAfter };
  if (await checkKey(given, env.API_TOKEN)) return { ok: true };
  await recordFailure(env, id);
  return { ok: false, status: 401, message: 'Invalid access key.' };
}

export async function login(request, env, secure) {
  const reply = (body, status, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
  const body = await request.json().catch(() => null);
  const given = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!env.API_TOKEN || !given) return reply({ error: 'That access key was not accepted.' }, 401);

  const id = await clientId(request);
  const state = await throttleStatus(env, id);
  if (state.locked) {
    return reply({ error: `Too many wrong keys. Try again in ${Math.ceil(state.retryAfter / 60)} minutes.` }, 429, { 'retry-after': String(state.retryAfter) });
  }
  if (!(await checkKey(given, env.API_TOKEN))) {
    await recordFailure(env, id);
    return reply({ error: 'That access key was not accepted.' }, 401);
  }
  await clearFailures(env, id);
  return reply({ ok: true }, 200, { 'set-cookie': sessionCookie(await createSession(env.API_TOKEN), secure) });
}

export const logout = (secure) =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': sessionCookie('', secure, 0) },
  });
