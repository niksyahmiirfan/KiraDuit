// Shared by the Worker and the dashboard, so both calculate the day identically.
export const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Bills', 'Fun', 'Other'];
export const SOURCE_LABELS = { shopeepay_qr: 'ShopeePay QR', apple_pay: 'Apple Pay', manual: 'Added by hand' };

const MYT_OFFSET_MS = 8 * 3600 * 1000;

export const localDate = (d = new Date()) => new Date(d.getTime() + MYT_OFFSET_MS).toISOString().slice(0, 10);

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekDates(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const monday = addDays(date, -((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function formatRM(sen) {
  const [whole, cents] = (sen / 100).toFixed(2).split('.');
  return `RM${Number(whole).toLocaleString('en-MY')}.${cents}`;
}

/** Earliest date summarize() needs for a given day. */
export function windowStart(date) {
  const candidates = [addDays(date, -28), `${date.slice(0, 7)}-01`, weekDates(date)[0]];
  return candidates.sort()[0];
}

const groupTotals = (txs, key) => {
  const totals = new Map();
  for (const t of txs) totals.set(t[key], (totals.get(t[key]) || 0) + t.amount_sen);
  return [...totals].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
};

/** @param txs transactions covering at least windowStart(date)..end of date's week */
export function summarize(txs, date) {
  const today = txs
    .filter((t) => t.local_date === date)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const total = today.reduce((sum, t) => sum + t.amount_sen, 0);

  const byDay = new Map();
  for (const t of txs) byDay.set(t.local_date, (byDay.get(t.local_date) || 0) + t.amount_sen);

  // "Usual" = average of the days you actually spent on in the previous 4 weeks.
  const earlier = [];
  for (let i = 1; i <= 28; i++) {
    const v = byDay.get(addDays(date, -i));
    if (v) earlier.push(v);
  }
  const usual = earlier.length >= 3 ? Math.round(earlier.reduce((a, b) => a + b, 0) / earlier.length) : null;

  const month = date.slice(0, 7);
  const monthTotal = [...byDay].reduce((s, [d, v]) => (d.startsWith(month) && d <= date ? s + v : s), 0);

  return {
    date,
    total,
    count: today.length,
    usual,
    monthTotal,
    needsReview: today.filter((t) => t.needs_review).length,
    largest: today.reduce((max, t) => (!max || t.amount_sen > max.amount_sen ? t : max), null),
    byCategory: groupTotals(today, 'category'),
    bySource: groupTotals(today, 'source'),
    week: weekDates(date).map((d) => ({ date: d, total: byDay.get(d) || 0 })),
    transactions: today,
  };
}

export function reportText(s) {
  if (!s.count) return 'Nothing logged today.';
  const lines = [`${formatRM(s.total)} across ${s.count} ${s.count === 1 ? 'purchase' : 'purchases'}.`];
  if (s.usual !== null) {
    const diff = s.total - s.usual;
    lines.push(diff === 0 ? 'Right on your usual day.' : `${formatRM(Math.abs(diff))} ${diff < 0 ? 'below' : 'above'} your usual day.`);
  }
  lines.push(`Top: ${s.byCategory.slice(0, 2).map((c) => `${c.name} ${formatRM(c.total)}`).join(', ')}.`);
  if (s.needsReview) lines.push(`${s.needsReview} to check.`);
  return lines.join(' ');
}
