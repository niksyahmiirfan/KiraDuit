// Itemised receipts: checking what the model read, and working out your share including tax and charges.
// Shared by the server and the app. All amounts are in sen.

export const MAX_ITEMS = 60;

const sen = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v ?? '').replace(/[^\d.-]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
};
const label = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Turns the model's reading into a checked receipt, or { error } if nothing usable was read. */
export function cleanReceipt(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : []).slice(0, MAX_ITEMS).flatMap((it, i) => {
    const name = label(it?.name, 60);
    const amount_sen = sen(it?.amount);
    const qty = Number.isInteger(it?.qty) && it.qty > 0 && it.qty <= 50 ? it.qty : 1;
    return name && amount_sen > 0 ? [{ id: `i${i}`, name, qty, amount_sen }] : [];
  });
  if (!items.length) return { error: "No items could be read from this receipt. Try a sharper, flatter photo." };
  const charges = (Array.isArray(raw?.charges) ? raw.charges : []).slice(0, 10).flatMap((c) => {
    const name = label(c?.name, 40);
    const amount_sen = sen(c?.amount);
    return name && amount_sen ? [{ name, amount_sen }] : [];
  });
  const items_sen = items.reduce((a, it) => a + it.amount_sen, 0);
  const charges_sen = charges.reduce((a, c) => a + c.amount_sen, 0);
  const read_total = sen(raw?.total);
  const total_sen = read_total > 0 ? read_total : items_sen + charges_sen;
  const subtotal_sen = sen(raw?.subtotal) > 0 ? sen(raw.subtotal) : null;
  return withCheck({ merchant: label(raw?.merchant, 120) || null, items, charges, items_sen, charges_sen, total_sen, subtotal_sen });
}

/**
 * Recomputes the sums and the mismatch warning after items are read or edited.
 * A mismatch usually means a line was misread or missed. The printed subtotal is the best check, when there is one.
 */
export function withCheck(r) {
  const items_sen = r.items.reduce((a, it) => a + it.amount_sen, 0);
  const target = r.subtotal_sen ?? r.total_sen - r.charges_sen;
  const gap = target - items_sen;
  return { ...r, items_sen, mismatch_sen: Math.abs(gap) > Math.max(10, Math.round(target * 0.01)) ? gap : 0 };
}

export function emptyReceipt(merchant = null) {
  return { merchant, items: [], charges: [], items_sen: 0, charges_sen: 0, total_sen: 0, subtotal_sen: null, mismatch_sen: 0 };
}

/**
 * Your share of a bill. picks maps item id to how many units are yours.
 * Tax, service charge, discounts and rounding are shared in proportion to what each person ordered,
 * so your share is the bill total times your fraction of the item total.
 */
export function shareOf(receipt, picks, bill_sen = receipt.total_sen || receipt.items_sen + receipt.charges_sen) {
  let mine = 0;
  for (const it of receipt.items) {
    const units = Math.min(Math.max(Number(picks[it.id]) || 0, 0), it.qty);
    mine += (it.amount_sen * units) / it.qty;
  }
  const items_sen = Math.round(mine);
  const share_sen = receipt.items_sen ? Math.round((bill_sen * mine) / receipt.items_sen) : 0;
  return { items_sen, share_sen, extra_sen: share_sen - items_sen };
}

/** A short description of the picked items for the What field. */
export function pickedNames(receipt, picks) {
  return receipt.items.filter((it) => picks[it.id] > 0)
    .map((it) => (picks[it.id] > 1 ? `${picks[it.id]}× ${it.name}` : it.name)).join(', ').slice(0, 120);
}

/**
 * Shares a bill between people by the items each had.
 * assign maps item id to { personKey: units }. Several people on one unit share it equally.
 * people is [{ key, name }] with you first, key 'me'.
 * Tax and charges follow each person's items. Items nobody picked are, with friends present,
 * split equally ('equal') or left with you ('me'). On your own, only your items count.
 * Friends' shares are rounded to the sen and your share is the rest, so the shares add up to the bill exactly.
 */
export function allocate(receipt, assign, people, bill_sen, leftover = 'equal') {
  const items = Object.fromEntries(people.map((p) => [p.key, 0]));
  let unassigned = 0;
  for (const it of receipt.items) {
    const units = Object.entries(assign[it.id] || {}).filter(([key, n]) => key in items && n > 0);
    const used = units.reduce((a, [, n]) => a + n, 0);
    if (!used) { unassigned += it.amount_sen; continue; }
    const per = it.amount_sen / Math.max(it.qty, used);
    for (const [key, n] of units) items[key] += per * n;
    unassigned += (it.amount_sen * Math.max(0, it.qty - used)) / it.qty;
  }
  const total = receipt.items_sen || 1;
  const scale = bill_sen / total;
  const friends = people.filter((p) => p.key !== 'me');
  const extra = friends.length && leftover === 'equal' ? unassigned / people.length : 0;
  const result = people.map((p) => ({ key: p.key, name: p.name, items_sen: Math.round(items[p.key]), share_sen: 0 }));
  for (const r of result) {
    if (r.key !== 'me') r.share_sen = Math.round((items[r.key] + extra) * scale);
  }
  const me = result.find((r) => r.key === 'me');
  me.share_sen = friends.length
    ? bill_sen - result.reduce((a, r) => a + (r.key === 'me' ? 0 : r.share_sen), 0)
    : Math.round(items.me * scale);
  return { people: result, unassigned_sen: Math.round(unassigned) };
}

/** What a person had, for the What field: "Nasi Lemak, 2× Teh Ais". */
export function namesFor(receipt, assign, key) {
  return receipt.items.filter((it) => assign[it.id]?.[key] > 0)
    .map((it) => (it.qty > 1 && assign[it.id][key] > 1 ? `${assign[it.id][key]}× ${it.name}` : it.name)).join(', ').slice(0, 120);
}
