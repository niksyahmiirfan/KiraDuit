import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanShares, equalShares, groupOwed, median, splitHint, usualFood } from '../public/split.js';

test('equal shares leave any odd sen with you', () => {
  assert.deepEqual(equalShares(20000, 4), { each: 4000, mine: 4000 });
  assert.deepEqual(equalShares(10000, 2), { each: 3333, mine: 3334 });
});

test('usual Food needs five purchases, then uses the median', () => {
  assert.equal(usualFood([1000, 2000]), null);
  assert.equal(usualFood([1000, 1200, 900, 30000, 1100]), 1100);
  assert.equal(median([1, 3, 2, 4]), 3);
});

test('split hints need Food, at least RM60, and over 3 times usual', () => {
  assert.ok(splitHint({ category: 'Food', amount_sen: 6000 }, null));
  assert.ok(!splitHint({ category: 'Food', amount_sen: 5999 }, null));
  assert.ok(!splitHint({ category: 'Food', amount_sen: 9000 }, 3000));
  assert.ok(splitHint({ category: 'Food', amount_sen: 9001 }, 3000));
  assert.ok(!splitHint({ category: 'Shopping', amount_sen: 50000 }, 1000));
  assert.ok(!splitHint({ category: 'Food', amount_sen: 4000, bill_sen: 20000 }, 1000));
});

test('shares are cleaned and must leave you a share', () => {
  assert.deepEqual(cleanShares(20000, [{ friend: '  Aina  Ali ', amount: 'RM40' }]), { shares: [{ friend: 'Aina Ali', amount_sen: 4000 }], mine: 16000 });
  assert.match(cleanShares(20000, []).error, /at least one/);
  assert.match(cleanShares(20000, [{ friend: '', amount: 1 }]).error, /name/);
  assert.match(cleanShares(20000, [{ friend: 'A', amount: 0 }]).error, /above RM0/);
  assert.match(cleanShares(20000, [{ friend: 'A', amount: 200 }]).error, /less than the bill/);
});

test('owed shares group by friend regardless of case', () => {
  const g = groupOwed([{ friend: 'Aina', amount_sen: 1000 }, { friend: 'ben', amount_sen: 5000 }, { friend: 'aina', amount_sen: 2000 }]);
  assert.deepEqual(g.map((f) => [f.name, f.owed_sen, f.shares.length]), [['ben', 5000, 1], ['Aina', 3000, 2]]);
});
