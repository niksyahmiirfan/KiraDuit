import { cleanReceipt, pickedNames, shareOf } from './receipt.js';
import { DEFAULT_SHORTCUTS, MAX_SHORTCUTS, cleanShortcut, cleanShortcuts, shortcutCaption, shortcutHref } from './shortcuts.js';
import { cleanShares, equalShares, groupOwed, splitHint, usualFood } from './split.js';
import { CATEGORIES, addDays, budgetLine, formatRM, localDate, allowanceFor, payPeriod, periodFor, previousRange, summarize, summarizePeriod, windowStart } from './summary.js';

const DEMO = Boolean(window.KIRADUIT_DEMO);
const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const time = (iso) => new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)).toLowerCase();
const minutesInto = (iso) => { const d = new Date(new Date(iso).getTime() + 8 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dayName = (d, opts) => new Intl.DateTimeFormat('en-MY', { timeZone: 'UTC', ...opts }).format(new Date(`${d}T00:00:00Z`));

let date = localDate();
let summary = null;
let selected = null;
// Purchase list page on Day. null means "show the page holding the selected purchase".
let buyPage = 0;
let buyPageDate = null;
const BUYS_PER_PAGE = 5;
let page = 'home';
let range = store.get('kd-range') === 'month' ? 'month' : 'week';
let homeDate = localDate();
let home = null;
let moneyOpen = false;

/* ---- data ---- */
function makeDemoData() {
  const places = [
    ['Kopitiam Sri Damai', 'Food', 'shopeepay_qr', 720, 8, 12], ['Grab', 'Transport', 'apple_pay', 1450, 8, 41],
    ['Restoran Nasi Kandar Pelita', 'Food', 'shopeepay_qr', 1290, 12, 58], ['ZUS Coffee', 'Food', 'shopeepay_qr', 990, 15, 21],
    ['99 Speedmart', 'Groceries', 'shopeepay_qr', 2340, 18, 7], ['Parking Mid Valley', 'Transport', 'apple_pay', 300, 18, 52],
    ['Gerai Burger Abang Li', 'Food', 'shopeepay_qr', 650, 21, 15],
  ];
  const today = localDate();
  const txs = [];
  const iso = (d, h, m) => new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`).toISOString();
  const nowMinutes = minutesInto(new Date().toISOString());
  for (let back = 0; back < 40; back++) {
    const d = addDays(today, -back);
    places.forEach(([merchant, category, source, sen, h, m], i) => {
      const vary = (back * 7 + i * 3) % 5;
      if (back > 0 && vary === 0) return;
      if (back === 0 && h * 60 + m > Math.max(nowMinutes, 19 * 60)) return;
      txs.push({ id: `${back}-${i}`, amount_sen: Math.round(sen * (back ? 0.8 + vary * 0.12 : 1) / 10) * 10, merchant, category, source, occurred_at: iso(d, h, m), local_date: d, needs_review: 0 });
    });
  }
  txs.push({ id: 'group-lunch', amount_sen: 18600, merchant: 'Restoran Tomyam Seri Pagi', category: 'Food', source: 'apple_pay', occurred_at: iso(today, 13, 5), local_date: today, needs_review: 0 });
  const unsure = txs.find((t) => t.local_date === today && t.merchant === 'ZUS Coffee');
  if (unsure) { unsure.merchant = 'ShopeePay QR'; unsure.category = 'Other'; unsure.needs_review = 1; }
  return txs;
}
const demoTxs = DEMO ? makeDemoData() : [];
const demoBudgets = DEMO ? { [localDate()]: 6000 } : {};
let demoIncome = DEMO ? 450000 : null;
let demoDefault = null;
let demoCommitments = DEMO ? [{ id: 'c1', name: 'Rent', amount_sen: 90000 }, { id: 'c2', name: 'Car loan', amount_sen: 65000 }, { id: 'c3', name: 'Phone plan', amount_sen: 6800 }] : [];
const demoReceipts = new Map();
let demoShortcuts = DEFAULT_SHORTCUTS.map((s) => ({ ...s }));
const demoSplits = new Map(); // purchase id -> { bill_sen, shares: [{ id, friend, amount_sen, paid }] }
const demoOwedRows = () => [...demoSplits].flatMap(([id, s]) => {
  const t = demoTxs.find((x) => x.id === id);
  return s.shares.filter((x) => !x.paid).map((x) => ({ ...x, transaction_id: id, merchant: t.merchant, item: t.item, local_date: t.local_date }));
});
function demoWithSplits(txs) {
  const usual = usualFood(demoTxs.filter((t) => t.category === 'Food' && !demoSplits.has(t.id)).map((t) => t.amount_sen));
  return txs.map((t) => {
    const s = demoSplits.get(t.id);
    const row = { ...t, has_receipt: demoReceipts.has(t.id) ? 1 : 0, bill_sen: s?.bill_sen ?? null, owed_sen: s ? s.shares.filter((x) => !x.paid).reduce((a, x) => a + x.amount_sen, 0) : 0 };
    return { ...row, split_hint: splitHint(row, usual) };
  });
}
const commitmentsTotal = () => demoCommitments.reduce((a, c) => a + c.amount_sen, 0);
function demoBudget(d) {
  if (demoBudgets[d]) return { amount: demoBudgets[d], source: 'set' };
  if (d !== localDate()) return { amount: null, source: null };
  if (demoDefault) return { amount: demoDefault, source: 'default' };
  const spentBefore = demoTxs.filter((t) => t.local_date >= payPeriod(d).start && t.local_date < d).reduce((a, t) => a + t.amount_sen, 0);
  const amount = allowanceFor({ income: demoIncome, commitments: commitmentsTotal(), spentBefore, today: d });
  return { amount, source: amount ? 'allowance' : null };
}

const toSen = (v) => Math.round(parseFloat(v) * 100);

let signedIn = false;
const jsonHeaders = { 'content-type': 'application/json', 'x-requested-with': 'kiraduit' };

async function request(path, options = {}) {
  const res = await fetch(path, { ...options, headers: jsonHeaders });
  if (res.status === 401) {
    renderGate(signedIn ? 'Your session ended. Enter your access key to continue.' : '');
    signedIn = false;
    throw new Error('unauthorized');
  }
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* plain text reply */ }
  if (!res.ok) throw new Error(parsed?.error || (res.status === 422 ? body : 'Could not save. Check your connection and try again.'));
  return parsed ?? body;
}
const api = DEMO ? {
  load: async (d) => summarize(demoWithSplits(demoTxs.filter((t) => t.local_date >= windowStart(d))), d, demoBudget(d).amount, demoBudget(d).source),
  loadHome: async (view, d) => {
    const today = localDate();
    return {
      ...summarizePeriod(demoTxs, { view, ...periodFor(view, d), today, income: demoIncome, commitments: commitmentsTotal() }),
      commitmentList: demoCommitments,
      previousTotal: (() => { const { start, end } = periodFor(view, d); const p = previousRange(view, start, end, today); return demoTxs.filter((t) => t.local_date >= p.start && t.local_date <= p.end).reduce((a, t) => a + t.amount_sen, 0); })(),
      receiptCandidate: demoTxs.filter((t) => t.source === 'shopeepay_qr' && t.local_date === today && !demoReceipts.has(t.id)).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0] || null,
      todayTotal: demoTxs.filter((t) => t.local_date === today).reduce((a, t) => a + t.amount_sen, 0),
      todayBudget: demoBudget(today).amount,
      todayBudgetSource: demoBudget(today).source,
      defaultBudget: demoDefault,
      owedList: groupOwed(demoOwedRows()).map((f) => ({ name: f.name, owed_sen: f.owed_sen, bills: f.shares.length })),
      owedTotal: demoOwedRows().reduce((a, x) => a + x.amount_sen, 0),
    };
  },
  split: async (id) => {
    const t = demoTxs.find((x) => x.id === id);
    const s = demoSplits.get(id);
    const recent = [...new Set([...demoSplits.values()].flatMap((x) => x.shares.map((y) => y.friend)).concat(['Aina', 'Hafiz', 'Mei Ling', 'Arjun']))];
    return { bill_sen: s?.bill_sen ?? t.amount_sen, mine_sen: t.amount_sen, shares: s?.shares ?? [], recent };
  },
  saveSplit: async (id, input) => {
    const t = demoTxs.find((x) => x.id === id);
    const before = demoSplits.get(id);
    const bill_sen = before?.bill_sen ?? t.amount_sen;
    const { shares, mine, error } = cleanShares(bill_sen, input);
    if (error) throw new Error(error);
    const paid = new Set(before?.shares.filter((x) => x.paid).map((x) => x.friend.toLowerCase()));
    demoSplits.set(id, { bill_sen, shares: shares.map((x, i) => ({ ...x, id: `${id}-s${i}-${Date.now()}`, paid: paid.has(x.friend.toLowerCase()) })) });
    t.amount_sen = mine;
  },
  unsplit: async (id) => { const s = demoSplits.get(id); if (s) { demoTxs.find((x) => x.id === id).amount_sen = s.bill_sen; demoSplits.delete(id); } },
  owed: async () => ({ friends: groupOwed(demoOwedRows()) }),
  receiptItems: async () => {
    await new Promise((r) => setTimeout(r, 500));
    return cleanReceipt({
      merchant: 'Restoran Tomyam Seri Pagi',
      items: [{ name: 'Nasi Goreng Kampung', qty: 1, amount: 12 }, { name: 'Tomyam Campur (Besar)', qty: 1, amount: 38 },
        { name: 'Telur Dadar', qty: 1, amount: 8 }, { name: 'Teh Ais', qty: 3, amount: 10.5 }, { name: 'Sirap Limau', qty: 2, amount: 7 },
        { name: 'Kailan Ikan Masin', qty: 1, amount: 14 }, { name: 'Ayam Goreng Berempah', qty: 2, amount: 24 }, { name: 'Nasi Putih', qty: 4, amount: 10 }],
      charges: [{ name: 'Service charge 10%', amount: 12.35 }, { name: 'SST 6%', amount: 8.15 }],
      total: 144.0,
    });
  },
  shortcuts: async () => ({ shortcuts: demoShortcuts }),
  saveShortcuts: async (list) => { const r = cleanShortcuts(list); if (r.error) throw new Error(r.error); demoShortcuts = r.shortcuts; return r; },
  setPaid: async (shareId, paid) => { for (const s of demoSplits.values()) for (const x of s.shares) if (x.id === shareId) x.paid = paid; },
  setBudget: async (d, amount) => { demoBudgets[d] = toSen(amount); },
  setIncome: async (amount) => { demoIncome = toSen(amount); },
  getReceipt: async (id) => demoReceipts.get(id),
  setReceipt: async (id, base64) => { demoReceipts.set(id, `data:image/jpeg;base64,${base64}`); },
  removeReceipt: async (id) => { demoReceipts.delete(id); },
  setDefaultBudget: async (amount) => { demoDefault = amount ? toSen(amount) : null; },
  addCommitment: async (f) => demoCommitments.push({ id: `c${Date.now()}`, name: f.name, amount_sen: toSen(f.amount) }),
  removeCommitment: async (id) => { demoCommitments = demoCommitments.filter((c) => c.id !== id); },
  update: async (id, f) => {
    const t = demoTxs.find((x) => x.id === id);
    // Like the server, only the fields sent are changed.
    if (f.merchant !== undefined) t.merchant = f.merchant;
    if (f.item !== undefined) t.item = f.item || null;
    if (f.category !== undefined) t.category = f.category;
    if (f.amount !== undefined) t.amount_sen = Math.round(parseFloat(f.amount) * 100);
    if (f.date !== undefined) { t.local_date = f.date; t.occurred_at = new Date(`${f.date}T${f.time}:00+08:00`).toISOString(); }
    if (f.merchant !== undefined || f.category !== undefined) t.needs_review = 0;
  },
  remove: async (id) => demoTxs.splice(demoTxs.findIndex((x) => x.id === id), 1),
  draft: async (text) => ({ skipped: 0, items: [...text.matchAll(/([^,\d]+?)\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => ({ item: m[1].replace(/^\s*,?\s*/, '').trim(), merchant: (text.match(/\bat\s+(.+)$/i) || [])[1]?.trim() || '', amount_sen: toSen(m[2]), category: 'Food' })) }),
  add: async (f) => demoTxs[demoTxs.push({ id: `m${Date.now()}`, merchant: f.merchant, item: f.item || null, category: f.category, amount_sen: Math.round(parseFloat(f.amount) * 100), source: 'manual', occurred_at: new Date(`${f.date}T${f.time}:00+08:00`).toISOString(), local_date: f.date, needs_review: 0 }) - 1],
} : {
  load: (d) => request(`/api/summary?date=${d}`),
  loadHome: (view, d) => request(`/api/home?view=${view}&date=${d}`),
  setBudget: (d, amount) => request(`/api/budget?date=${d}`, { method: 'POST', body: JSON.stringify({ amount }) }),
  setIncome: (amount) => request('/api/income', { method: 'POST', body: JSON.stringify({ amount }) }),
  getReceipt: async (id) => {
    const res = await fetch(`/api/transactions/${id}/receipt`);
    if (!res.ok) throw new Error('The receipt photo could not be loaded.');
    return URL.createObjectURL(await res.blob());
  },
  setReceipt: (id, image) => request(`/api/transactions/${id}/receipt`, { method: 'POST', body: JSON.stringify({ image }) }),
  removeReceipt: (id) => request(`/api/transactions/${id}/receipt`, { method: 'DELETE' }),
  setDefaultBudget: (amount) => request('/api/default-budget', { method: 'POST', body: JSON.stringify({ amount }) }),
  addCommitment: (f) => request('/api/commitments', { method: 'POST', body: JSON.stringify(f) }),
  removeCommitment: (id) => request(`/api/commitments/${id}`, { method: 'DELETE' }),
  update: (id, f) => request(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(f) }),
  remove: (id) => request(`/api/transactions/${id}`, { method: 'DELETE' }),
  add: (f) => request('/api/transactions', { method: 'POST', body: JSON.stringify(f) }),
  draft: (text) => request('/api/draft', { method: 'POST', body: JSON.stringify({ text }) }),
  split: (id) => request(`/api/transactions/${id}/split`),
  saveSplit: (id, shares) => request(`/api/transactions/${id}/split`, { method: 'PUT', body: JSON.stringify({ shares }) }),
  unsplit: (id) => request(`/api/transactions/${id}/split`, { method: 'DELETE' }),
  owed: () => request('/api/owed'),
  receiptItems: (body) => request('/api/receipt-items', { method: 'POST', body: JSON.stringify(body) }),
  shortcuts: () => request('/api/shortcuts'),
  saveShortcuts: (shortcuts) => request('/api/shortcuts', { method: 'PUT', body: JSON.stringify({ shortcuts }) }),
  setPaid: (shareId, paid) => request(`/api/shares/${shareId}`, { method: 'POST', body: JSON.stringify({ paid }) }),
};

/* ---- views ---- */
function renderGate(message = '') {
  app.innerHTML = `<form class="gate"><h1>KiraDuit</h1><p>Enter your access key to see your spending.</p>
    <label>Access key<input name="key" type="password" autocomplete="current-password" required></label>
    ${message ? `<p class="error">${esc(message)}</p>` : ''}<button class="primary">Unlock</button></form>`;
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ key: new FormData(e.target).get('key') }) });
      if (res.ok) { signedIn = true; return refresh(); }
      const body = await res.json().catch(() => ({}));
      renderGate(body.error || 'That access key was not accepted.');
    } catch { renderGate('Could not reach KiraDuit. Check your connection and try again.'); }
  };
}

async function signOut() {
  await fetch('/api/logout', { method: 'POST', headers: jsonHeaders }).catch(() => {});
  signedIn = false;
  renderGate();
}

function verdict(s) {
  const today = date === localDate();
  const n = `${s.count} ${s.count === 1 ? 'purchase' : 'purchases'}${today ? ' so far' : ''}`;
  if (!s.count) return `<p class="verdict">${today ? 'Nothing logged yet today.' : 'Nothing logged on this day.'}</p>`;
  let compare = '';
  if (s.usual !== null) {
    const diff = s.total - s.usual;
    compare = `<span>${formatRM(Math.abs(diff))} ${diff <= 0 ? 'below' : 'above'} your usual ${formatRM(s.usual)}</span>`;
  }
  return `<p class="verdict">${n}${compare}</p>`;
}

const spentAt = (t) => `${formatRM(t.amount_sen)}${t.item ? ` for ${t.item}` : ''} at ${t.merchant}`;

const ribbon = (s) => {
  if (!s.count) return '';
  const max = s.largest.amount_sen;
  const ticks = s.transactions.map((t) => {
    const h = Math.max(10, Math.round((t.amount_sen / max) * 68));
    return `<button class="tick" data-tick="${esc(t.id)}" aria-pressed="${t.id === selected}" style="left:${(minutesInto(t.occurred_at) / 1440) * 100}%"
      aria-label="${esc(`${spentAt(t)}, ${time(t.occurred_at)}`)}"><i style="height:${h}px"></i></button>`;
  }).join('');
  const pick = s.transactions.find((t) => t.id === selected);
  const line = pick ? `${spentAt(pick)}, ${time(pick.occurred_at)}`
    : `Largest was ${spentAt(s.largest)}, ${time(s.largest.occurred_at)}`;
  return `<div class="ribbon"><div class="ribbon-track">${ticks}</div>
    <div class="hours"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span></div>
    <p class="readout" aria-live="polite">${esc(line)}</p></div>`;
};

function setOver(isOver) {
  document.documentElement.classList.toggle('over', isOver);
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', paper));
}

const bigTotal = (sen) => {
  const cents = (sen / 100).toFixed(2).split('.')[1];
  return `<div class="total" aria-label="${formatRM(sen)}"><span class="rm">RM</span><span class="whole">${Math.floor(sen / 100).toLocaleString('en-MY')}</span><span class="sen">.${cents}</span></div>`;
};

const AUTO_NOTE = { default: ' (your default)', allowance: ' (from what you can spend per day)' };

function budgetStrip(total, budget, label, day, source = 'set') {
  if (!budget) return `<button class="budget" data-budget="${day}"><span class="prompt">Set ${label === 'Today' ? "today's" : "this day's"} budget</span></button>`;
  const over = total > budget;
  return `<button class="budget ${over ? 'over' : ''}" data-budget="${day}" aria-label="${label}: ${esc(budgetLine(total, budget))}. Change budget">
    <div><b>${label}</b><span>${formatRM(total)} of ${formatRM(budget)}</span></div>
    <span class="gauge"><i style="width:${Math.min(100, (total / budget) * 100)}%"></i></span>
    <span class="note">${esc(budgetLine(total, budget))}${AUTO_NOTE[source] || ''}</span></button>`;
}

const breakdown = (s) => {
  const top = s.byCategory[0]?.total || 1;
  return `<section><h2>Where it went</h2>
    ${s.byCategory.map((c) => `<div class="bar-row"><div><b>${esc(c.name)}</b><span>${formatRM(c.total)}</span></div><span class="bar" style="width:${Math.max(2, (c.total / top) * 100)}%"></span></div>`).join('')}
  </section>
  <section><h2>How you paid</h2><div class="paid">
    ${s.bySource.map((p) => `<div><span>${esc(p.name)}</span><b>${formatRM(p.total)}</b></div>`).join('')}
  </div></section>`;
};

const ICONS = {
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-6h4v6"/>',
  day: '<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/><path d="M8 14h3v3H8z"/>',
  links: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><path d="M16.75 13.5v6.5M13.5 16.75H20"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  photo: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M20 16l-5-5-7 8"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
  signout: '<path d="M14 4H6v16h8"/><path d="M10 12h10M16 8l4 4-4 4"/>',
  split: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M14.5 14.6c2.6-.6 5 .8 5.8 4.4"/>',
  settled: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15 11.5l2 2 4-4.5"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const TABS = [['home', 'Home'], ['day', 'Day'], ['links', 'Shortcuts']];

const dock = () => `<nav class="dock" aria-label="Main">
  ${TABS.map(([id, label]) => `<button data-page="${id}" aria-label="${label}" title="${label}" ${page === id ? 'aria-current="page"' : ''}>${icon(id)}</button>`).join('')}
  <button data-add aria-label="Add purchase" title="Add purchase">${icon('add')}</button></nav>`;

const shortDate = (d) => dayName(d, { day: 'numeric', month: 'short' });

const heroMoney = (sen) => {
  const [whole, cents] = formatRM(sen).split('.');
  return `${whole}<small>.${cents}</small>`;
};

function compareLine(h, noun) {
  if (!h.previousTotal) return null;
  const diff = h.total - h.previousTotal;
  if (diff === 0) return `Same as ${noun}`;
  return `${formatRM(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than ${noun}`;
}

function heroBody(h) {
  if (h.view === 'week') {
    return `<p class="hero-label">Spent this week</p><p class="hero-num">${heroMoney(h.total)}</p>
      <p class="hero-sub">${compareLine(h, 'this point last week') || `${h.count} ${h.count === 1 ? 'purchase' : 'purchases'}`}</p>`;
  }
  if (h.income === null) {
    return `<p class="hero-label">Spent this pay period</p><p class="hero-num">${heroMoney(h.total)}</p>
      <button class="hero-add" data-income>Add your monthly income</button>`;
  }
  const current = h.daysToPayday !== null;
  const over = h.left < 0;
  const share = (v) => `${Math.min(100, (v / Math.max(h.income, h.commitments + h.total)) * 100)}%`;
  return `<p class="hero-label">${over ? 'Overspent' : current ? `Left until ${shortDate(h.nextPayday)}` : 'Left over from this pay period'}</p>
    <p class="hero-num">${heroMoney(Math.abs(h.left))}</p>
    ${current ? `<p class="hero-sub">${formatRM(h.dailyAllowance)} a day for ${h.daysToPayday} ${h.daysToPayday === 1 ? 'day' : 'days'}</p>` : ''}
    <div class="stack" aria-hidden="true">
      ${h.commitments ? `<i class="s-committed" style="width:${share(h.commitments)}"></i>` : ''}
      ${h.total ? `<i class="s-spent" style="width:${share(h.total)}"></i>` : ''}
      ${over ? '' : '<i class="s-left"></i>'}
    </div>
    <div class="key"><div><span>Income</span><b>${formatRM(h.income)}</b></div><div><span>Committed</span><b>${formatRM(h.commitments)}</b></div><div><span>Spent</span><b>${formatRM(h.total)}</b></div></div>`;
}

function todayTile(h) {
  if (!h.todayBudget) {
    return `<button class="tile" data-budget="${h.today}"><span>Today</span><b>${formatRM(h.todayTotal)}</b><small class="prompt">Set today's budget</small></button>`;
  }
  const diff = h.todayBudget - h.todayTotal;
  const auto = h.todayBudgetSource === 'set' ? '' : ' (auto)';
  return `<button class="tile ${diff < 0 ? 'over' : ''}" data-budget="${h.today}" aria-label="Today: ${esc(budgetLine(h.todayTotal, h.todayBudget))}. Change budget">
    <span>Today</span><b>${formatRM(h.todayTotal)}</b>
    <span class="gauge"><i style="width:${Math.min(100, (h.todayTotal / h.todayBudget) * 100)}%"></i></span>
    <small>${formatRM(Math.abs(diff))} ${diff < 0 ? 'over' : 'left'}${auto}</small></button>`;
}

function calendar(h) {
  const spent = h.days.map((d) => d.total).filter(Boolean);
  const low = Math.min(...spent);
  const high = Math.max(...spent);
  // Scaled between your cheapest and dearest day, so ordinary differences still show.
  const bucket = (v) => (!v ? 0 : high === low ? 2 : 1 + Math.min(3, Math.floor(((v - low) / (high - low)) * 4)));
  const offset = (new Date(`${h.start}T00:00:00Z`).getUTCDay() + 6) % 7;
  const heads = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span>${d[0]}</span>`).join('');
  const cells = h.days.map((d, i) => `<button class="cell h${bucket(d.total)} ${d.date === h.today ? 'today' : ''}" data-day="${d.date}"
    ${i === 0 && offset ? `style="grid-column-start:${offset + 1}"` : ''} ${d.date > h.today ? 'disabled' : ''}
    aria-label="${shortDate(d.date)}, ${formatRM(d.total)}">${Number(d.date.slice(8))}</button>`).join('');
  return `<section><h2>${h.view === 'month' ? 'Spending calendar' : 'This week by day'}${h.biggest ? `<small>Highest ${formatRM(h.biggest.total)}</small>` : ''}</h2>
    <div class="cal-head">${heads}</div><div class="cal">${cells}</div>
    <div class="cal-key">Less<i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i>More</div></section>`;
}

function topSpending(h) {
  return `<section><h2>Top spending</h2>
    ${h.byCategory.slice(0, 5).map((c) => `<div class="rank"><span>${esc(c.name)}<em>${Math.round((c.total / h.total) * 100)}%</em></span><span>${formatRM(c.total)}</span></div>`).join('')}
    <div class="sub-head">Paid with</div>
    ${h.bySource.map((p) => `<div class="rank"><span>${esc(p.name)}</span><span>${formatRM(p.total)}</span></div>`).join('')}
  </section>`;
}

function moneySetup(h) {
  const current = h.daysToPayday !== null;
  const rows = h.commitmentList.map((c) => (current
    ? `<button class="list-row" data-commitment="${esc(c.id)}"><span>${esc(c.name)}</span><span>${formatRM(c.amount_sen)}</span></button>`
    : `<div class="list-row"><span>${esc(c.name)}</span><span>${formatRM(c.amount_sen)}</span></div>`)).join('');
  return `<section><details ${moneyOpen ? 'open' : ''} data-money><summary>Income and commitments</summary>
    <button class="list-row" data-income><span>Income on the 27th</span><span>${h.income === null ? 'Add' : formatRM(h.income)}</span></button>
    <div class="sub-head">Fixed commitments</div>
    ${rows}${current ? '<button class="text-action" data-add-commitment>Add a commitment</button>' : ''}
  </details></section>`;
}

function owedBlock(h) {
  if (!h.owedTotal) return '';
  return `<section><h2>Owed to you<small>${formatRM(h.owedTotal)}</small></h2>
    ${h.owedList.map((f) => `<button class="list-row" data-friend="${esc(f.name)}"><span>${esc(f.name)}</span>
      <span>${formatRM(f.owed_sen)}${f.bills > 1 ? ` · ${f.bills} bills` : ''}</span></button>`).join('')}</section>`;
}

const dismissedSplits = () => { try { return JSON.parse(store.get('kd-no-split') || '[]'); } catch { return []; } };

function splitPrompt(s) {
  const skip = dismissedSplits();
  const t = [...s.transactions].reverse().find((x) => x.split_hint && !skip.includes(x.id));
  if (!t) return '';
  return `<div class="receipt-card"><p>${esc(spentAt(t))} looks like a group meal. Split the bill?</p>
    <div><button data-split="${esc(t.id)}">Split bill</button><button data-split-skip="${esc(t.id)}">No</button></div></div>`;
}

const RECEIPT_PROMPT_MS = 30 * 60 * 1000;

function receiptPrompt(t) {
  if (!t || Date.now() - new Date(t.occurred_at).getTime() > RECEIPT_PROMPT_MS || store.get('kd-no-receipt') === t.id) return '';
  return `<div class="receipt-card"><p>Add a receipt for ${esc(spentAt(t))}?</p>
    <div><button data-receipt-take="${esc(t.id)}">Take photo</button><button data-receipt-pick="${esc(t.id)}">Upload</button><button data-receipt-skip="${esc(t.id)}">Skip</button></div></div>`;
}

function eveningCheck(today) {
  const hour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (hour < 21 || store.get('kd-checked') === today) return '';
  return `<div class="check"><p>Anything missing from today?</p><div><button data-add>Add a purchase</button><button data-checked="${today}">All logged</button></div></div>`;
}

const moreBlock = (h) => `<section><h2>More</h2>
  <button class="list-row" data-default-budget><span>Default daily budget</span><span>${h.defaultBudget ? formatRM(h.defaultBudget) : 'Can spend per day'}</span></button>
  ${DEMO ? '' : '<button class="list-row" data-export><span>Download my spending</span><span>CSV</span></button>'}
  <p class="error" id="more-error" hidden></p>
  ${DEMO ? '' : `<button class="sign-out" data-signout>${icon('signout')}<span>Sign out</span></button>`}</section>`;

function openSignOut() {
  sheet.innerHTML = `<form method="dialog"><h2>Sign out?</h2>
    <p class="hint">You'll need your access key to sign back in. Your Shortcuts keep logging payments either way.</p>
    <div class="actions"><button type="button" class="quiet" data-close>Stay signed in</button><button class="primary">Sign out</button></div></form>`;
  const form = sheet.querySelector('form');
  form.querySelector('[data-close]').onclick = () => sheet.close();
  form.onsubmit = (e) => { e.preventDefault(); sheet.close(); signOut(); };
  sheet.showModal();
}

function renderHome() {
  const h = home;
  const isMonth = h.view === 'month';
  const noun = isMonth ? 'pay period' : 'week';
  setOver(Boolean(h.todayBudget) && h.todayTotal > h.todayBudget);
  app.innerHTML = `
    <header class="hero">
      <div class="hero-top">
        <div class="range">
          <button data-range="week" aria-pressed="${!isMonth}">Weekly</button>
          <button data-range="month" aria-pressed="${isMonth}">Monthly</button>
        </div>
        <div class="period">
          <button class="step" data-shift="-1" aria-label="Previous ${noun}">‹</button>
          <span>${shortDate(h.start)} to ${shortDate(h.end)}</span>
          <button class="step" data-shift="1" aria-label="Next ${noun}" ${addDays(h.end, 1) > h.today ? 'disabled' : ''}>›</button>
        </div>
      </div>
      ${heroBody(h)}
    </header>
    <div class="tiles">
      ${todayTile(h)}
      <div class="tile"><span>Daily average</span><b>${formatRM(h.average)}</b><small>${(isMonth && compareLine(h, 'last pay period')) || `${h.count} ${h.count === 1 ? 'purchase' : 'purchases'}`}</small></div>
    </div>
    ${receiptPrompt(h.receiptCandidate)}
    ${eveningCheck(h.today)}
    ${owedBlock(h)}
    ${calendar(h)}
    ${h.count ? topSpending(h) : ''}
    ${isMonth ? moneySetup(h) : ''}
    ${moreBlock(h)}
    ${dock()}`;
}

// The saved list loads in the background, so the page opens instantly with the last list seen.
let shortcutList = (() => { try { return JSON.parse(store.get('kd-shortcuts') || 'null') || DEFAULT_SHORTCUTS; } catch { return DEFAULT_SHORTCUTS; } })();
let editingShortcuts = false;

const shortcutIcon = (s) => (s.icon ? `<img class="app-mark" src="${esc(s.icon)}" alt="" width="52" height="52">`
  : s.logo ? `<img class="app-mark" src="/icons/app-${s.logo}.png" alt="" width="52" height="52">`
  : `<span class="app-mark letter" aria-hidden="true">${esc([...s.name][0]?.toUpperCase() || '?')}</span>`);

function renderLinks() {
  const list = shortcutList;
  app.innerHTML = `
    <div class="links-head"><h1 class="links-title">Shortcuts</h1>
      <button class="text-action" data-shortcuts-edit>${editingShortcuts ? 'Done' : 'Edit'}</button></div>
    <p class="links-intro">${editingShortcuts ? 'Tap a shortcut to change it, or use the arrows to reorder.' : 'Open an app to pay.'}</p>
    <div class="link-list">
      ${list.map((s, i) => (editingShortcuts
        ? `<div class="app-link editing">${shortcutIcon(s)}<button class="shortcut-name" data-shortcut-edit="${i}"><b>${esc(s.name)}</b><span>Edit</span></button>
            <span class="order"><button data-shortcut-move="${i}:-1" aria-label="Move ${esc(s.name)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button data-shortcut-move="${i}:1" aria-label="Move ${esc(s.name)} down" ${i === list.length - 1 ? 'disabled' : ''}>↓</button></span></div>`
        : `<a class="app-link" href="${esc(shortcutHref(s))}">${shortcutIcon(s)}<span><b>${esc(s.name)}</b><span>${shortcutCaption(s)}</span></span></a>`)).join('')}
      ${!list.length ? '<p class="empty">No shortcuts yet.</p>' : ''}
    </div>
    ${editingShortcuts && list.length < MAX_SHORTCUTS ? '<button class="add-shortcut" data-shortcut-add>+ Add shortcut</button>' : ''}
    ${editingShortcuts ? '<button class="text-action restore" data-shortcuts-reset>Restore the original three</button>' : ''}
    <p class="error" id="links-error" hidden></p>
    ${dock()}`;
}

async function loadShortcuts() {
  try {
    shortcutList = (await api.shortcuts()).shortcuts;
    store.set('kd-shortcuts', JSON.stringify(shortcutList));
    if (page === 'links') renderLinks();
  } catch { /* keeps the last list seen */ }
}

async function saveShortcutList(list) {
  const saved = (await api.saveShortcuts(list)).shortcuts;
  shortcutList = saved;
  store.set('kd-shortcuts', JSON.stringify(saved));
  if (page === 'links') renderLinks();
}

/** Turns a chosen picture into a small square icon. */
async function makeIcon(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 120;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 120, 120);
  bitmap.close?.();
  return canvas.toDataURL('image/png').length <= 80000 ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.8);
}

function openShortcutSheet(index) {
  const existing = index === null ? null : shortcutList[index];
  const draft = existing ? { ...existing } : { name: '', kind: 'link', target: '', icon: null, logo: null };
  const draw = (message = '') => {
    sheet.innerHTML = `<form method="dialog"><div class="sheet-head"><h2>${existing ? 'Edit shortcut' : 'Add shortcut'}</h2>
      <button type="button" class="sheet-close" data-close aria-label="Close">${icon('close')}</button></div>
      <div class="icon-pick">${shortcutIcon({ ...draft, name: draft.name || '?' })}
        <div><button type="button" class="text-action" data-icon-pick>${draft.icon || draft.logo ? 'Change icon' : 'Add icon'}</button>
        ${draft.icon || draft.logo ? '<button type="button" class="text-action quiet-link" data-icon-clear>Use a letter</button>' : ''}</div></div>
      <label>Name<input name="name" maxlength="40" required value="${esc(draft.name)}" placeholder="Boost"></label>
      <fieldset class="kind"><legend>Opens</legend>
        <label><input type="radio" name="kind" value="link" ${draft.kind === 'link' ? 'checked' : ''}> An app or website link</label>
        <label><input type="radio" name="kind" value="shortcut" ${draft.kind === 'shortcut' ? 'checked' : ''}> An iPhone Shortcut</label></fieldset>
      <label>${draft.kind === 'shortcut' ? 'Shortcut name' : 'Link'}<input name="target" required autocapitalize="off" autocorrect="off" spellcheck="false"
        value="${esc(draft.target)}" placeholder="${draft.kind === 'shortcut' ? 'Open Boost' : 'https://… or appname://'}"></label>
      <p class="hint">${draft.kind === 'shortcut'
        ? 'For apps without a link, make a Shortcut with the Open App action, then enter its exact name here.'
        : 'App links open the app directly, such as shopeepaymy:// for ShopeePay. Website links open in Safari.'}</p>
      <p class="error" ${message ? '' : 'hidden'}>${esc(message)}</p>
      <div class="actions">${existing ? '<button type="button" class="quiet" data-shortcut-delete>Remove</button>' : '<span></span>'}
        <button class="primary">${existing ? 'Save' : 'Add shortcut'}</button></div></form>`;
    const form = sheet.querySelector('form');
    const keep = () => { draft.name = form.elements.name.value; draft.target = form.elements.target.value; };
    form.querySelectorAll('[name="kind"]').forEach((r) => r.addEventListener('change', () => { keep(); draft.kind = r.value; draft.target = ''; draw(); }));
    form.querySelector('[data-close]').onclick = () => sheet.close();
    form.querySelector('[data-icon-pick]').onclick = () => { keep(); iconInput.onchange = async () => {
      const file = iconInput.files[0]; iconInput.value = '';
      if (!file) return;
      try { draft.icon = await makeIcon(file); draft.logo = null; draw(); } catch { draw("That picture couldn't be used."); }
    }; iconInput.click(); };
    form.querySelector('[data-icon-clear]')?.addEventListener('click', () => { keep(); draft.icon = null; draft.logo = null; draw(); });
    form.querySelector('[data-shortcut-delete]')?.addEventListener('click', async (e) => {
      const el = e.currentTarget;
      if (!el.classList.contains('confirm')) { el.classList.add('confirm'); el.textContent = 'Tap again to remove'; return; }
      try { await saveShortcutList(shortcutList.filter((_, i) => i !== index)); sheet.close(); } catch (err) { draw(err.message); }
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      keep();
      const { shortcut, error } = cleanShortcut(draft);
      if (error) return draw(error);
      const list = [...shortcutList];
      if (existing) list[index] = shortcut; else list.push(shortcut);
      try { await saveShortcutList(list); sheet.close(); } catch (err) { draw(err.message); }
    };
  };
  draw();
  sheet.showModal();
}

function render() {
  const s = summary;
  const today = localDate();
  const weekMax = Math.max(...s.week.map((d) => d.total), 1);
  const showTip = !DEMO && !window.navigator.standalone && !matchMedia('(display-mode: standalone)').matches && !store.get('kd-tip');

  app.innerHTML = `
    <header class="dayline">
      <button class="step" data-go="-1" aria-label="Previous day">‹</button>
      <h1>${date === today ? 'Today, ' : ''}${dayName(date, { weekday: date === today ? undefined : 'short', day: 'numeric', month: 'long' })}</h1>
      <button class="step" data-go="1" aria-label="Next day" ${date >= today ? 'disabled' : ''}>›</button>
    </header>
    ${bigTotal(s.total)}
    ${verdict(s)}
    ${date === today || s.budget ? budgetStrip(s.total, s.budget, date === today ? 'Today' : 'Budget', date, s.budgetSource) : ''}
    ${splitPrompt(s)}
    ${date === today ? receiptPrompt([...s.transactions].reverse().find((t) => t.source === 'shopeepay_qr' && !t.has_receipt)) + eveningCheck(today) : ''}
    ${ribbon(s)}
    ${showTip ? `<div class="tip"><span>Install this on your iPhone: in Safari, tap Share, then Add to Home Screen.</span><button data-tip>Dismiss</button></div>` : ''}
    ${s.count ? breakdown(s) : ''}
    <section><h2>This week <small>${formatRM(s.week.reduce((a, d) => a + d.total, 0))}</small></h2>
      <div class="week">${s.week.map((d) => `<button class="day ${d.date === date ? 'on' : ''}" data-day="${d.date}" ${d.date > today ? 'disabled' : ''} aria-label="${dayName(d.date, { weekday: 'long' })}, ${formatRM(d.total)}">
        <i style="height:${Math.round((d.total / weekMax) * 92)}px"></i><span>${dayName(d.date, { weekday: 'narrow' })}</span></button>`).join('')}</div>
      <p class="readout">${dayName(date, { month: 'long' })} so far: ${formatRM(s.monthTotal)}</p>
    </section>
    <section><h2>Purchases</h2>
      ${s.count ? purchaseList(s) : `<p class="empty">Double-tap the back of your iPhone on a ShopeePay receipt, or tap with Apple Pay. Purchases appear here.</p>`}
    </section>
    ${dock()}`;
  setOver(Boolean(s.budget) && s.total > s.budget);
}

function purchaseList(s) {
  const all = [...s.transactions].reverse();
  const pages = Math.ceil(all.length / BUYS_PER_PAGE);
  if (buyPageDate !== date) { buyPage = 0; buyPageDate = date; }
  if (buyPage === null) buyPage = Math.max(0, Math.floor(all.findIndex((t) => t.id === selected) / BUYS_PER_PAGE));
  buyPage = Math.min(Math.max(buyPage, 0), pages - 1);
  const first = buyPage * BUYS_PER_PAGE;
  const shown = all.slice(first, first + BUYS_PER_PAGE);
  const rows = shown.map((t) => `<button class="buy ${t.id === selected ? 'lit' : ''}" data-edit="${esc(t.id)}">
        <strong>${esc(t.merchant)}</strong><span>${formatRM(t.amount_sen)}</span>
        <small>${t.item ? `${esc(t.item)}, ` : ''}${time(t.occurred_at)}, ${esc(t.needs_review ? '' : t.category)}${t.needs_review ? '<em>Tap to check</em>' : ''}${t.bill_sen ? (t.owed_sen
          ? `<span class="split-mark owed" role="img" aria-label="Split, ${formatRM(t.owed_sen)} owed to you" title="Split, ${formatRM(t.owed_sen)} owed">${icon('split')}${formatRM(t.owed_sen)}</span>`
          : `<span class="split-mark" role="img" aria-label="Split, everyone has paid" title="Split, everyone has paid">${icon('settled')}</span>`) : ''}${t.has_receipt ? `<span class="receipt-mark" role="img" aria-label="Receipt attached" title="Receipt attached">${icon('receipt')}</span>` : ''}</small></button>`).join('');
  if (pages < 2) return rows;
  return `${rows}<nav class="pager" aria-label="Purchase pages">
    <button data-buy-page="-1" aria-label="Newer purchases" ${buyPage === 0 ? 'disabled' : ''}>‹</button>
    <span aria-live="polite">${first + 1}–${first + shown.length} of ${all.length}</span>
    <button data-buy-page="1" aria-label="Older purchases" ${buyPage === pages - 1 ? 'disabled' : ''}>›</button></nav>`;
}

let sheetPurchase = null;
let receiptTarget = null;
const receiptInput = document.getElementById('receipt-input');
const receiptLibrary = document.getElementById('receipt-library');
const iconInput = document.getElementById('icon-input');
const photoButtons = (id, cameraLabel) => `<button type="button" data-receipt-take="${esc(id)}">${icon('camera')}<span>${cameraLabel}</span></button>
  <button type="button" data-receipt-pick="${esc(id)}">${icon('photo')}<span>Upload</span></button>`;

async function showReceiptArea(t, message = '') {
  const area = document.getElementById('receipt-area');
  if (!area) return;
  const note = message ? `<p class="error">${esc(message)}</p>` : '';
  if (!t.has_receipt) {
    area.innerHTML = `<p class="photo-label">Receipt photo</p><div class="photo-actions">${photoButtons(t.id, 'Take photo')}</div>${note}`;
    return;
  }
  area.innerHTML = `<p class="hint">Loading receipt</p>${note}`;
  try {
    const src = await api.getReceipt(t.id);
    if (document.getElementById('receipt-area') !== area) return;
    area.innerHTML = `<img src="${src}" alt="Receipt photo"><div class="photo-actions">${photoButtons(t.id, 'Retake')}<button type="button" class="remove" data-receipt-remove="${esc(t.id)}">${icon('trash')}<span>Remove</span></button></div>${note}`;
  } catch (err) { area.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}

/** Shrinks a photo to a JPEG small enough to store, returned as base64. */
async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  for (const quality of [0.72, 0.55, 0.4]) {
    const base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if (base64.length < 1400000) return base64;
  }
  throw new Error('That photo is too large to save.');
}

// The input lives outside the page content so returning from the camera can't remove it.
async function savePhoto(input) {
  const file = input.files[0];
  const id = receiptTarget;
  input.value = '';
  if (!file || !id) return;
  if (id === SCAN) return scanPhoto(file);
  const inSheet = sheet.open && sheetPurchase?.id === id;
  try {
    await api.setReceipt(id, await compressPhoto(file));
    if (inSheet) { sheetPurchase.has_receipt = 1; showReceiptArea(sheetPurchase); } else refresh();
  } catch (err) {
    const message = err.message === 'unauthorized' ? '' : (err.message || 'The photo could not be saved.');
    if (inSheet) showReceiptArea(sheetPurchase, message);
    else if (message) {
      const card = app.querySelector('.receipt-card');
      if (card) card.insertAdjacentHTML('beforeend', `<p class="error">${esc(message)}</p>`);
    }
  }
}
receiptInput.addEventListener('change', () => savePhoto(receiptInput));
receiptLibrary.addEventListener('change', () => savePhoto(receiptLibrary));

const localParts = (iso) => {
  const d = new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
};

function openSheet(t) {
  const fromReceipt = t?.needs_review;
  const today = localDate();
  const defaultDate = page === 'day' ? date : today;
  const when = t ? localParts(t.occurred_at) : { date: defaultDate, time: defaultDate === today ? localParts(new Date().toISOString()).time : '12:00' };
  sheet.innerHTML = `<form method="dialog">
    <h2>${t ? 'Edit purchase' : 'Add purchase'}</h2>
    ${t ? '' : `<div class="quick"><label>Quick add<textarea id="quick-note" rows="2" maxlength="500" placeholder="Teh ais 1.50, roti canai 2 at Mamak XYZ"></textarea></label>
    <p class="error" id="quick-error" hidden></p>
    <div class="quick-actions"><button type="button" class="text-action" data-draft>Read this</button>
    <button type="button" class="text-action" data-scan-new>${icon('receipt')}Scan a receipt</button></div></div>`}
    ${fromReceipt ? '<p class="error">Check these details against your receipt.</p>' : ''}
    <label>${t?.bill_sen ? 'Your share (RM)' : 'Amount (RM)'}<input name="amount" inputmode="decimal" required value="${t ? (t.amount_sen / 100).toFixed(2) : ''}"></label>
    ${t?.bill_sen ? `<p class="hint">Bill total ${formatRM(t.bill_sen)}. Changing your share changes the total.</p>` : ''}
    <label>Where<input name="merchant" required maxlength="120" placeholder="Mamak XYZ" value="${t ? esc(t.merchant) : ''}"></label>
    <label>What <span class="optional">(optional)</span><input name="item" maxlength="120" placeholder="Teh Ais" value="${t?.item ? esc(t.item) : ''}"></label>
    <label>Category<select name="category">${CATEGORIES.map((c) => `<option ${(t?.category || 'Food') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <div class="two"><label>Date<input name="date" type="date" required max="${today}" value="${when.date}"></label>
    <label>Time<input name="time" type="time" required value="${when.time}"></label></div>
    ${t ? `<button type="button" class="split-row" data-split-open>${icon('split')}<span>${t.bill_sen ? 'Split with friends' : 'Split this bill'}</span>
      <span>${t.bill_sen ? (t.owed_sen ? `${formatRM(t.owed_sen)} owed` : 'Settled') : ''}</span></button>` : ''}
    ${t ? `<button type="button" class="split-row" data-pick-items>${icon('receipt')}<span>Pick my items from the receipt</span><span></span></button>` : ''}
    ${t ? '<div id="receipt-area"></div>' : ''}
    <p class="error" hidden></p>
    <div class="actions">${t ? '<button type="button" class="quiet" data-del>Delete</button>' : '<button type="button" class="quiet" data-close>Cancel</button>'}
    <button class="primary">${t ? 'Save changes' : 'Add purchase'}</button></div></form>`;
  if (t) { sheetPurchase = t; showReceiptArea(t); }
  const form = sheet.querySelector('form');
  const fail = (e) => { const p = form.querySelector('.error[hidden]'); if (p) { p.hidden = false; p.textContent = e.message; } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    try {
      await (t ? api.update(t.id, fields) : api.add(fields));
      sheet.close();
      if (page === 'day') { date = fields.date; selected = null; }
      refresh();
    } catch (err) { fail(err); }
  };
  form.querySelector('[data-close]')?.addEventListener('click', () => sheet.close());
  form.querySelector('[data-split-open]')?.addEventListener('click', () => openSplitSheet(t));
  form.querySelector('[data-scan-new]')?.addEventListener('click', () => openScanSource(null));
  form.querySelector('[data-pick-items]')?.addEventListener('click', () => (t.has_receipt ? scanReceipt({ transaction_id: t.id }, t, null) : openScanSource(t)));
  form.querySelector('[data-draft]')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const error = form.querySelector('#quick-error');
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Reading…';
    try {
      openDraftSheet(await api.draft(form.querySelector('#quick-note').value), form.elements.date.value);
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = 'Read this';
    }
  });
  form.querySelector('[data-del]')?.addEventListener('click', async () => {
    try { await api.remove(t.id); sheet.close(); refresh(); } catch (err) { fail(err); }
  });
  sheet.showModal();
}

// Friends' shares are edited here. Your share is whatever the friends don't owe.
async function openSplitSheet(t, { mine: fixed = null } = {}) {
  sheet.innerHTML = '<form method="dialog"><h2>Split bill</h2><p class="hint">Loading</p></form>';
  if (!sheet.open) sheet.showModal();
  let data;
  try { data = await api.split(t.id); } catch (err) {
    sheet.innerHTML = `<form method="dialog"><h2>Split bill</h2><p class="error">${esc(err.message)}</p>
      <div class="actions"><button type="button" class="quiet" data-close>Close</button></div></form>`;
    sheet.querySelector('[data-close]').onclick = () => sheet.close();
    return;
  }
  const bill = data.bill_sen;
  const friends = data.shares.map((s) => ({ friend: s.friend, amount_sen: s.amount_sen, paid: s.paid }));
  let equal = !friends.length || friends.every((f) => f.amount_sen === equalShares(bill, friends.length).each);
  // A share worked out from receipt items stays fixed, and friends split what's left.
  let fixedMine = fixed !== null && fixed > 0 && fixed < bill ? fixed : null;
  const mine = () => bill - friends.reduce((a, f) => a + f.amount_sen, 0);
  const spread = () => {
    if (fixedMine !== null && friends.length) {
      const rest = bill - fixedMine;
      const each = Math.floor(rest / friends.length);
      friends.forEach((f, i) => { f.amount_sen = each + (i === 0 ? rest - each * friends.length : 0); });
    } else if (equal) { const { each } = equalShares(bill, friends.length); friends.forEach((f) => { f.amount_sen = each; }); }
  };
  if (fixedMine !== null) { equal = false; spread(); }
  const has = (name) => friends.some((f) => f.friend.toLowerCase() === name.toLowerCase());

  const draw = (message = '') => {
    const picks = data.recent.filter((n) => !has(n)).slice(0, 8);
    sheet.innerHTML = `<form method="dialog" class="split-sheet"><h2>Split ${formatRM(bill)}</h2>
      <p class="hint">${esc(t.merchant)}${t.item ? `, ${esc(t.item)}` : ''}</p>
      ${fixedMine !== null ? `<p class="hint">Your items come to ${formatRM(fixedMine)}, so friends split the other ${formatRM(bill - fixedMine)}.</p>` : ''}
      <div class="add-friend"><input id="friend-name" maxlength="60" autocomplete="off" placeholder="Friend's name" aria-label="Friend's name">
        <button type="button" data-friend-add>Add</button></div>
      ${picks.length ? `<div class="chips">${picks.map((n) => `<button type="button" class="chip" data-friend-pick="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <div class="shares">${friends.map((f, i) => `<div class="share"><span>${esc(f.friend)}${f.paid ? '<em>Paid</em>' : ''}</span>
        <input data-share="${i}" inputmode="decimal" value="${(f.amount_sen / 100).toFixed(2)}" aria-label="${esc(f.friend)} owes, in RM">
        <button type="button" class="share-remove" data-share-remove="${i}" aria-label="Remove ${esc(f.friend)}">×</button></div>`).join('')}</div>
      ${friends.length ? `<p class="split-mine">Your share <b>${formatRM(mine())}</b></p>
        <button type="button" class="text-action" data-equal ${equal ? 'hidden' : ''}>Split equally</button>` : '<p class="hint">Add each friend who owes you. The bill is split equally, and you can change any amount.</p>'}
      <p class="error" ${message ? '' : 'hidden'}>${esc(message)}</p>
      <div class="actions">${data.shares.length ? '<button type="button" class="quiet" data-unsplit>Remove split</button>' : '<button type="button" class="quiet" data-close>Cancel</button>'}
        <button class="primary" ${friends.length ? '' : 'disabled'}>Save split</button></div></form>`;
    const form = sheet.querySelector('form');
    const nameInput = form.querySelector('#friend-name');
    const add = (name) => {
      const clean = name.trim().replace(/\s+/g, ' ');
      if (!clean) return;
      if (has(clean)) return draw(`${clean} is already in this split.`);
      friends.push({ friend: clean, amount_sen: 0, paid: false });
      spread();
      draw();
      sheet.querySelector('#friend-name').focus();
    };
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(nameInput.value); } });
    form.addEventListener('input', (e) => {
      if (e.target.dataset.share === undefined) return;
      friends[Number(e.target.dataset.share)].amount_sen = Math.round(parseFloat(e.target.value || '0') * 100) || 0;
      equal = false;
      fixedMine = null;
      const b = form.querySelector('.split-mine b');
      b.textContent = formatRM(mine());
      b.classList.toggle('bad', mine() <= 0);
      form.querySelector('[data-equal]').hidden = false;
    });
    form.addEventListener('click', async (e) => {
      const el = e.target.closest('button');
      if (!el) return;
      const d = el.dataset;
      if (d.friendAdd !== undefined) add(nameInput.value);
      else if (d.friendPick) add(d.friendPick);
      else if (d.shareRemove) { friends.splice(Number(d.shareRemove), 1); spread(); draw(); }
      else if (d.equal !== undefined) { equal = true; fixedMine = null; spread(); draw(); }
      else if (d.close !== undefined) sheet.close();
      else if (d.unsplit !== undefined) {
        // A second tap confirms, since paid-back records for this bill are cleared.
        if (!el.classList.contains('confirm')) { el.classList.add('confirm'); el.textContent = 'Tap again to remove'; return; }
        try { await api.unsplit(t.id); sheet.close(); } catch (err) { draw(err.message); }
      }
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const { error } = cleanShares(bill, friends.map((f) => ({ friend: f.friend, amount_sen: f.amount_sen })));
      if (error) return draw(error);
      try {
        await api.saveSplit(t.id, friends.map((f) => ({ friend: f.friend, amount_sen: f.amount_sen })));
        sheet.close();
      } catch (err) { draw(err.message); }
    };
  };
  draw();
}

async function openFriendSheet(name) {
  let friend;
  const draw = (message = '') => {
    if (!friend?.shares.length) { sheet.close(); return; }
    sheet.innerHTML = `<form method="dialog"><div class="sheet-head"><h2>${esc(friend.name)} owes ${formatRM(friend.owed_sen)}</h2>
      <button type="button" class="sheet-close" data-close aria-label="Close">${icon('close')}</button></div>
      <div class="owed-list">${friend.shares.map((s) => `<div class="owed-row"><span><b>${formatRM(s.amount_sen)}</b>
        <small>${s.item ? `${esc(s.item)} at ` : ''}${esc(s.merchant)}, ${shortDate(s.local_date)}</small></span>
        <button type="button" data-paid="${esc(s.id)}">Paid</button></div>`).join('')}</div>
      <p class="error" ${message ? '' : 'hidden'}>${esc(message)}</p>
      ${friend.shares.length > 1 ? '<div class="actions end"><button class="primary">Mark all paid</button></div>' : ''}</form>`;
    const form = sheet.querySelector('form');
    const settle = async (ids) => {
      try {
        for (const id of ids) {
          await api.setPaid(id, true);
          const s = friend.shares.find((x) => x.id === id);
          friend.owed_sen -= s.amount_sen;
          friend.shares = friend.shares.filter((x) => x.id !== id);
        }
        draw();
      } catch (err) { draw(err.message); }
    };
    form.querySelector('[data-close]').onclick = () => sheet.close();
    form.addEventListener('click', (e) => { const id = e.target.closest('[data-paid]')?.dataset.paid; if (id) settle([id]); });
    form.onsubmit = (e) => { e.preventDefault(); settle(friend.shares.map((s) => s.id)); };
  };
  try {
    const { friends } = await api.owed();
    friend = friends.find((f) => f.name.toLowerCase() === name.toLowerCase());
  } catch { friend = null; }
  if (!friend) return refresh();
  draw();
  sheet.showModal();
}

// Receipt scanning: a photo is read into items, you pick yours, and tax and charges are shared in proportion.
const SCAN = Symbol('scan');
let scanPurchase = null;

function openScanSource(purchase) {
  scanPurchase = purchase;
  sheet.innerHTML = `<form method="dialog"><div class="sheet-head"><h2>Scan a receipt</h2>
    <button type="button" class="sheet-close" data-close aria-label="Close">${icon('close')}</button></div>
    <p class="hint">Use the itemised receipt, flat and in good light, with every line and the total in view.</p>
    <div class="photo-actions"><button type="button" data-scan-camera>${icon('camera')}<span>Take photo</span></button>
      <button type="button" data-scan-library>${icon('photo')}<span>Upload</span></button></div></form>`;
  sheet.querySelector('[data-close]').onclick = () => sheet.close();
  sheet.querySelector('[data-scan-camera]').onclick = () => { receiptTarget = SCAN; receiptInput.click(); };
  sheet.querySelector('[data-scan-library]').onclick = () => { receiptTarget = SCAN; receiptLibrary.click(); };
  if (!sheet.open) sheet.showModal();
}

async function scanPhoto(file) {
  let photo;
  try { photo = await compressPhoto(file); } catch (err) { return scanFailed(err.message); }
  // A photo taken for a logged purchase is kept as its receipt.
  if (scanPurchase) api.setReceipt(scanPurchase.id, photo).then(() => { scanPurchase.has_receipt = 1; }).catch(() => {});
  scanReceipt({ image: photo }, scanPurchase, photo);
}

function scanFailed(message) {
  sheet.innerHTML = `<form method="dialog"><div class="sheet-head"><h2>Scan a receipt</h2>
    <button type="button" class="sheet-close" data-close aria-label="Close">${icon('close')}</button></div>
    <p class="error">${esc(message)}</p>
    <div class="actions end"><button type="button" class="primary" data-retry>Try another photo</button></div></form>`;
  sheet.querySelector('[data-close]').onclick = () => sheet.close();
  sheet.querySelector('[data-retry]').onclick = () => openScanSource(scanPurchase);
  if (!sheet.open) sheet.showModal();
}

async function scanReceipt(body, purchase, photo) {
  scanPurchase = purchase;
  sheet.innerHTML = `<form method="dialog"><h2>Reading the receipt</h2>
    <p class="hint">Finding each item and the total. This can take up to half a minute.</p><div class="scan-wait" aria-hidden="true"></div></form>`;
  if (!sheet.open) sheet.showModal();
  try {
    openItemsSheet(await api.receiptItems(body), purchase, photo);
  } catch (err) {
    if (err.message !== 'unauthorized') scanFailed(err.message || "The receipt couldn't be read.");
  }
}

function openItemsSheet(receipt, purchase, photo) {
  const picks = {};
  const bill = purchase ? (purchase.bill_sen ?? purchase.amount_sen) : receipt.total_sen;
  const unit = (it) => formatRM(Math.round(it.amount_sen / it.qty));
  sheet.innerHTML = `<form method="dialog" class="items-sheet"><div class="sheet-head"><h2>Which items are yours?</h2>
      <button type="button" class="sheet-close" data-close aria-label="Close">${icon('close')}</button></div>
    <p class="hint">${receipt.merchant ? `${esc(receipt.merchant)}, ` : ''}receipt total ${formatRM(receipt.total_sen)}</p>
    ${receipt.mismatch_sen ? `<p class="flag-note">The lines add up to ${formatRM(receipt.items_sen + receipt.charges_sen)}, not ${formatRM(receipt.total_sen)}, so a line may have been misread or missed. Check against the receipt before saving.</p>` : ''}
    <div class="item-list">${receipt.items.map((it) => (it.qty > 1
      ? `<div class="item-row"><span><b>${esc(it.name)}</b><small>${it.qty} × ${unit(it)}</small></span>
          <span class="stepper"><button type="button" data-units="${it.id}:-1" aria-label="One less ${esc(it.name)}">−</button>
          <output id="u-${it.id}">0</output><button type="button" data-units="${it.id}:1" aria-label="One more ${esc(it.name)}">+</button></span></div>`
      : `<label class="item-row"><span><b>${esc(it.name)}</b><small>${formatRM(it.amount_sen)}</small></span>
          <input type="checkbox" data-pick="${it.id}" aria-label="${esc(it.name)} is mine"></label>`)).join('')}</div>
    ${receipt.charges.length ? `<p class="hint charges">${receipt.charges.map((c) => `${esc(c.name)} ${formatRM(c.amount_sen)}`).join(' · ')}</p>` : ''}
    <div class="share-box"><div><span>Your items</span><b id="sh-items">RM0.00</b></div>
      <div><span>Your part of tax and charges</span><b id="sh-extra">RM0.00</b></div>
      <div class="total"><span>Your share</span><b id="sh-total">RM0.00</b></div></div>
    ${purchase && bill !== receipt.total_sen ? `<p class="hint">Worked out from the ${formatRM(bill)} you paid, not the receipt total.</p>` : ''}
    ${purchase ? '' : `<label>Where<input name="merchant" required maxlength="120" value="${esc(receipt.merchant || '')}" placeholder="Restoran XYZ"></label>
      <label>Category<select name="category">${CATEGORIES.map((c) => `<option ${c === 'Food' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>`}
    <p class="error" hidden></p>
    <div class="actions">${purchase ? '<button type="button" class="quiet" data-set-mine>Set as my amount</button><button type="button" class="primary" data-split-rest>Split the rest</button>'
      : '<span></span><button class="primary" data-log-share>Log my share</button>'}</div></form>`;
  const form = sheet.querySelector('form');
  const error = (m) => { const p = form.querySelector('.error'); p.hidden = !m; p.textContent = m || ''; };
  const current = () => shareOf(receipt, picks, bill);
  const update = () => {
    const r = current();
    form.querySelector('#sh-items').textContent = formatRM(r.items_sen);
    form.querySelector('#sh-extra').textContent = formatRM(r.extra_sen);
    form.querySelector('#sh-total').textContent = formatRM(r.share_sen);
    const none = r.share_sen <= 0;
    form.querySelectorAll('.actions button').forEach((b) => { b.disabled = none; });
    const log = form.querySelector('[data-log-share]');
    if (log) log.textContent = none ? 'Log my share' : `Log ${formatRM(r.share_sen)}`;
    const rest = form.querySelector('[data-split-rest]');
    if (rest) rest.disabled = none || r.share_sen >= bill;
  };
  form.addEventListener('change', (e) => { if (e.target.dataset.pick) { picks[e.target.dataset.pick] = e.target.checked ? 1 : 0; update(); } });
  form.addEventListener('click', async (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    if (el.dataset.close !== undefined) return sheet.close();
    if (el.dataset.units) {
      const [id, step] = el.dataset.units.split(':');
      const it = receipt.items.find((x) => x.id === id);
      picks[id] = Math.min(Math.max((picks[id] || 0) + Number(step), 0), it.qty);
      form.querySelector(`#u-${id}`).textContent = picks[id];
      update();
      return;
    }
    if (!purchase) return;
    const r = current();
    const names = pickedNames(receipt, picks);
    try {
      if (el.dataset.setMine !== undefined) {
        await api.update(purchase.id, { amount: (r.share_sen / 100).toFixed(2), ...(purchase.item ? {} : { item: names }) });
        sheet.close();
      } else if (el.dataset.splitRest !== undefined) {
        if (!purchase.item && names) { await api.update(purchase.id, { item: names }); purchase.item = names; }
        openSplitSheet(purchase, { mine: r.share_sen });
      }
    } catch (err) { error(err.message); }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const r = current();
    if (r.share_sen <= 0) return error('Pick at least one item.');
    const now = new Date();
    try {
      const row = await api.add({ amount: (r.share_sen / 100).toFixed(2), merchant: form.elements.merchant.value.trim(), item: pickedNames(receipt, picks),
        category: form.elements.category.value, date: localDate(now), time: localParts(now.toISOString()).time });
      if (photo && row?.id) await api.setReceipt(row.id, photo).catch(() => {});
      sheet.close();
      if (page === 'day') { date = localDate(now); selected = null; }
      refresh();
    } catch (err) { error(err.message); }
  };
  update();
  if (!sheet.open) sheet.showModal();
}

// Nothing from Quick add is saved until it's confirmed here.
function openDraftSheet({ items, skipped }, draftDate) {
  const today = localDate();
  const label = (n) => `Add ${n} purchase${n === 1 ? '' : 's'}`;
  sheet.innerHTML = `<form method="dialog"><h2>Check these</h2>
    ${skipped ? `<p class="hint">${skipped} item${skipped === 1 ? '' : 's'} had no clear price and ${skipped === 1 ? 'was' : 'were'} left out.</p>` : ''}
    <div class="drafts">${items.map((d) => `<fieldset class="draft">
      <div class="two"><label>What<input name="item" maxlength="120" value="${esc(d.item || '')}"></label>
      <label>Amount (RM)<input name="amount" inputmode="decimal" required value="${(d.amount_sen / 100).toFixed(2)}"></label></div>
      <label>Where<input name="merchant" required maxlength="120" placeholder="Where you bought it" value="${esc(d.merchant || '')}"></label>
      <label>Category<select name="category">${CATEGORIES.map((c) => `<option ${d.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <button type="button" class="text-action" data-draft-remove>Remove</button></fieldset>`).join('')}</div>
    <label>Date<input name="date" type="date" required max="${today}" value="${draftDate}"></label>
    <p class="error" hidden></p>
    <div class="actions"><button type="button" class="quiet" data-close>Cancel</button><button class="primary">${label(items.length)}</button></div></form>`;
  const form = sheet.querySelector('form');
  const rows = () => [...form.querySelectorAll('.draft')];
  const primary = form.querySelector('.primary');
  form.querySelector('[data-close]').onclick = () => sheet.close();
  // Typing a place fills the other empty Where fields, since a note is usually from one shop.
  form.querySelector('.drafts').addEventListener('change', (e) => {
    if (e.target.name !== 'merchant' || !e.target.value.trim()) return;
    form.querySelectorAll('.draft [name="merchant"]').forEach((input) => { if (!input.value.trim()) input.value = e.target.value; });
  });
  form.querySelector('.drafts').addEventListener('click', (e) => {
    if (!e.target.matches('[data-draft-remove]')) return;
    e.target.closest('.draft').remove();
    if (!rows().length) return sheet.close();
    primary.textContent = label(rows().length);
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const when = form.elements.date.value;
    const time = when === today ? localParts(new Date().toISOString()).time : '12:00';
    primary.disabled = true;
    try {
      // Saved rows leave the list, so retrying after an error can't add them twice.
      for (const row of rows()) {
        const value = (name) => row.querySelector(`[name="${name}"]`).value;
        await api.add({ amount: value('amount'), merchant: value('merchant'), item: value('item'), category: value('category'), date: when, time });
        row.remove();
      }
      sheet.close();
      if (page === 'day') { date = when; selected = null; }
      refresh();
    } catch (err) {
      const p = form.querySelector('.error'); p.hidden = false; p.textContent = err.message;
      primary.disabled = false;
      primary.textContent = label(rows().length);
    }
  };
  if (!sheet.open) sheet.showModal();
}

function openAmountSheet({ title, label, value, action, save, hint, optional }) {
  sheet.innerHTML = `<form method="dialog"><h2>${title}</h2>
    <label>${label}<input name="amount" inputmode="decimal" ${optional ? '' : 'required'} value="${value ? (value / 100).toFixed(2) : ''}"></label>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    <p class="error" hidden></p>
    <div class="actions"><button type="button" class="quiet" data-close>Cancel</button><button class="primary">${action}</button></div></form>`;
  const form = sheet.querySelector('form');
  form.querySelector('[data-close]').onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await save(new FormData(form).get('amount')); sheet.close(); refresh(); } catch (err) {
      const p = form.querySelector('.error'); p.hidden = false; p.textContent = err.message;
    }
  };
  sheet.showModal();
}

function openCommitmentAdd() {
  sheet.innerHTML = `<form method="dialog"><h2>Add a commitment</h2>
    <label>Name<input name="name" required placeholder="Rent"></label>
    <label>Amount each month (RM)<input name="amount" inputmode="decimal" required></label>
    <p class="hint">Counts from this pay period onwards.</p>
    <p class="error" hidden></p>
    <div class="actions"><button type="button" class="quiet" data-close>Cancel</button><button class="primary">Add commitment</button></div></form>`;
  const form = sheet.querySelector('form');
  form.querySelector('[data-close]').onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api.addCommitment(Object.fromEntries(new FormData(form))); sheet.close(); refresh(); } catch (err) {
      const p = form.querySelector('.error'); p.hidden = false; p.textContent = err.message;
    }
  };
  sheet.showModal();
}

function openCommitmentRemove(c) {
  sheet.innerHTML = `<form method="dialog"><h2>Remove ${esc(c.name)}?</h2>
    <p class="hint">${formatRM(c.amount_sen)} stops counting from this pay period. Earlier periods stay the same.</p>
    <p class="error" hidden></p>
    <div class="actions"><button type="button" class="quiet" data-close>Keep</button><button class="primary">Remove commitment</button></div></form>`;
  const form = sheet.querySelector('form');
  form.querySelector('[data-close]').onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api.removeCommitment(c.id); sheet.close(); refresh(); } catch (err) {
      const p = form.querySelector('.error'); p.hidden = false; p.textContent = err.message;
    }
  };
  sheet.showModal();
}

async function downloadCsv() {
  const fail = () => { const p = document.getElementById('more-error'); if (p) { p.hidden = false; p.textContent = 'Your spending could not be downloaded. Check your connection and try again.'; } };
  try {
    const res = await fetch('/api/export');
    if (!res.ok) return fail();
    const file = new File([await res.blob()], `kiraduit-${localDate()}.csv`, { type: 'text/csv' });
    // The share sheet is the dependable way to save a file from a Home Screen app on iPhone.
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] }).catch((e) => { if (e.name !== 'AbortError') throw e; });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch { fail(); }
}

async function refresh() {
  try {
    if (page === 'links') { renderLinks(); loadShortcuts(); }
    else if (page === 'home') { home = await api.loadHome(range, homeDate); signedIn = true; renderHome(); } else { summary = await api.load(date); signedIn = true; render(); }
  } catch (e) {
    if (e.message !== 'unauthorized') app.innerHTML = `<div class="gate"><h1>KiraDuit</h1><p>Your spending could not be loaded. Check your connection, then try again.</p><button class="primary" data-retry>Try again</button></div>`;
  }
}

// Purchases close together share a tap area, so repeated taps step through them.
function nextTick(el, keyboard) {
  if (keyboard) return selected === el.dataset.tick ? null : el.dataset.tick;
  const x = el.getBoundingClientRect().left;
  const group = [...app.querySelectorAll('.tick')].filter((t) => Math.abs(t.getBoundingClientRect().left - x) <= 14).map((t) => t.dataset.tick);
  const at = group.indexOf(selected);
  return at === -1 ? group[0] : group[at + 1] ?? null;
}

app.addEventListener('toggle', (e) => { if (e.target.matches?.('[data-money]')) moneyOpen = e.target.open; }, true);

app.addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el) return;
  const d = el.dataset;
  if (d.retry !== undefined) refresh();
  else if (d.go) { date = addDays(date, Number(d.go)); selected = null; refresh(); }
  else if (d.day) { date = d.day; selected = null; page = 'day'; refresh(); }
  else if (d.page) { if (d.page === 'day' && page === 'home') date = localDate(); page = d.page; homeDate = page === 'home' ? localDate() : homeDate; refresh(); }
  else if (d.range) { range = d.range; store.set('kd-range', range); homeDate = localDate(); refresh(); }
  else if (d.shift) { homeDate = Number(d.shift) < 0 ? addDays(home.start, -1) : addDays(home.end, 1); refresh(); }
  else if (d.budget) openAmountSheet({ title: d.budget === localDate() ? "Today's budget" : `Budget for ${shortDate(d.budget)}`, label: 'Budget (RM)', action: 'Save budget', value: (page === 'home' ? home.todayBudgetSource : summary.budgetSource) === 'set' ? (page === 'home' ? home.todayBudget : summary.budget) : null, save: (v) => api.setBudget(d.budget, v) });
  else if (d.income !== undefined) openAmountSheet({ title: 'Monthly income', label: 'Income received on the 27th (RM)', action: 'Save income', value: home.income, save: (v) => api.setIncome(v) });
  else if (d.tick) { selected = nextTick(el, e.detail === 0); buyPage = null; render(); }
  else if (d.buyPage) { buyPage += Number(d.buyPage); render(); }
  else if (d.split) openSplitSheet(summary.transactions.find((t) => t.id === d.split));
  else if (d.splitSkip) { store.set('kd-no-split', JSON.stringify([d.splitSkip, ...dismissedSplits()].slice(0, 50))); render(); }
  else if (d.friend) openFriendSheet(d.friend);
  else if (d.shortcutsEdit !== undefined) { editingShortcuts = !editingShortcuts; renderLinks(); }
  else if (d.shortcutAdd !== undefined) openShortcutSheet(null);
  else if (d.shortcutEdit) openShortcutSheet(Number(d.shortcutEdit));
  else if (d.shortcutMove) {
    const [i, step] = d.shortcutMove.split(':').map(Number);
    const list = [...shortcutList];
    [list[i], list[i + step]] = [list[i + step], list[i]];
    saveShortcutList(list).catch((err) => { const p = document.getElementById('links-error'); p.hidden = false; p.textContent = err.message; });
  }
  else if (d.shortcutsReset !== undefined) saveShortcutList(DEFAULT_SHORTCUTS).catch(() => {});
  else if (d.edit) openSheet(summary.transactions.find((t) => t.id === d.edit));
  else if (d.add !== undefined) openSheet(null);
  else if (d.receiptTake) { receiptTarget = d.receiptTake; receiptInput.click(); }
  else if (d.receiptPick) { receiptTarget = d.receiptPick; receiptLibrary.click(); }
  else if (d.receiptSkip) { store.set('kd-no-receipt', d.receiptSkip); refresh(); }
  else if (d.checked) { store.set('kd-checked', d.checked); refresh(); }
  else if (d.defaultBudget !== undefined) openAmountSheet({ title: 'Default daily budget', label: 'Budget when you skip setting one (RM)', action: 'Save default', value: home.defaultBudget, optional: true, hint: 'Leave empty to use your can-spend-per-day amount.', save: (v) => api.setDefaultBudget(v) });
  else if (d.addCommitment !== undefined) openCommitmentAdd();
  else if (d.commitment) openCommitmentRemove(home.commitmentList.find((c) => c.id === d.commitment));
  else if (d.export !== undefined) downloadCsv();
  else if (d.signout !== undefined) openSignOut();
  else if (d.tip !== undefined) { store.set('kd-tip', '1'); render(); }
});
sheet.addEventListener('click', async (e) => {
  if (e.target === sheet) return sheet.close();
  const el = e.target.closest('button');
  if (!el) return;
  if (el.dataset.receiptTake) { receiptTarget = el.dataset.receiptTake; receiptInput.click(); }
  if (el.dataset.receiptPick) { receiptTarget = el.dataset.receiptPick; receiptLibrary.click(); }
  else if (el.dataset.receiptRemove) {
    // Removing needs a second tap within a few seconds, since it can't be undone.
    if (!el.classList.contains('confirm')) {
      el.classList.add('confirm');
      el.querySelector('span').textContent = 'Tap to confirm';
      setTimeout(() => { if (el.isConnected) { el.classList.remove('confirm'); el.querySelector('span').textContent = 'Remove'; } }, 4000);
      return;
    }
    try { await api.removeReceipt(el.dataset.receiptRemove); sheetPurchase.has_receipt = 0; showReceiptArea(sheetPurchase); } catch (err) { showReceiptArea(sheetPurchase, err.message); }
  }
});
sheet.addEventListener('close', () => { if (page !== 'links') refresh(); });
// Picks up new purchases when you return from ShopeePay.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || sheet.open) return;
  if (await newVersionLive()) location.reload();
  else refresh();
});

// The Home Screen app can stay in memory for days, so check for a new deploy when it's reopened.
let loadedVersion = null;
async function liveVersion() {
  try {
    const res = await fetch('/app.js', { method: 'HEAD', cache: 'no-store' });
    return res.ok ? res.headers.get('etag') : null;
  } catch { return null; }
}
async function newVersionLive() {
  if (DEMO) return false;
  const live = await liveVersion();
  return Boolean(loadedVersion && live && live !== loadedVersion);
}

if (!DEMO) {
  liveVersion().then((v) => { loadedVersion = v; });
  if ('serviceWorker' in navigator) {
    // A replaced service worker means an older app may be on screen. First installs have no controller and don't reload.
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !sheet.open) location.reload(); });
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// Earlier versions kept the access key in this browser. Trade it for a session once, then delete it.
async function start() {
  const legacy = DEMO ? null : store.get('kd-key');
  if (legacy) {
    await fetch('/api/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ key: legacy }) }).catch(() => {});
    store.del('kd-key');
  }
  refresh();
}
start();
