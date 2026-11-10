import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { handleApi } from '../src/index.js';
import { amountInText, redact } from '../src/ai.js';

// Available in Workers but not in Node.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Runs the real SQL against an in-memory database shaped like D1.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => { for (const st of list) await st.run(); }, raw: db };
}

function setup(reply) {
  const calls = [];
  const replies = Array.isArray(reply) ? [...reply] : null;
  const AI = reply === undefined ? undefined : {
    run: async (_model, input) => {
      calls.push(input);
      const next = replies ? replies.shift() : reply;
      if (next instanceof Error) throw next;
      return { response: JSON.stringify(next) };
    },
  };
  const env = { DB: fakeD1(), API_TOKEN: 'key', AI };
  const post = (path, body) => handleApi(new Request(`https://x${path}`, {
    method: 'POST', headers: { authorization: 'Bearer key' }, body: JSON.stringify(body),
  }), env);
  const rows = () => env.DB.raw.prepare('SELECT * FROM transactions').all();
  return { env, post, rows, calls };
}

const scan = (text) => ({ source: 'shopeepay_qr', text });

test('amountInText only accepts amounts actually written', () => {
  assert.ok(amountInText(1290, 'Total RM12.90'));
  assert.ok(amountInText(850, 'nasi lemak 8.5'));
  assert.ok(amountInText(123450, 'RM1,234.50'));
  assert.ok(amountInText(800, 'kopi 8'));
  assert.ok(!amountInText(800, 'kopi 8.50'));
  assert.ok(!amountInText(1290, 'Total RM112.90'));
  assert.ok(!amountInText(800, 'at 8:30'));
});

test('redact hides long digit runs but keeps prices', () => {
  assert.equal(redact('Acc 1234567890123 RM1,234.50'), 'Acc [number] RM1,234.50');
});

test('complete receipts never call the model', async () => {
  const { post, rows, calls } = setup({ paid: true });
  await post('/api/ingest', scan('Payment Successful\nRM12.90\nMerchant\nNasi Kandar Pelita'));
  assert.equal(calls.length, 0);
  assert.equal(rows()[0].needs_review, 0);
});

test('rescue fills a missing merchant and clears the flag when it agrees', async () => {
  const { post, rows, calls } = setup({ paid: true, amount: 12.9, merchant: 'Kedai Pak Ali', category: 'Food' });
  const res = await post('/api/ingest', scan('Successful\nRM12.90\nKedai Pak Ali\nAcc 1234567890123'));
  assert.equal(await res.text(), 'Logged RM12.90 at Kedai Pak Ali');
  const [row] = rows();
  assert.equal(row.merchant, 'Kedai Pak Ali');
  assert.equal(row.category, 'Food');
  assert.equal(row.needs_review, 0);
  assert.equal(row.raw_text, null);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].messages[1].content.includes('1234567890123'));
});

test('a merchant that is not on the receipt is rejected', async () => {
  const { post, rows } = setup({ paid: true, amount: 12.9, merchant: 'Invented Shop', category: 'Food' });
  await post('/api/ingest', scan('Successful\nRM12.90\nSomething'));
  const [row] = rows();
  assert.equal(row.merchant, 'ShopeePay QR');
  assert.equal(row.needs_review, 1);
  assert.ok(row.raw_text);
});

test('a disagreement on amount keeps the parser amount and the flag', async () => {
  const { post, rows } = setup({ paid: true, amount: 5, merchant: 'Kedai Ali', category: 'Food' });
  await post('/api/ingest', scan('Successful\nRM12.90\nKedai Ali\nRM5.00 off'));
  assert.equal(rows()[0].amount_sen, 1290);
  assert.equal(rows()[0].needs_review, 1);
});

test('a pending payment stays flagged even if the model says paid', async () => {
  const { post, rows } = setup({ paid: true, amount: 12.9, merchant: 'Kedai Ali', category: 'Food' });
  await post('/api/ingest', scan('Pending\nRM12.90\nKedai Ali'));
  assert.equal(rows()[0].needs_review, 1);
});

test('when the parser finds nothing, a verified rescue logs but stays flagged', async () => {
  const { post, rows } = setup({ paid: true, amount: 7.5, merchant: 'Kedai Ali', category: 'Food' });
  await post('/api/ingest', scan('Berjaya\n7.50\nKedai Ali'));
  assert.equal(rows()[0].amount_sen, 750);
  assert.equal(rows()[0].needs_review, 1);
});

test('a screen the model says is not a payment logs nothing', async () => {
  const { post, rows } = setup({ paid: false, amount: null, merchant: null, category: null });
  const res = await post('/api/ingest', scan('Home\nMessages'));
  assert.equal(res.status, 422);
  assert.equal(rows().length, 0);
});

