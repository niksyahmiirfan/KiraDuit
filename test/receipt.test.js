import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReceipt, emptyReceipt, pickedNames, shareOf, withCheck } from '../public/receipt.js';

const dinner = cleanReceipt({
  merchant: 'Restoran Tomyam',
  items: [
    { name: 'Nasi Goreng Kampung', qty: 1, amount: 12 },
    { name: 'Tomyam Campur', qty: 1, amount: 28 },
    { name: 'Teh Ais', qty: 2, amount: 7 },
    { name: 'Telur Mata', qty: 1, amount: 'RM2.00' },
    { name: '', amount: 5 },
    { name: 'Free sambal', amount: 0 },
  ],
  charges: [{ name: 'Service charge 10%', amount: 4.9 }, { name: 'SST 6%', amount: 3.23 }, { name: 'Rounding', amount: -0.03 }],
  total: 57.1,
});

test('a receipt keeps priced items and sums them', () => {
  assert.equal(dinner.items.length, 4);
  assert.equal(dinner.items_sen, 4900);
  assert.equal(dinner.charges_sen, 810);
  assert.equal(dinner.total_sen, 5710);
  assert.equal(dinner.mismatch_sen, 0);
});

test('your share includes your part of tax and charges', () => {
  // Nasi goreng, one of two teh ais, and the egg: RM12 + RM3.50 + RM2 = RM17.50 of RM49 items.
  const r = shareOf(dinner, { i0: 1, i2: 1, i3: 1 });
  assert.equal(r.items_sen, 1750);
  assert.equal(r.share_sen, Math.round((5710 * 1750) / 4900));
  assert.equal(r.share_sen, 2039);
  assert.equal(r.extra_sen, 289);
  assert.equal(pickedNames(dinner, { i0: 1, i2: 1, i3: 1 }), 'Nasi Goreng Kampung, Teh Ais, Telur Mata');
  assert.equal(pickedNames(dinner, { i2: 2 }), '2× Teh Ais');
});

test('everyone picking everything adds up to the total', () => {
  assert.equal(shareOf(dinner, { i0: 1, i1: 1, i2: 2, i3: 1 }).share_sen, 5710);
  assert.equal(shareOf(dinner, { i2: 9 }).items_sen, 700);
});

test('a share can be scaled to what was actually paid', () => {
  assert.equal(shareOf(dinner, { i1: 1 }, 6000).share_sen, Math.round((6000 * 2800) / 4900));
});

test('a total that does not match the lines is flagged; a missing total is worked out', () => {
  assert.equal(cleanReceipt({ items: [{ name: 'A', amount: 10 }], total: 30 }).mismatch_sen, 2000);
  assert.equal(cleanReceipt({ items: [{ name: 'A', amount: 10 }], charges: [{ name: 'SST', amount: 0.6 }] }).total_sen, 1060);
  assert.match(cleanReceipt({ items: [] }).error, /No items/);
  assert.match(cleanReceipt(null).error, /No items/);
});

test('the printed subtotal catches a misread price, and correcting it clears the warning', () => {
  const murni = cleanReceipt({ items: [{ name: 'Nasi Tong', amount: 11.23 }, { name: 'Barley', amount: 2.47 }, { name: 'Indomee', amount: 75.92 }], subtotal: 89.62, charges: [{ name: 'Tax', amount: 5.38 }], total: 95 });
  assert.equal(murni.mismatch_sen, 0);
  const misread = cleanReceipt({ items: [{ name: 'Nasi Tong', amount: 11.23 }, { name: 'Barley', amount: 27.4 }, { name: 'Indomee', amount: 75.92 }], subtotal: 89.62, total: 95 });
  assert.equal(misread.mismatch_sen, 8962 - 11455);
  misread.items[1].amount_sen = 247;
  assert.equal(withCheck(misread).mismatch_sen, 0);
});

test('typing items in by hand starts empty and uses the items when no total is entered', () => {
  const r = emptyReceipt('Murni');
  r.items.push({ id: 'm0', name: 'Nasi Tong', qty: 1, amount_sen: 1123 }, { id: 'm1', name: 'Barley', qty: 1, amount_sen: 274 });
  const checked = withCheck(r);
  assert.equal(shareOf(checked, { m0: 1 }).share_sen, 1123);
  assert.equal(shareOf({ ...checked, total_sen: 1500 }, { m0: 1 }).share_sen, Math.round((1500 * 1123) / 1397));
});

import { allocate, namesFor } from '../public/receipt.js';

// The KFC receipt from the screenshot: items RM43.37, 6% service tax RM2.60, total RM45.97.
const kfc = cleanReceipt({
  items: [{ name: 'Krispy B (1pc)', qty: 1, amount: 10.99 }, { name: 'Krispy C (1pc)', qty: 2, amount: 23.98 }, { name: 'Drink', qty: 3, amount: 8.4 }],
  charges: [{ name: 'Service Tax, 6%', amount: 2.6 }], total: 45.97,
});
const trio = [{ key: 'me', name: 'Me' }, { key: 'aina', name: 'Aina' }, { key: 'hafiz', name: 'Hafiz' }];

test('each person pays for their own items plus their part of tax, adding up to the bill', () => {
  const assign = { i0: { aina: 1 }, i1: { me: 1, hafiz: 1 }, i2: { me: 1, aina: 1, hafiz: 1 } };
  const { people, unassigned_sen } = allocate(kfc, assign, trio, 4597);
  const [me, aina, hafiz] = people;
  assert.equal(unassigned_sen, 0);
  assert.deepEqual([me.items_sen, aina.items_sen, hafiz.items_sen], [1479, 1379, 1479]);
  assert.equal(aina.share_sen, Math.round(1379 * 4597 / 4337));
  assert.equal(hafiz.share_sen, Math.round(1479 * 4597 / 4337));
  assert.equal(me.share_sen + aina.share_sen + hafiz.share_sen, 4597);
  assert.equal(namesFor(kfc, assign, 'me'), 'Krispy C (1pc), Drink');
});

test('a single item picked by two people is shared between them', () => {
  const { people } = allocate(kfc, { i0: { me: 1, aina: 1 } }, trio.slice(0, 2), 4597, 'me');
  assert.equal(people[1].items_sen, Math.round(1099 / 2));
});

test('items nobody picked are split equally, or left with you', () => {
  const equal = allocate(kfc, { i0: { aina: 1 } }, trio.slice(0, 2), 4597, 'equal');
  assert.equal(equal.unassigned_sen, 3238);
  assert.equal(equal.people[1].share_sen, Math.round((1099 + 3238 / 2) * 4597 / 4337));
  const mine = allocate(kfc, { i0: { aina: 1 } }, trio.slice(0, 2), 4597, 'me');
  assert.equal(mine.people[1].share_sen, Math.round(1099 * 4597 / 4337));
  assert.equal(mine.people[0].share_sen, 4597 - mine.people[1].share_sen);
});

test('on your own, only your items count, as before', () => {
  const { people } = allocate(kfc, { i1: { me: 1 }, i2: { me: 1 } }, trio.slice(0, 1), 4597);
  assert.equal(people[0].share_sen, shareOf(kfc, { i1: 1, i2: 1 }).share_sen);
  assert.equal(people[0].share_sen, 1568);
});
