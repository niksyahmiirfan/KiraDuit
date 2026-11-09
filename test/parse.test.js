import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parseReceipt, guessCategory } from '../src/parse.js';
import { summarize, weekDates, reportText } from '../public/summary.js';

test('parseMoney handles Wallet and receipt formats', () => {
  assert.equal(parseMoney('RM12.50'), 1250);
  assert.equal(parseMoney('MYR 1,234.5'), 123450);
  assert.equal(parseMoney('12,50'), 1250);
  assert.equal(parseMoney('RM0.07'), 7);
  assert.equal(parseMoney('19.99'), 1999);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('0'), null);
});
test('reads a receipt with labels on separate lines', () => {
  const r = parseReceipt('4:32\nPayment Successful\n-RM12.90\nMerchant\nNasi Kandar Pelita\nTransaction ID\nSPAY20261109ABC\nShopeePay Balance RM88.10');
  assert.deepEqual(r, { amount_sen: 1290, merchant: 'Nasi Kandar Pelita', reference: 'SPAY20261109ABC', confirmed: true });
});
test('prefers total over subtotal and ignores balance and discounts', () => {
  const r = parseReceipt('Successful\nBalance: RM500.00\nVoucher\nRM2.00\nTotal Payment RM8.00\nPaid to: ZUS Coffee');
  assert.equal(r.amount_sen, 800);
  assert.equal(r.merchant, 'ZUS Coffee');
});
test('returns null with no payment on screen', () => assert.equal(parseReceipt('Home\nMessages\nSettings'), null));
test('flags receipts without a success word', () => assert.equal(parseReceipt('Pending\nRM5.00').confirmed, false));
test('guesses categories', () => {
  assert.equal(guessCategory('99 Speedmart Sri Petaling'), 'Groceries');
  assert.equal(guessCategory('Restoran Ali'), 'Food');
  assert.equal(guessCategory('Unknown Sdn Bhd'), 'Other');
});
test('week starts on Monday', () => {
  assert.equal(weekDates('2026-11-09')[0], '2026-11-09');
  assert.equal(weekDates('2026-11-15')[0], '2026-11-09');
});
test('summarize totals, usual and report', () => {
  const t = (local_date, amount_sen, category = 'Food', source = 'shopeepay_qr') => ({ id: local_date + amount_sen, local_date, amount_sen, category, source, merchant: 'X', needs_review: 0, occurred_at: `${local_date}T04:00:00Z` });
  const s = summarize([t('2026-11-09', 1000), t('2026-11-09', 500, 'Transport', 'apple_pay'), t('2026-11-08', 2000), t('2026-11-07', 2000), t('2026-11-06', 2000)], '2026-11-09');
  assert.equal(s.total, 1500); assert.equal(s.usual, 2000); assert.equal(s.count, 2);
  assert.equal(s.monthTotal, 7500);
  assert.equal(reportText(s), 'RM15.00 across 2 purchases. RM5.00 below your usual day. Top: Food RM10.00, Transport RM5.00.');
});