test('model failure falls back to Tap to check', async () => {
  const { post, rows } = setup([new Error('down')]);
  const res = await post('/api/ingest', scan('Successful\nRM12.90\nSomething'));
  assert.equal(res.status, 200);
  assert.equal(rows()[0].needs_review, 1);
});

test('without the binding the app behaves as before', async () => {
  const { post, rows } = setup();
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM9.00', merchant: 'Kedai Baru' });
  assert.equal(rows()[0].category, 'Other');
  assert.equal((await post('/api/draft', { text: 'kopi 3' })).status, 503);
});

test('an unfamiliar merchant is categorised once, then remembered', async () => {
  const { post, rows, calls } = setup({ category: 'Groceries' });
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM9.00', merchant: 'Kedai Runcit Ah Hock' });
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM4.00', merchant: 'Kedai Runcit Ah Hock' });
  assert.deepEqual(rows().map((r) => r.category), ['Groceries', 'Groceries']);
  assert.equal(calls.length, 1);
});

test('keyword matches and placeholders skip the model; invalid categories are ignored', async () => {
  const { post, rows, calls } = setup({ category: 'Luxury' });
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM9.00', merchant: 'ZUS Coffee' });
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM5.00', merchant: '' });
  assert.equal(calls.length, 0);
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM6.00', merchant: 'Unknown Sdn Bhd' });
  assert.equal(rows()[2].category, 'Other');
});

test('drafts save nothing and drop invented prices', async () => {
  const { post, rows } = setup({ items: [
    { amount: 8.5, item: 'Nasi Lemak', merchant: 'Mamak XYZ', category: 'Food' },
    { amount: 2, item: 'Teh Tarik', merchant: null, category: 'Nope' },
    { amount: 99, item: 'Invented', merchant: 'Mamak XYZ', category: 'Food' },
    { amount: 3, item: null, merchant: null, category: 'Food' },
  ] });
  const res = await post('/api/draft', { text: 'nasi lemak 8.50, teh tarik 2, kopi 3 at Mamak XYZ' });
  assert.deepEqual(await res.json(), { skipped: 2, items: [
    { amount_sen: 850, merchant: 'Mamak XYZ', item: 'Nasi Lemak', category: 'Food' },
    { amount_sen: 200, merchant: '', item: 'Teh Tarik', category: 'Other' },
  ] });
  assert.equal(rows().length, 0);
});

test('reads JSON wrapped in prose or code fences', async () => {
  const { env, post } = setup({});
  env.AI.run = async () => ({ response: 'Here you go:\n```json\n{"items":[{"amount":3,"merchant":"Kopi","category":"Food"}]}\n```' });
  assert.equal((await (await post('/api/draft', { text: 'kopi 3' })).json()).items.length, 1);
});

test('stops calling the model at the daily limit', async () => {
  const { env, post, calls } = setup({ items: [{ amount: 3, merchant: 'Kopi', category: 'Food' }] });
  env.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('ai_usage', ?)").run(`${new Date().toISOString().slice(0, 10)}:150`);
  assert.equal((await post('/api/draft', { text: 'kopi 3' })).status, 503);
  assert.equal(calls.length, 0);
});

const patch = (env, id, body) => handleApi(new Request(`https://x/api/transactions/${id}`, {
  method: 'PATCH', headers: { authorization: 'Bearer key' }, body: JSON.stringify(body),
}), env);

test('a purchase keeps what was bought separately from where', async () => {
  const { env, post, rows } = setup();
  const res = await post('/api/transactions', { amount: '1.50', merchant: 'Mamak XYZ', item: ' Teh Ais ', category: 'Food', date: '2026-11-01', time: '10:00' });
  assert.equal(res.status, 201);
  const [row] = rows();
  assert.equal(row.merchant, 'Mamak XYZ');
  assert.equal(row.item, 'Teh Ais');
  await patch(env, row.id, { item: 'Teh O Ais' });
  assert.equal(rows()[0].item, 'Teh O Ais');
  await patch(env, row.id, { item: '' });
  assert.equal(rows()[0].item, null);
  await post('/api/transactions', { amount: '2', merchant: 'Kedai', category: 'Food', date: '2026-11-01', time: '10:00' });
  assert.equal(rows()[1].item, null);
});

