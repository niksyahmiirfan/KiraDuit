import { parseMoney, parseReceipt, guessCategory, merchantKey } from './parse.js';
import { CATEGORIES, formatRM, localDate, reportText, summarize, weekDates, windowStart } from '../public/summary.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const text = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

async function authorized(request, env) {
  if (!env.API_TOKEN) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const hash = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([hash(given), hash(env.API_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function categoryFor(env, merchant) {
  const saved = await env.DB.prepare('SELECT category FROM merchant_categories WHERE merchant_key = ?')
    .bind(merchantKey(merchant)).first();
  return saved?.category || guessCategory(merchant);
}

async function insert(env, t) {
  const now = t.occurred_at ? new Date(t.occurred_at) : new Date();
  const row = {
    id: crypto.randomUUID(),
    occurred_at: now.toISOString(),
    local_date: localDate(now),
    card: null, reference: null, raw_text: null, needs_review: 0,
    ...t,
    category: t.category || (await categoryFor(env, t.merchant)),
  };
  row.occurred_at = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO transactions (id, amount_sen, merchant, category, source, card, occurred_at, local_date, needs_review, reference, raw_text)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(row.id, row.amount_sen, row.merchant, row.category, row.source, row.card, row.occurred_at,
    row.local_date, row.needs_review, row.reference, row.raw_text).run();
  return row;
}

async function isDuplicate(env, t) {
  if (t.reference) {
    const hit = await env.DB.prepare('SELECT id FROM transactions WHERE reference = ?').bind(t.reference).first();
    if (hit) return true;
  }
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const hit = await env.DB.prepare(
    'SELECT id FROM transactions WHERE source = ? AND amount_sen = ? AND merchant = ? AND occurred_at >= ?',
  ).bind(t.source, t.amount_sen, t.merchant, since).first();
  return Boolean(hit);
}

async function ingest(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return text('Could not read that request.', 400);

  if (body.source === 'apple_pay') {
    const amount_sen = parseMoney(body.amount);
    if (!amount_sen) return text(`Could not read the amount "${body.amount ?? ''}".`, 422);
    const foreign = /[A-Z$€£¥]/i.test(String(body.amount)) && !/RM|MYR/i.test(String(body.amount));
    const merchant = String(body.merchant || body.name || '').trim();
    const row = await insert(env, {
      amount_sen, source: 'apple_pay', merchant: merchant || 'Apple Pay',
      card: body.card ? String(body.card).slice(0, 80) : null,
      needs_review: foreign || !merchant ? 1 : 0,
    });
    return text(`Logged ${formatRM(row.amount_sen)} at ${row.merchant}`);
  }

  if (body.source === 'shopeepay_qr') {
    const parsed = parseReceipt(body.text);
    if (!parsed) return text('No payment found on this screen. Nothing was logged.', 422);
    const candidate = {
      amount_sen: parsed.amount_sen, source: 'shopeepay_qr',
      merchant: parsed.merchant || 'ShopeePay QR', reference: parsed.reference,
    };
    if (await isDuplicate(env, candidate)) return text(`Already logged ${formatRM(parsed.amount_sen)}`);
    const unsure = !parsed.merchant || !parsed.confirmed;
    const row = await insert(env, {
      ...candidate, needs_review: unsure ? 1 : 0,
      ...(parsed.merchant ? {} : { category: 'Other' }),
      // Screen text is only kept when it's needed to fix a misread.
      raw_text: unsure ? String(body.text).slice(0, 4000) : null,
    });
    return text(`Logged ${formatRM(row.amount_sen)} at ${row.merchant}${unsure ? ' (check this one)' : ''}`);
  }
  return text('Unknown payment source.', 400);
}

async function loadSummary(env, date) {
  const end = [...weekDates(date), date].sort().at(-1);
  const { results } = await env.DB.prepare(
    `SELECT id, amount_sen, merchant, category, source, card, occurred_at, local_date, needs_review
     FROM transactions WHERE local_date BETWEEN ? AND ?`,
  ).bind(windowStart(date), end).all();
  return summarize(results, date);
}

async function rememberCategory(env, merchant, category) {
  await env.DB.prepare(
    `INSERT INTO merchant_categories (merchant_key, category) VALUES (?, ?)
     ON CONFLICT (merchant_key) DO UPDATE SET category = excluded.category`,
  ).bind(merchantKey(merchant), category).run();
}

function cleanEdits(body) {
  const out = {};
  if (body.amount !== undefined) {
    out.amount_sen = parseMoney(body.amount);
    if (!out.amount_sen) return { error: 'Enter an amount above RM0.' };
  }
  if (body.merchant !== undefined) {
    out.merchant = String(body.merchant).trim().slice(0, 120);
    if (!out.merchant) return { error: 'Enter where you paid.' };
  }
  if (body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) return { error: 'Choose a listed category.' };
    out.category = body.category;
  }
  return { out };
}

async function api(request, env, url) {
  if (!(await authorized(request, env))) return text('Invalid access key.', 401);
  const path = url.pathname.replace(/\/$/, '');
  const method = request.method;
  const date = url.searchParams.get('date') || localDate();
  if (!isDate(date)) return text('Use a date like 2026-11-09.', 400);

  if (path === '/api/ingest' && method === 'POST') return ingest(request, env);
  if (path === '/api/summary' && method === 'GET') return json(await loadSummary(env, date));
  if (path === '/api/report' && method === 'GET') return text(reportText(await loadSummary(env, date)));

  if (path === '/api/transactions' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { out, error } = cleanEdits({ amount: body.amount ?? '', merchant: body.merchant ?? '', ...(body.category ? { category: body.category } : {}) });
    if (error) return json({ error }, 422);
    if (body.date && !isDate(body.date)) return json({ error: 'Choose a valid date.' }, 422);
    // Adding to a past day files it at noon on that day; today uses the current time.
    const occurred_at = body.date && body.date !== localDate() ? `${body.date}T12:00:00+08:00` : undefined;
    const row = await insert(env, { ...out, source: 'manual', occurred_at });
    if (out.category) await rememberCategory(env, out.merchant, out.category);
    return json(row, 201);
  }

  const match = path.match(/^\/api\/transactions\/([\w-]+)$/);
  if (match && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(match[1]).run();
    return json({ ok: true });
  }
  if (match && method === 'PATCH') {
    const { out, error } = cleanEdits(await request.json().catch(() => ({})));
    if (error) return json({ error }, 422);
    const current = await env.DB.prepare('SELECT merchant FROM transactions WHERE id = ?').bind(match[1]).first();
    if (!current) return json({ error: 'That purchase no longer exists.' }, 404);
    const keys = Object.keys(out);
    await env.DB.prepare(
      `UPDATE transactions SET ${keys.map((k) => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}needs_review = 0, raw_text = NULL WHERE id = ?`,
    ).bind(...keys.map((k) => out[k]), match[1]).run();
    if (out.category) await rememberCategory(env, out.merchant || current.merchant, out.category);
    return json({ ok: true });
  }
  return text('Not found.', 404);
}

export const handleApi = (request, env) => api(request, env, new URL(request.url));
