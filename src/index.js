import { parseMoney, parseReceipt, parseWalletAmount, guessCategory, merchantKey } from './parse.js';
import { authenticate, login, logout } from './auth.js';
import { cleanShares, groupOwed, splitHint, usualFood } from '../public/split.js';
import { aiEnabled, draftPurchases, readReceipt, suggestCategory } from './ai.js';
import { CATEGORIES, addDays, allowanceFor, budgetLine, formatRM, localDate, payPeriod, periodFor, reportText, summarize, summarizePeriod, previousRange, toCsv, weekDates, windowStart } from '../public/summary.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const text = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

const SPLIT_TABLES = [
  `CREATE TABLE IF NOT EXISTS splits (transaction_id TEXT PRIMARY KEY, bill_sen INTEGER NOT NULL CHECK (bill_sen > 0), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS split_shares (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, friend TEXT NOT NULL,
     amount_sen INTEGER NOT NULL CHECK (amount_sen > 0), paid_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_split_shares_transaction ON split_shares (transaction_id)',
];

// Databases created before newer features get their columns and tables added once, on first use.
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SPLIT_TABLES.map((sql) => env.DB.prepare(sql)));
  const { results } = await env.DB.prepare('PRAGMA table_info(transactions)').all();
  if (!results.some((c) => c.name === 'item')) {
    await env.DB.prepare('ALTER TABLE transactions ADD COLUMN item TEXT').run().catch((e) => {
      if (!/duplicate column/i.test(String(e?.message))) throw e;
    });
  }
  schemaReady = true;
}

const PLACEHOLDER_MERCHANTS = new Set(['apple pay', 'shopeepay qr']);
const UNFINISHED_PAYMENT = /pending|processing|failed|unsuccessful|gagal|menunggu/i;

const saveCategory = (env, merchant, category) => env.DB.prepare(
  `INSERT INTO merchant_categories (merchant_key, category) VALUES (?, ?)
   ON CONFLICT (merchant_key) DO UPDATE SET category = excluded.category`,
).bind(merchantKey(merchant), category).run();

/** Your saved choice wins, then the keyword list, then a model guess that's saved for next time. */
async function categoryFor(env, merchant, hint) {
  const key = merchantKey(merchant);
  const saved = await env.DB.prepare('SELECT category FROM merchant_categories WHERE merchant_key = ?').bind(key).first();
  if (saved) return saved.category;
  const guess = guessCategory(merchant);
  if (guess !== 'Other' || PLACEHOLDER_MERCHANTS.has(key) || !aiEnabled(env)) return guess;
  const suggested = hint || (await suggestCategory(env, merchant));
  if (!suggested) return guess;
  await saveCategory(env, merchant, suggested);
  return suggested;
}

async function insert(env, t) {
  const now = t.occurred_at ? new Date(t.occurred_at) : new Date();
  const row = {
    id: crypto.randomUUID(),
    occurred_at: now.toISOString(),
    local_date: localDate(now),
    card: null, item: null, reference: null, raw_text: null, needs_review: 0,
    ...t,
    category: t.category || (await categoryFor(env, t.merchant)),
  };
  row.occurred_at = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO transactions (id, amount_sen, merchant, item, category, source, card, occurred_at, local_date, needs_review, reference, raw_text)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(row.id, row.amount_sen, row.merchant, row.item, row.category, row.source, row.card, row.occurred_at,
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

const shopeeCandidate = (amount_sen, merchant, reference) => ({
  amount_sen, source: 'shopeepay_qr', merchant: merchant || 'ShopeePay QR', reference: reference ?? null,
});

const REFUND_TYPE = /refund|return|revers|void|cancel|credit/i;
const REFUND_WINDOW_DAYS = 30;
const MINUS = /^\s*[-\u2212(]/;

// Name can hold a card or merchant name, so "credit" isn't treated as a refund there.
const REFUND_NAME = /\b(?:refund|return|reversal|void|cancel)/i;

const isRefund = (body) => REFUND_TYPE.test(String(body.type ?? '')) || MINUS.test(String(body.amount ?? ''))
  || (body.merchant && REFUND_NAME.test(String(body.name ?? '')))
  || (typeof body.amount === 'number' && body.amount < 0);

/** A refunded Apple Pay purchase wasn't spending, so the matching logged purchase is removed. */
async function applyRefund(env, body) {
  const raw = typeof body.amount === 'number' ? Math.abs(body.amount) : String(body.amount ?? '').replace(/[-\u2212()]/g, '');
  const amount_sen = parseWalletAmount(raw);
  if (!amount_sen) return text(`Could not read the refund amount "${body.amount ?? ''}". Nothing changed.`, 422);
  const merchant = String(body.merchant || body.name || '').trim();
  const since = new Date(Date.now() - REFUND_WINDOW_DAYS * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.merchant FROM transactions t LEFT JOIN splits s ON s.transaction_id = t.id
     WHERE t.source = 'apple_pay' AND COALESCE(s.bill_sen, t.amount_sen) = ? AND t.occurred_at >= ?
     ORDER BY t.occurred_at DESC`,
  ).bind(amount_sen, since).all();
  const match = results.find((t) => merchant && merchantKey(t.merchant) === merchantKey(merchant));
  if (!match) {
    return text(`Refund of ${formatRM(amount_sen)}${merchant ? ` at ${merchant}` : ''} didn't match a logged purchase. Nothing changed.`);
  }
  await deleteTransaction(env, match.id);
  return text(`Refund: removed ${formatRM(amount_sen)} at ${match.merchant}`);
}