test('an older database gets the item column added on first use', async () => {
  const { env, post, rows } = setup();
  env.DB.raw.exec('ALTER TABLE transactions DROP COLUMN item');
  const { default: fresh } = await import(`../src/index.js?fresh=${Date.now()}`).then((m) => ({ default: m.handleApi }));
  await fresh(new Request('https://x/api/ingest', { method: 'POST', headers: { authorization: 'Bearer key' },
    body: JSON.stringify({ source: 'apple_pay', amount: 'RM3.00', merchant: 'ZUS Coffee' }) }), env);
  assert.equal(rows()[0].item, null);
  assert.ok(env.DB.raw.prepare('PRAGMA table_info(transactions)').all().some((c) => c.name === 'item'));
  await post('/api/transactions', { amount: '1', merchant: 'A', item: 'B', category: 'Food', date: '2026-11-01', time: '10:00' });
  assert.equal(rows()[1].item, 'B');
});

test('a Shortcut can add what was bought to the purchase it just logged', async () => {
  const { post, rows } = setup();
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM1.50', merchant: 'Mamak XYZ' });
  await post('/api/ingest', scan('Payment Successful\nRM8.00\nMerchant\nKedai Ali'));
  const res = await post('/api/transactions/latest/item', { source: 'apple_pay', item: ' Teh Ais ' });
  assert.equal(await res.text(), 'Saved Teh Ais for RM1.50 at Mamak XYZ');
  assert.equal(rows().find((r) => r.source === 'apple_pay').item, 'Teh Ais');
  assert.equal(rows().find((r) => r.source === 'shopeepay_qr').item, null);
  assert.equal((await post('/api/transactions/latest/item', { source: 'apple_pay', item: '  ' })).status, 422);
  assert.equal((await post('/api/transactions/latest/item', { source: 'cash', item: 'x' })).status, 400);
});

test('the item is only added to a purchase from the last 10 minutes', async () => {
  const { env, post } = setup();
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM1.50', merchant: 'Mamak XYZ' });
  env.DB.raw.prepare('UPDATE transactions SET occurred_at = ?').run(new Date(Date.now() - 11 * 60 * 1000).toISOString());
  assert.equal((await post('/api/transactions/latest/item', { source: 'apple_pay', item: 'Teh Ais' })).status, 404);
});

test('ingest also accepts the item directly', async () => {
  const { post, rows } = setup();
  await post('/api/ingest', { source: 'apple_pay', amount: 'RM1.50', merchant: 'Mamak XYZ', item: 'Teh Ais' });
  assert.equal(rows()[0].item, 'Teh Ais');
});

test('an Apple Pay refund removes the matching purchase', async () => {
  const { post, rows } = setup();
  await post('/api/ingest', { source: 'apple_pay', amount: 'MYR 50.00', merchant: 'Shell, Rawang, Selangor' });
  await post('/api/ingest', { source: 'apple_pay', amount: 'MYR 50.00', merchant: 'Petronas' });
  const res = await post('/api/ingest', { source: 'apple_pay', amount: 'MYR 50.00', merchant: 'Shell, Rawang, Selangor', type: 'Refund' });
  assert.equal(await res.text(), 'Refund: removed RM50.00 at Shell, Rawang, Selangor');
  assert.deepEqual(rows().map((r) => r.merchant), ['Petronas']);
});

test('a negative amount is treated as a refund', async () => {
  const { post, rows } = setup();
  await post('/api/ingest', { source: 'apple_pay', amount: 'MYR 50.00', merchant: 'Shell' });
  await post('/api/ingest', { source: 'apple_pay', amount: '-MYR 50.00', merchant: 'Shell' });
  assert.equal(rows().length, 0);
  await post('/api/ingest', { source: 'apple_pay', amount: 12, merchant: 'Shell' });
  await post('/api/ingest', { source: 'apple_pay', amount: -12, merchant: 'Shell' });
  assert.equal(rows().length, 0);
});

test('an unmatched refund changes nothing', async () => {
  const { post, rows } = setup();
  await post('/api/ingest', { source: 'apple_pay', amount: 'MYR 50.00', merchant: 'Shell' });
  const res = await post('/api/ingest', { source: 'apple_pay', amount: '-MYR 20.00', merchant: 'Shell' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /didn't match/);
  assert.equal(rows().length, 1);
});

test('a refund named in the Name field is recognised, but a credit card name is not', async () => {
  const { post, rows } = setup();
  await post('/api/ingest', { source: 'apple_pay', amount: 'MYR 50.00', merchant: 'Shell', name: 'RHB Credit Card' });
  assert.equal(rows().length, 1);
  await post('/api/ingest', { source: 'apple_pay', amount: 'MYR 50.00', merchant: 'Shell', name: 'Refund' });
  assert.equal(rows().length, 0);
});
