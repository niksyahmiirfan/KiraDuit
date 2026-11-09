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
export function summarize(txs, date, budget = null, budgetSource = null) {
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
    budget,
    budgetSource,
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

export function budgetLine(total, budget) {
  if (!budget) return null;
  const diff = budget - total;
  return diff >= 0
    ? `${formatRM(diff)} left of your ${formatRM(budget)} budget`
    : `${formatRM(-diff)} over your ${formatRM(budget)} budget`;
}

export function reportText(s) {
  if (!s.count) return s.budget ? `Nothing logged today. Your budget was ${formatRM(s.budget)}.` : 'Nothing logged today.';
  const lines = [`${formatRM(s.total)} across ${s.count} ${s.count === 1 ? 'purchase' : 'purchases'}.`];
  if (s.budget) lines.push(`${budgetLine(s.total, s.budget)}.`);
  else if (s.usual !== null) {
    const diff = s.total - s.usual;
    lines.push(diff === 0 ? 'Right on your usual day.' : `${formatRM(Math.abs(diff))} ${diff < 0 ? 'below' : 'above'} your usual day.`);
  }
  lines.push(`Top: ${s.byCategory.slice(0, 2).map((c) => `${c.name} ${formatRM(c.total)}`).join(', ')}.`);
  if (s.needsReview) lines.push(`${s.needsReview} to check.`);
  return lines.join(' ');
}

export const PAY_DAY = 27;

/** The pay period containing a date: the 27th through the 26th of the next month. */
export function payPeriod(date) {
  const [y, m, d] = date.split('-').map(Number);
  const startMonth = d >= PAY_DAY ? m - 1 : m - 2; // zero-based
  const iso = (mo) => new Date(Date.UTC(y, mo, PAY_DAY)).toISOString().slice(0, 10);
  return { start: iso(startMonth), end: addDays(iso(startMonth + 1), -1) };
}

export function periodFor(view, date) {
  if (view === 'month') return payPeriod(date);
  const days = weekDates(date);
  return { start: days[0], end: days[6] };
}

const dayCount = (start, end) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;

/** @param txs transactions within the period. @param income sen for the period, or null. */
export function summarizePeriod(txs, { view, start, end, today, income = null, commitments = 0 }) {
  const inPeriod = txs.filter((t) => t.local_date >= start && t.local_date <= end);
  const total = inPeriod.reduce((sum, t) => sum + t.amount_sen, 0);
  const byDay = new Map();
  for (const t of inPeriod) byDay.set(t.local_date, (byDay.get(t.local_date) || 0) + t.amount_sen);

  const length = dayCount(start, end);
  const days = Array.from({ length }, (_, i) => {
    const date = addDays(start, i);
    return { date, total: byDay.get(date) || 0 };
  });
  const elapsed = today < start ? 0 : dayCount(start, today < end ? today : end);
  const biggest = days.reduce((max, d) => (d.total > (max?.total || 0) ? d : max), null);

  const out = {
    view, start, end, today, total, days, biggest,
    count: inPeriod.length,
    average: elapsed ? Math.round(total / elapsed) : 0,
    byCategory: groupTotals(inPeriod, 'category'),
    bySource: groupTotals(inPeriod, 'source'),
    income,
    commitments,
  };
  if (view === 'month') {
    out.left = income === null ? null : income - commitments - total;
    out.nextPayday = addDays(end, 1);
    const isCurrent = today >= start && today <= end;
    out.daysToPayday = isCurrent ? dayCount(today, out.nextPayday) - 1 : null;
    out.dailyAllowance = isCurrent && income !== null ? Math.max(0, Math.floor(out.left / out.daysToPayday)) : null;
  }
  return out;
}

/** What can be spent per day from the start of today until payday, or null if nothing is left. */
export function allowanceFor({ income, commitments, spentBefore, today }) {
  if (income === null) return null;
  const days = dayCount(today, payPeriod(today).end);
  const amount = Math.floor((income - commitments - spentBefore) / days);
  return amount > 0 ? amount : null;
}

const csvCell = (value) => {
  let v = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; // stops spreadsheets running a merchant name as a formula
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function toCsv(txs) {
  const rows = [...txs].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).map((t) => {
    const local = new Date(new Date(t.occurred_at).getTime() + MYT_OFFSET_MS).toISOString();
    return [t.local_date, local.slice(11, 16), t.merchant, t.category, (t.amount_sen / 100).toFixed(2), SOURCE_LABELS[t.source], t.card, t.needs_review ? 'yes' : 'no'].map(csvCell).join(',');
  });
  return `Date,Time,Merchant,Category,Amount (RM),Paid with,Card,Needs checking\r\n${rows.join('\r\n')}\r\n`;
}