const deleteTransaction = (env, id) => env.DB.batch([
  env.DB.prepare('DELETE FROM receipts WHERE transaction_id = ?').bind(id),
  env.DB.prepare('DELETE FROM split_shares WHERE transaction_id = ?').bind(id),
  env.DB.prepare('DELETE FROM splits WHERE transaction_id = ?').bind(id),
  env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(id),
]);

async function ingest(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return text('Could not read that request.', 400);

  if (body.source === 'apple_pay') {
    if (isRefund(body)) return applyRefund(env, body);
    const amount_sen = parseWalletAmount(body.amount);
    if (!amount_sen) return text(`Could not read the amount "${body.amount ?? ''}". Nothing was logged.`, 422);
    const foreign = /[A-Z$€£¥]/i.test(String(body.amount)) && !/RM|MYR/i.test(String(body.amount));
    const merchant = String(body.merchant || body.name || '').trim();
    const row = await insert(env, {
      amount_sen, source: 'apple_pay', merchant: merchant || 'Apple Pay', item: cleanItem(body.item),
      card: body.card ? String(body.card).slice(0, 80) : null,
      needs_review: foreign || !merchant ? 1 : 0,
    });
    return text(`Logged ${formatRM(row.amount_sen)} at ${row.merchant}`);
  }

  if (body.source === 'shopeepay_qr') {
    const parsed = parseReceipt(body.text);
    if (parsed && await isDuplicate(env, shopeeCandidate(parsed.amount_sen, parsed.merchant, parsed.reference))) {
      return text(`Already logged ${formatRM(parsed.amount_sen)}`);
    }
    const complete = parsed?.merchant && parsed.confirmed;
    const rescue = complete ? null : await readReceipt(env, body.text);
    const amount_sen = parsed?.amount_sen ?? (rescue?.paid ? rescue.amount_sen : null);
    if (!amount_sen) return text('No payment found on this screen. Nothing was logged.', 422);

    const merchant = parsed?.merchant || rescue?.merchant || null;
    const candidate = shopeeCandidate(amount_sen, merchant, parsed?.reference);
    if (!parsed && await isDuplicate(env, candidate)) return text(`Already logged ${formatRM(amount_sen)}`);
    if (parsed && merchant !== parsed.merchant && await isDuplicate(env, candidate)) return text(`Already logged ${formatRM(amount_sen)}`);

    // The model only clears a flag when it agrees with the parser's amount and nothing on screen says otherwise.
    const rescued = parsed && merchant && rescue?.amount_sen === parsed.amount_sen
      && (parsed.confirmed || rescue.paid) && !UNFINISHED_PAYMENT.test(body.text);
    const unsure = !complete && !rescued;
    const row = await insert(env, {
      ...candidate, item: cleanItem(body.item), needs_review: unsure ? 1 : 0,
      category: merchant ? await categoryFor(env, merchant, rescue?.category) : 'Other',
      // Screen text is only kept when it's needed to fix a misread.
      raw_text: unsure ? String(body.text).slice(0, 4000) : null,
    });
    return text(`Logged ${formatRM(row.amount_sen)} at ${row.merchant}${unsure ? ' (check this one)' : ''}`);
  }
  return text('Unknown payment source.', 400);
}

