import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parseReceipt, guessCategory } from '../src/parse.js';
import { previousRange, allowanceFor, toCsv, summarize, summarizePeriod, payPeriod, weekDates, reportText } from '../public/summary.js';

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
test('pay period runs 27th to 26th across month and year ends', () => {
  assert.deepEqual(payPeriod('2026-11-09'), { start: '2026-10-27', end: '2026-11-26' });
  assert.deepEqual(payPeriod('2026-11-26'), { start: '2026-10-27', end: '2026-11-26' });
  assert.deepEqual(payPeriod('2026-11-27'), { start: '2026-11-27', end: '2026-12-26' });
  assert.deepEqual(payPeriod('2026-12-30'), { start: '2026-12-27', end: '2027-01-26' });
  assert.deepEqual(payPeriod('2027-01-05'), { start: '2026-12-27', end: '2027-01-26' });
  assert.deepEqual(payPeriod('2027-02-27'), { start: '2027-02-27', end: '2027-03-26' });
});
test('month summary works out money left and daily allowance', () => {
  const tx = (local_date, amount_sen) => ({ local_date, amount_sen, category: 'Food', source: 'manual' });
  const h = summarizePeriod([tx('2026-10-28', 100000), tx('2026-11-09', 2000), tx('2026-11-27', 999)], { view: 'month', start: '2026-10-27', end: '2026-11-26', today: '2026-11-09', income: 400000 });
  assert.equal(h.total, 102000); assert.equal(h.left, 298000);
  assert.equal(h.nextPayday, '2026-11-27'); assert.equal(h.daysToPayday, 18);
  assert.equal(h.dailyAllowance, 16555); assert.equal(h.days.length, 31); assert.equal(h.average, Math.round(102000 / 14));
});
test('report states budget result', () => {
  const t = { id: 'a', local_date: '2026-11-09', amount_sen: 7000, category: 'Food', source: 'manual', merchant: 'X', needs_review: 0, occurred_at: '2026-11-09T04:00:00Z' };
  assert.equal(reportText(summarize([t], '2026-11-09', 6000)), 'RM70.00 across 1 purchase. RM10.00 over your RM60.00 budget. Top: Food RM70.00.');
  assert.equal(reportText(summarize([t], '2026-11-09', 9000)), 'RM70.00 across 1 purchase. RM20.00 left of your RM90.00 budget. Top: Food RM70.00.');
});
test('commitments reduce money left and the allowance', () => {
  const h = summarizePeriod([{ local_date: '2026-11-09', amount_sen: 10000, category: 'Food', source: 'manual' }], { view: 'month', start: '2026-10-27', end: '2026-11-26', today: '2026-11-09', income: 400000, commitments: 150000 });
  assert.equal(h.left, 240000); assert.equal(h.dailyAllowance, Math.floor(240000 / 18));
});
test('allowance is fixed from the start of the day and null when nothing is left', () => {
  assert.equal(allowanceFor({ income: 400000, commitments: 100000, spentBefore: 120000, today: '2026-11-09' }), 10000);
  assert.equal(allowanceFor({ income: 100000, commitments: 100000, spentBefore: 1, today: '2026-11-09' }), null);
  assert.equal(allowanceFor({ income: null, commitments: 0, spentBefore: 0, today: '2026-11-09' }), null);
});
test('CSV uses local time, quotes commas and neutralises formulas', () => {
  const csv = toCsv([{ occurred_at: '2026-11-09T16:30:00Z', local_date: '2026-11-10', merchant: 'Kedai, "Ali"', category: 'Food', amount_sen: 1250, source: 'apple_pay', card: null, needs_review: 0 }, { occurred_at: '2026-11-08T01:00:00Z', local_date: '2026-11-08', merchant: '=HYPERLINK(1)', category: 'Other', amount_sen: 100, source: 'manual', card: 'V', needs_review: 1 }]).split('\r\n');
  assert.equal(csv[1], "2026-11-08,09:00,'=HYPERLINK(1),Other,1.00,Added by hand,V,yes");
  assert.equal(csv[2], '2026-11-10,00:30,"Kedai, ""Ali""",Food,12.50,Apple Pay,,no');
});
test('previous range compares the same stretch of time', () => {
  assert.deepEqual(previousRange('week', '2026-11-09', '2026-11-15', '2026-11-11'), { start: '2026-11-02', end: '2026-11-04' });
  assert.deepEqual(previousRange('month', '2026-10-27', '2026-11-26', '2026-11-09'), { start: '2026-09-27', end: '2026-10-10' });
  assert.deepEqual(previousRange('week', '2026-11-02', '2026-11-08', '2026-11-11'), { start: '2026-10-26', end: '2026-11-01' });
});
