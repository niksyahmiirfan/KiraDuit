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