const getIncome = async (env, periodStart) =>
  (await env.DB.prepare('SELECT amount_sen FROM income WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1').bind(periodStart).first())?.amount_sen ?? null;

const getCommitments = async (env, periodStart) =>
  (await env.DB.prepare(
    'SELECT id, name, amount_sen FROM commitments WHERE effective_from <= ? AND (ended_from IS NULL OR ended_from > ?) ORDER BY amount_sen DESC',
  ).bind(periodStart, periodStart).all()).results;

const sumOf = (rows) => rows.reduce((a, r) => a + r.amount_sen, 0);

const getDefaultBudget = async (env) => {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'default_budget_sen'").first();
  return row ? Number(row.value) : null;
};

/** A day's budget: the one you set, else (today only) your default, else your daily allowance. */
async function budgetFor(env, date) {
  const set = await env.DB.prepare('SELECT amount_sen FROM budgets WHERE local_date = ?').bind(date).first();
  if (set) return { amount: set.amount_sen, source: 'set' };
  if (date !== localDate()) return { amount: null, source: null };
  const fallback = await getDefaultBudget(env);
  if (fallback) return { amount: fallback, source: 'default' };
  const { start } = payPeriod(date);
  const [income, commitments, spent] = await Promise.all([
    getIncome(env, start),
    getCommitments(env, start),
    env.DB.prepare('SELECT COALESCE(SUM(amount_sen), 0) AS total FROM transactions WHERE local_date >= ? AND local_date < ?').bind(start, date).first(),
  ]);
  const amount = allowanceFor({ income, commitments: sumOf(commitments), spentBefore: spent.total, today: date });
  return { amount, source: amount ? 'allowance' : null };
}

async function loadSummary(env, date) {
  const end = [...weekDates(date), date].sort().at(-1);
  const [{ results }, budget, food] = await Promise.all([
    env.DB.prepare(
      `SELECT id, amount_sen, merchant, item, category, source, card, occurred_at, local_date, needs_review,
         EXISTS (SELECT 1 FROM receipts WHERE transaction_id = transactions.id) AS has_receipt,
         (SELECT bill_sen FROM splits WHERE transaction_id = transactions.id) AS bill_sen,
         (SELECT COALESCE(SUM(amount_sen), 0) FROM split_shares WHERE transaction_id = transactions.id AND paid_at IS NULL) AS owed_sen
       FROM transactions WHERE local_date BETWEEN ? AND ?`,
    ).bind(windowStart(date), end).all(),
    budgetFor(env, date),
    env.DB.prepare(
      `SELECT amount_sen FROM transactions WHERE category = 'Food' AND local_date >= ?
       AND id NOT IN (SELECT transaction_id FROM splits)`,
    ).bind(addDays(date, -90)).all(),
  ]);
  const usual = usualFood(food.results.map((r) => r.amount_sen));
  for (const t of results) t.split_hint = splitHint(t, usual);
  return summarize(results, date, budget.amount, budget.source);
}

async function loadHome(env, view, date) {
  const today = localDate();
  const { start, end } = periodFor(view, date);
  const period = payPeriod(date).start;
  const previous = previousRange(view, start, end, today);
  const [{ results }, income, commitments, spentToday, budget, defaultBudget, previousSpend, latestQr, owed] = await Promise.all([
    env.DB.prepare('SELECT amount_sen, category, source, local_date FROM transactions WHERE local_date BETWEEN ? AND ?').bind(start, end).all(),
    getIncome(env, period),
    getCommitments(env, period),
    env.DB.prepare('SELECT COALESCE(SUM(amount_sen), 0) AS total FROM transactions WHERE local_date = ?').bind(today).first(),
    budgetFor(env, today),
    getDefaultBudget(env),
    env.DB.prepare('SELECT COALESCE(SUM(amount_sen), 0) AS total FROM transactions WHERE local_date BETWEEN ? AND ?').bind(previous.start, previous.end).first(),
    env.DB.prepare(
      `SELECT id, amount_sen, merchant, occurred_at FROM transactions
       WHERE source = 'shopeepay_qr' AND local_date = ? AND id NOT IN (SELECT transaction_id FROM receipts)
       ORDER BY occurred_at DESC LIMIT 1`,
    ).bind(today).first(),
    env.DB.prepare(
      `SELECT MAX(friend) AS name, SUM(amount_sen) AS owed_sen, COUNT(*) AS bills FROM split_shares
       WHERE paid_at IS NULL GROUP BY LOWER(friend) ORDER BY owed_sen DESC, name`,
    ).all(),
  ]);
  return {
    owedList: owed.results,
    owedTotal: sumOf(owed.results.map((r) => ({ amount_sen: r.owed_sen }))),
    ...summarizePeriod(results, { view, start, end, today, income, commitments: sumOf(commitments) }),
    commitmentList: commitments,
    previousTotal: previousSpend.total,
    receiptCandidate: latestQr,
    todayTotal: spentToday.total,
    todayBudget: budget.amount,
    todayBudgetSource: budget.source,
    defaultBudget,
  };
}

