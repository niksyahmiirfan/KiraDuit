// Split-bill rules shared by the server and the demo, so both behave the same.

/** Asks about splitting a Food purchase of at least this much... */
export const SPLIT_MIN_SEN = 6000;
/** ...that is also more than this many times your usual Food purchase. */
export const SPLIT_TIMES_USUAL = 3;
export const MAX_FRIENDS = 20;

const toSen = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Your usual Food purchase, or null until there are enough purchases to judge. */
export const usualFood = (amounts) => (amounts.length >= 5 ? median(amounts) : null);

export function splitHint(t, usual) {
  if (t.category !== 'Food' || t.bill_sen || t.amount_sen < SPLIT_MIN_SEN) return false;
  return usual === null || t.amount_sen > usual * SPLIT_TIMES_USUAL;
}

/** Divides a bill equally between you and each friend. Any odd sen stay with you. */
export function equalShares(bill_sen, friends) {
  const each = Math.floor(bill_sen / (friends + 1));
  return { each, mine: bill_sen - each * friends };
}

/** Checks the friends' shares of a bill. Your share is whatever is left, and must be above RM0. */
export function cleanShares(bill_sen, input) {
  if (!Array.isArray(input) || !input.length) return { error: 'Add at least one friend.' };
  if (input.length > MAX_FRIENDS) return { error: `Split between at most ${MAX_FRIENDS} friends.` };
  const seen = new Set();
  const shares = [];
  for (const s of input) {
    const friend = String(s?.friend ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!friend) return { error: 'Enter a name for each friend.' };
    if (seen.has(friend.toLowerCase())) return { error: `${friend} is listed twice.` };
    seen.add(friend.toLowerCase());
    const amount_sen = s.amount_sen ?? toSen(s.amount);
    if (!Number.isInteger(amount_sen) || amount_sen <= 0) return { error: `Enter an amount above RM0 for ${friend}.` };
    shares.push({ friend, amount_sen });
  }
  const mine = bill_sen - shares.reduce((a, s) => a + s.amount_sen, 0);
  if (mine <= 0) return { error: "Friends' shares must add up to less than the bill, since your share must be above RM0." };
  return { shares, mine };
}

/** Groups unpaid shares by friend, largest amount owed first. */
export function groupOwed(rows) {
  const byFriend = new Map();
  for (const r of rows) {
    const key = r.friend.toLowerCase();
    const f = byFriend.get(key) || { name: r.friend, owed_sen: 0, shares: [] };
    f.owed_sen += r.amount_sen;
    f.shares.push(r);
    byFriend.set(key, f);
  }
  return [...byFriend.values()].sort((a, b) => b.owed_sen - a.owed_sen || a.name.localeCompare(b.name));
}