async function setBudget(request, env, date) {
  const body = await request.json().catch(() => ({}));
  const amount_sen = parseMoney(body.amount);
  if (!amount_sen) return text('Enter a budget above RM0.', 422);
  await env.DB.prepare(
    `INSERT INTO budgets (local_date, amount_sen) VALUES (?, ?)
     ON CONFLICT (local_date) DO UPDATE SET amount_sen = excluded.amount_sen`,
  ).bind(date, amount_sen).run();
  const { total } = await loadSummary(env, date);
  return text(budgetLine(total, amount_sen));
}

async function setIncome(request, env) {
  const body = await request.json().catch(() => ({}));
  const amount_sen = parseMoney(body.amount);
  if (!amount_sen) return text('Enter an income above RM0.', 422);
  await env.DB.prepare(
    `INSERT INTO income (effective_from, amount_sen) VALUES (?, ?)
     ON CONFLICT (effective_from) DO UPDATE SET amount_sen = excluded.amount_sen`,
  ).bind(payPeriod(localDate()).start, amount_sen).run();
  return text(`Income set to ${formatRM(amount_sen)}`);
}

async function setDefaultBudget(request, env) {
  const body = await request.json().catch(() => ({}));
  if (body.amount === '' || body.amount === null || body.amount === undefined) {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'default_budget_sen'").run();
    return text('Default budget cleared');
  }
  const amount_sen = parseMoney(body.amount);
  if (!amount_sen) return text('Enter a budget above RM0, or leave it empty.', 422);
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('default_budget_sen', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).bind(String(amount_sen)).run();
  return text(`Default budget set to ${formatRM(amount_sen)}`);
}

async function addCommitment(request, env) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name ?? '').trim().slice(0, 80);
  const amount_sen = parseMoney(body.amount);
  if (!name) return json({ error: 'Enter a name.' }, 422);
  if (!amount_sen) return json({ error: 'Enter an amount above RM0.' }, 422);
  await env.DB.prepare('INSERT INTO commitments (id, name, amount_sen, effective_from) VALUES (?,?,?,?)')
    .bind(crypto.randomUUID(), name, amount_sen, payPeriod(localDate()).start).run();
  return json({ ok: true }, 201);
}

// Past pay periods keep a commitment that has since ended.
async function removeCommitment(env, id) {
  const current = payPeriod(localDate()).start;
  await env.DB.prepare('DELETE FROM commitments WHERE id = ? AND effective_from >= ?').bind(id, current).run();
  await env.DB.prepare('UPDATE commitments SET ended_from = ? WHERE id = ? AND ended_from IS NULL').bind(current, id).run();
  return json({ ok: true });
}

async function exportCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT amount_sen, merchant, item, category, source, card, occurred_at, local_date, needs_review,
       (SELECT bill_sen FROM splits WHERE transaction_id = transactions.id) AS bill_sen FROM transactions`,
  ).all();
  return new Response(toCsv(results), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="kiraduit.csv"', 'cache-control': 'no-store' },
  });
}

const MAX_IMAGE_CHARS = 1500000; // D1 stores at most 2 MB in one row

function cleanImage(value) {
  const image = String(value ?? '').replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
  if (!image || !/^[A-Za-z0-9+/]+=*$/.test(image)) return { error: 'Send the photo as base64 text.', status: 422 };
  if (!image.startsWith('/9j/') && !image.startsWith('iVBOR')) return { error: 'Send the photo as a JPEG or PNG.', status: 422 };
  if (image.length > MAX_IMAGE_CHARS) return { error: 'That photo is too large. Resize it and try again.', status: 413 };
  return { image };
}

const saveReceipt = (env, id, image) => env.DB.prepare(
  `INSERT INTO receipts (transaction_id, image, created_at) VALUES (?, ?, ?)
   ON CONFLICT (transaction_id) DO UPDATE SET image = excluded.image, created_at = excluded.created_at`,
).bind(id, image, new Date().toISOString()).run();

const ITEM_WINDOW_MS = 10 * 60 * 1000;
const cleanItem = (value) => String(value ?? '').trim().slice(0, 120) || null;

/** Lets a Shortcut ask what you bought after logging, so dismissing the question never loses the purchase. */
async function saveLatestItem(request, env) {
  const body = await request.json().catch(() => ({}));
  const item = cleanItem(body.item);
  if (!item) return text('Nothing to add.', 422);
  if (!['apple_pay', 'shopeepay_qr', 'manual'].includes(body.source)) return text('Unknown payment source.', 400);
  const since = new Date(Date.now() - ITEM_WINDOW_MS).toISOString();
  const latest = await env.DB.prepare(
    `SELECT id, amount_sen, merchant FROM transactions
     WHERE source = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1`,
  ).bind(body.source, since).first();
  if (!latest) return text('No purchase from the last 10 minutes to add this to.', 404);
  await env.DB.prepare('UPDATE transactions SET item = ? WHERE id = ?').bind(item, latest.id).run();
  return text(`Saved ${item} for ${formatRM(latest.amount_sen)} at ${latest.merchant}`);
}

async function saveLatestReceipt(request, env) {
  const body = await request.json().catch(() => ({}));
  const { image, error, status } = cleanImage(body.image);
  if (error) return text(error, status);
  const latest = await env.DB.prepare(
    `SELECT id, amount_sen, merchant FROM transactions
     WHERE source = 'shopeepay_qr' AND id NOT IN (SELECT transaction_id FROM receipts)
     ORDER BY occurred_at DESC LIMIT 1`,
  ).first();
  if (!latest) return text('No QR purchase is waiting for a receipt.', 404);
  await saveReceipt(env, latest.id, image);
  return text(`Receipt saved for ${formatRM(latest.amount_sen)} at ${latest.merchant}`);
}

async function receiptRoute(request, env, id) {
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT image FROM receipts WHERE transaction_id = ?').bind(id).first();
    if (!row) return text('No receipt for this purchase.', 404);
    const bytes = Uint8Array.from(atob(row.image), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'content-type': row.image.startsWith('/9j/') ? 'image/jpeg' : 'image/png', 'cache-control': 'no-store' } });
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM receipts WHERE transaction_id = ?').bind(id).run();
    return json({ ok: true });
  }
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { image, error, status } = cleanImage(body.image);
    if (error) return json({ error }, status);
    const exists = await env.DB.prepare('SELECT id FROM transactions WHERE id = ?').bind(id).first();
    if (!exists) return json({ error: 'That purchase no longer exists.' }, 404);
    await saveReceipt(env, id, image);
    return json({ ok: true });
  }
  return text('Not found.', 404);
}

const rememberCategory = saveCategory;

async function draft(request, env) {
  const body = await request.json().catch(() => ({}));
  const note = String(body.text ?? '').trim();
  if (!note) return json({ error: 'Type what you bought and how much it was.' }, 422);
  if (!aiEnabled(env)) return json({ error: "Quick add isn't switched on yet. Fill in the details below instead." }, 503);
  const result = await draftPurchases(env, note);
  if (!result) return json({ error: "Quick add isn't available right now. Fill in the details below instead." }, 503);
  if (!result.items.length) return json({ error: "Couldn't find a purchase with a price. Try something like: nasi lemak 8.50." }, 422);
  return json(result);
}

async function getSplit(env, id) {
  const tx = await env.DB.prepare('SELECT amount_sen FROM transactions WHERE id = ?').bind(id).first();
  if (!tx) return json({ error: 'That purchase no longer exists.' }, 404);
  const [split, shares, recent] = await Promise.all([
    env.DB.prepare('SELECT bill_sen FROM splits WHERE transaction_id = ?').bind(id).first(),
    env.DB.prepare('SELECT id, friend, amount_sen, paid_at FROM split_shares WHERE transaction_id = ? ORDER BY rowid').bind(id).all(),
    env.DB.prepare('SELECT MAX(friend) AS name FROM split_shares GROUP BY LOWER(friend) ORDER BY MAX(rowid) DESC LIMIT 20').all(),
  ]);
  return json({
    bill_sen: split?.bill_sen ?? tx.amount_sen,
    mine_sen: tx.amount_sen,
    shares: shares.results.map((s) => ({ id: s.id, friend: s.friend, amount_sen: s.amount_sen, paid: Boolean(s.paid_at) })),
    recent: recent.results.map((r) => r.name),
  });
}

/** Saves who owes what for a purchase. Your share becomes the purchase amount, so only it counts as spending. */
async function saveSplit(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const tx = await env.DB.prepare('SELECT amount_sen FROM transactions WHERE id = ?').bind(id).first();
  if (!tx) return json({ error: 'That purchase no longer exists.' }, 404);
  const split = await env.DB.prepare('SELECT bill_sen FROM splits WHERE transaction_id = ?').bind(id).first();
  const bill_sen = split?.bill_sen ?? tx.amount_sen;
  const { shares, mine, error } = cleanShares(bill_sen, body.shares);
  if (error) return json({ error }, 422);
  // A friend who already paid stays paid when the split is edited.
  const { results: before } = await env.DB.prepare('SELECT friend, paid_at FROM split_shares WHERE transaction_id = ?').bind(id).all();
  const paid = new Map(before.filter((s) => s.paid_at).map((s) => [s.friend.toLowerCase(), s.paid_at]));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO splits (transaction_id, bill_sen, created_at) VALUES (?, ?, ?)
       ON CONFLICT (transaction_id) DO UPDATE SET bill_sen = excluded.bill_sen`,
    ).bind(id, bill_sen, new Date().toISOString()),
    env.DB.prepare('DELETE FROM split_shares WHERE transaction_id = ?').bind(id),
    ...shares.map((s) => env.DB.prepare('INSERT INTO split_shares (id, transaction_id, friend, amount_sen, paid_at) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), id, s.friend, s.amount_sen, paid.get(s.friend.toLowerCase()) ?? null)),
    env.DB.prepare('UPDATE transactions SET amount_sen = ? WHERE id = ?').bind(mine, id),
  ]);
  return json({ ok: true, mine_sen: mine });
}

async function removeSplit(env, id) {
  const split = await env.DB.prepare('SELECT bill_sen FROM splits WHERE transaction_id = ?').bind(id).first();
  if (!split) return json({ ok: true });
  await env.DB.batch([
    env.DB.prepare('UPDATE transactions SET amount_sen = ? WHERE id = ?').bind(split.bill_sen, id),
    env.DB.prepare('DELETE FROM split_shares WHERE transaction_id = ?').bind(id),
    env.DB.prepare('DELETE FROM splits WHERE transaction_id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function loadOwed(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.friend, s.amount_sen, t.id AS transaction_id, t.merchant, t.item, t.local_date FROM split_shares s
     JOIN transactions t ON t.id = s.transaction_id WHERE s.paid_at IS NULL ORDER BY t.occurred_at DESC`,
  ).all();
  return json({ friends: groupOwed(results) });
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
  if (body.item !== undefined) out.item = String(body.item ?? '').trim().slice(0, 120) || null;
  if (body.date !== undefined || body.time !== undefined) {
    const { date, time } = body;
    const valid = isDate(date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')
      && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
    if (!valid) return { error: 'Enter a valid date and time.' };
    if (date > localDate()) return { error: 'Choose today or an earlier date.' };
    out.local_date = date;
    out.occurred_at = new Date(`${date}T${time}:00+08:00`).toISOString();
  }
  if (body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) return { error: 'Choose a listed category.' };
    out.category = body.category;
  }
  return { out };
}

async function api(request, env, url) {
  const path = url.pathname.replace(/\/$/, '');
  const method = request.method;
  const secure = url.protocol === 'https:';

  // These two run before the access check: one trades the key for a session, the other ends it.
  if (path === '/api/login' && method === 'POST') return login(request, env, secure);
  if (path === '/api/logout' && method === 'POST') return logout(secure);

  const auth = await authenticate(request, env);
  if (!auth.ok) {
    const res = text(auth.message, auth.status);
    if (auth.retryAfter) res.headers.set('retry-after', String(auth.retryAfter));
    return res;
  }
  await ensureSchema(env);
  const date = url.searchParams.get('date') || localDate();
  if (!isDate(date)) return text('Use a date like 2026-11-09.', 400);

  if (path === '/api/ingest' && method === 'POST') return ingest(request, env);
  if (path === '/api/summary' && method === 'GET') return json(await loadSummary(env, date));
  if (path === '/api/home' && method === 'GET') {
    const view = url.searchParams.get('view') === 'month' ? 'month' : 'week';
    return json(await loadHome(env, view, date));
  }
  if (path === '/api/budget' && method === 'POST') return setBudget(request, env, date);
  if (path === '/api/income' && method === 'POST') return setIncome(request, env);
  if (path === '/api/report' && method === 'GET') {
    const report = reportText(await loadSummary(env, date));
    return text(date === localDate() ? `${report} Anything missing? Open KiraDuit to add it.` : report);
  }
  if (path === '/api/default-budget' && method === 'POST') return setDefaultBudget(request, env);
  if (path === '/api/export' && method === 'GET') return exportCsv(env);
  if (path === '/api/commitments' && method === 'POST') return addCommitment(request, env);
  const commitment = path.match(/^\/api\/commitments\/([\w-]+)$/);
  if (commitment && method === 'DELETE') return removeCommitment(env, commitment[1]);

  if (path === '/api/draft' && method === 'POST') return draft(request, env);
  if (path === '/api/transactions' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { out, error } = cleanEdits({
      amount: body.amount ?? '', merchant: body.merchant ?? '', item: body.item ?? '',
      ...(body.category ? { category: body.category } : {}),
      ...(body.date ? { date: body.date, time: body.time } : {}),
    });
    if (error) return json({ error }, 422);
    const row = await insert(env, { ...out, source: 'manual' });
    if (out.category) await rememberCategory(env, out.merchant, out.category);
    return json(row, 201);
  }

  if (path === '/api/owed' && method === 'GET') return loadOwed(env);
  const share = path.match(/^\/api\/shares\/([\w-]+)$/);
  if (share && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const res = await env.DB.prepare('UPDATE split_shares SET paid_at = ? WHERE id = ?')
      .bind(body.paid === false ? null : new Date().toISOString(), share[1]).run();
    return res.meta?.changes === 0 ? json({ error: 'That share no longer exists.' }, 404) : json({ ok: true });
  }
  const splitPath = path.match(/^\/api\/transactions\/([\w-]+)\/split$/);
  if (splitPath && method === 'GET') return getSplit(env, splitPath[1]);
  if (splitPath && method === 'PUT') return saveSplit(request, env, splitPath[1]);
  if (splitPath && method === 'DELETE') return removeSplit(env, splitPath[1]);
  if (path === '/api/transactions/latest/item' && method === 'POST') return saveLatestItem(request, env);
  if (path === '/api/receipts/latest' && method === 'POST') return saveLatestReceipt(request, env);
  const receipt = path.match(/^\/api\/transactions\/([\w-]+)\/receipt$/);
  if (receipt) return receiptRoute(request, env, receipt[1]);

  const match = path.match(/^\/api\/transactions\/([\w-]+)$/);
  if (match && method === 'DELETE') {
    await deleteTransaction(env, match[1]);
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
    // On a split purchase the amount is your share, so the bill total follows it.
    if (out.amount_sen) {
      await env.DB.prepare(
        `UPDATE splits SET bill_sen = ? + (SELECT COALESCE(SUM(amount_sen), 0) FROM split_shares WHERE transaction_id = ?)
         WHERE transaction_id = ?`,
      ).bind(out.amount_sen, match[1], match[1]).run();
    }
    return json({ ok: true });
  }
  return text('Not found.', 404);
}

// _headers only covers static files, so API responses get their own.
export async function handleApi(request, env) {
  const original = await api(request, env, new URL(request.url));
  const res = new Response(original.body, original); // copy so the headers can be changed
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('cross-origin-resource-policy', 'same-origin');
  res.headers.set('x-frame-options', 'DENY');
  return res;
}

