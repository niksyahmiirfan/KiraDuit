import { CATEGORIES, SOURCE_LABELS, addDays, budgetLine, formatRM, localDate, allowanceFor, payPeriod, periodFor, previousRange, summarize, summarizePeriod, windowStart } from './summary.js';

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

async function request(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { authorization: `Bearer ${store.get('kd-key')}`, 'content-type': 'application/json' } });
  if (res.status === 401) { store.del('kd-key'); renderGate('That access key was not accepted.'); throw new Error('unauthorized'); }
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* plain text reply */ }
  if (!res.ok) throw new Error(parsed?.error || (res.status === 422 ? body : 'Could not save. Check your connection and try again.'));
  return parsed ?? body;
}
const api = DEMO ? {
  load: async (d) => summarize(demoTxs.filter((t) => t.local_date >= windowStart(d)).map((t) => ({ ...t, has_receipt: demoReceipts.has(t.id) ? 1 : 0 })), d, demoBudget(d).amount, demoBudget(d).source),
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
    };
  },
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
    Object.assign(t, { merchant: f.merchant, category: f.category, amount_sen: Math.round(parseFloat(f.amount) * 100), needs_review: 0, local_date: f.date, occurred_at: new Date(`${f.date}T${f.time}:00+08:00`).toISOString() });
  },
  remove: async (id) => demoTxs.splice(demoTxs.findIndex((x) => x.id === id), 1),
  add: async (f) => demoTxs.push({ id: `m${Date.now()}`, merchant: f.merchant, category: f.category, amount_sen: Math.round(parseFloat(f.amount) * 100), source: 'manual', occurred_at: new Date(`${f.date}T${f.time}:00+08:00`).toISOString(), local_date: f.date, needs_review: 0 }),
} : {
  load: (d) => request(`/api/summary?date=${d}`),
  loadHome: (view, d) => request(`/api/home?view=${view}&date=${d}`),
  setBudget: (d, amount) => request(`/api/budget?date=${d}`, { method: 'POST', body: JSON.stringify({ amount }) }),
  setIncome: (amount) => request('/api/income', { method: 'POST', body: JSON.stringify({ amount }) }),
  getReceipt: async (id) => {
    const res = await fetch(`/api/transactions/${id}/receipt`, { headers: { authorization: `Bearer ${store.get('kd-key')}` } });
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
};

/* ---- views ---- */
function renderGate(message = '') {
  app.innerHTML = `<form class="gate"><h1>KiraDuit</h1><p>Enter your access key to see your spending.</p>
    <label>Access key<input name="key" type="password" autocomplete="current-password" required></label>
    ${message ? `<p class="error">${esc(message)}</p>` : ''}<button class="primary">Unlock</button></form>`;
  app.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    store.set('kd-key', new FormData(e.target).get('key').trim());
    refresh();
  };
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

const ribbon = (s) => {
  if (!s.count) return '';
  const max = s.largest.amount_sen;
  const ticks = s.transactions.map((t) => {
    const h = Math.max(10, Math.round((t.amount_sen / max) * 68));
    return `<button class="tick" data-tick="${esc(t.id)}" aria-pressed="${t.id === selected}" style="left:${(minutesInto(t.occurred_at) / 1440) * 100}%"
      aria-label="${esc(`${formatRM(t.amount_sen)} at ${t.merchant}, ${time(t.occurred_at)}`)}"><i style="height:${h}px"></i></button>`;
  }).join('');
  const pick = s.transactions.find((t) => t.id === selected);
  const line = pick ? `${formatRM(pick.amount_sen)} at ${pick.merchant}, ${time(pick.occurred_at)}`
    : `Largest was ${formatRM(max)} at ${s.largest.merchant}, ${time(s.largest.occurred_at)}`;
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
    ${s.bySource.map((p) => `<div><span>${SOURCE_LABELS[p.name]}</span><b>${formatRM(p.total)}</b></div>`).join('')}
  </div></section>`;
};

const ICONS = {
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-6h4v6"/>',
  day: '<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/><path d="M8 14h3v3H8z"/>',
  links: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><path d="M16.75 13.5v6.5M13.5 16.75H20"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
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
    ${h.bySource.map((p) => `<div class="rank"><span>${SOURCE_LABELS[p.name]}</span><span>${formatRM(p.total)}</span></div>`).join('')}
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

const RECEIPT_PROMPT_MS = 30 * 60 * 1000;

function receiptPrompt(t) {
  if (!t || Date.now() - new Date(t.occurred_at).getTime() > RECEIPT_PROMPT_MS || store.get('kd-no-receipt') === t.id) return '';
  return `<div class="receipt-card"><p>Add a receipt for ${formatRM(t.amount_sen)} at ${esc(t.merchant)}?</p>
    <div><button data-receipt-take="${esc(t.id)}">Take photo</button><button data-receipt-skip="${esc(t.id)}">Skip</button></div></div>`;
}

function eveningCheck(today) {
  const hour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (hour < 21 || store.get('kd-checked') === today) return '';
  return `<div class="check"><p>Anything missing from today?</p><div><button data-add>Add a purchase</button><button data-checked="${today}">All logged</button></div></div>`;
}

const moreBlock = (h) => `<section><h2>More</h2>
  <button class="list-row" data-default-budget><span>Default daily budget</span><span>${h.defaultBudget ? formatRM(h.defaultBudget) : 'Can spend per day'}</span></button>
  ${DEMO ? '' : '<button class="list-row" data-export><span>Download my spending</span><span>CSV</span></button>'}
  <p class="error" id="more-error" hidden></p></section>`;

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
    ${calendar(h)}
    ${h.count ? topSpending(h) : ''}
    ${isMonth ? moneySetup(h) : ''}
    ${moreBlock(h)}
    ${dock()}`;
}

const APPS = [
  { mark: 'TNG', name: "Touch 'n Go eWallet", href: 'shortcuts://run-shortcut?name=Open%20TNG' },
  { mark: 'SP', name: 'ShopeePay', href: 'shopeepaymy://' },
  { mark: 'MAE', name: 'MAE by Maybank2u', href: 'shortcuts://run-shortcut?name=Open%20MAE' },
];

function renderLinks() {
  app.innerHTML = `
    <h1 class="links-title">Shortcuts</h1>
    <p class="links-intro">Open an app to pay.</p>
    <div class="link-list">
      ${APPS.map((a) => `<a class="app-link" href="${a.href}"><span class="app-mark" aria-hidden="true">${a.mark}</span><span><b>${esc(a.name)}</b><span>Open app</span></span></a>`).join('')}
    </div>
    <section><details><summary>Set up TNG and MAE</summary>
      <p class="hint">These two apps need a small iPhone Shortcut to open from here. You only do this once.</p>
      <ol class="steps"><li>In the Shortcuts app, create a shortcut with one action: Open App, then choose Touch 'n Go eWallet.</li>
      <li>Name it exactly <strong>Open TNG</strong>.</li>
      <li>Do the same for MAE and name it exactly <strong>Open MAE</strong>.</li></ol>
    </details></section>
    ${dock()}`;
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
      ${s.count ? [...s.transactions].reverse().map((t) => `<button class="buy ${t.id === selected ? 'lit' : ''}" data-edit="${esc(t.id)}">
        <strong>${esc(t.merchant)}</strong><span>${formatRM(t.amount_sen)}</span>
        <small>${time(t.occurred_at)}, ${esc(t.needs_review ? '' : t.category)}${t.needs_review ? '<em>Tap to check</em>' : ''}${t.has_receipt ? ', receipt' : ''}</small></button>`).join('')
    : `<p class="empty">Double-tap the back of your iPhone on a ShopeePay receipt, or tap with Apple Pay. Purchases appear here.</p>`}
    </section>
    ${dock()}`;
  setOver(Boolean(s.budget) && s.total > s.budget);
}

let sheetPurchase = null;
let receiptTarget = null;
const receiptInput = document.getElementById('receipt-input');

async function showReceiptArea(t, message = '') {
  const area = document.getElementById('receipt-area');
  if (!area) return;
  const note = message ? `<p class="error">${esc(message)}</p>` : '';
  if (!t.has_receipt) {
    area.innerHTML = `<div class="row"><button type="button" data-receipt-take="${esc(t.id)}">Add receipt photo</button></div>${note}`;
    return;
  }
  area.innerHTML = `<p class="hint">Loading receipt</p>${note}`;
  try {
    const src = await api.getReceipt(t.id);
    if (document.getElementById('receipt-area') !== area) return;
    area.innerHTML = `<img src="${src}" alt="Receipt photo"><div class="row"><button type="button" data-receipt-take="${esc(t.id)}">Replace photo</button><button type="button" data-receipt-remove="${esc(t.id)}">Remove photo</button></div>${note}`;
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
receiptInput.addEventListener('change', async () => {
  const file = receiptInput.files[0];
  const id = receiptTarget;
  receiptInput.value = '';
  if (!file || !id) return;
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
});

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
    ${fromReceipt ? '<p class="error">Check these details against your receipt.</p>' : ''}
    <label>Amount (RM)<input name="amount" inputmode="decimal" required value="${t ? (t.amount_sen / 100).toFixed(2) : ''}"></label>
    <label>Where<input name="merchant" required value="${t ? esc(t.merchant) : ''}"></label>
    <label>Category<select name="category">${CATEGORIES.map((c) => `<option ${(t?.category || 'Food') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <div class="two"><label>Date<input name="date" type="date" required max="${today}" value="${when.date}"></label>
    <label>Time<input name="time" type="time" required value="${when.time}"></label></div>
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
  form.querySelector('[data-del]')?.addEventListener('click', async () => {
    try { await api.remove(t.id); sheet.close(); refresh(); } catch (err) { fail(err); }
  });
  sheet.showModal();
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
    const res = await fetch('/api/export', { headers: { authorization: `Bearer ${store.get('kd-key')}` } });
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
  if (!DEMO && !store.get('kd-key')) return renderGate();
  try {
    if (page === 'links') renderLinks();
    else if (page === 'home') { home = await api.loadHome(range, homeDate); renderHome(); } else { summary = await api.load(date); render(); }
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
  else if (d.tick) { selected = nextTick(el, e.detail === 0); render(); }
  else if (d.edit) openSheet(summary.transactions.find((t) => t.id === d.edit));
  else if (d.add !== undefined) openSheet(null);
  else if (d.receiptTake) { receiptTarget = d.receiptTake; receiptInput.click(); }
  else if (d.receiptSkip) { store.set('kd-no-receipt', d.receiptSkip); refresh(); }
  else if (d.checked) { store.set('kd-checked', d.checked); refresh(); }
  else if (d.defaultBudget !== undefined) openAmountSheet({ title: 'Default daily budget', label: 'Budget when you skip setting one (RM)', action: 'Save default', value: home.defaultBudget, optional: true, hint: 'Leave empty to use your can-spend-per-day amount.', save: (v) => api.setDefaultBudget(v) });
  else if (d.addCommitment !== undefined) openCommitmentAdd();
  else if (d.commitment) openCommitmentRemove(home.commitmentList.find((c) => c.id === d.commitment));
  else if (d.export !== undefined) downloadCsv();
  else if (d.tip !== undefined) { store.set('kd-tip', '1'); render(); }
});
sheet.addEventListener('click', async (e) => {
  if (e.target === sheet) return sheet.close();
  const el = e.target.closest('button');
  if (!el) return;
  if (el.dataset.receiptTake) { receiptTarget = el.dataset.receiptTake; receiptInput.click(); }
  else if (el.dataset.receiptRemove) {
    try { await api.removeReceipt(el.dataset.receiptRemove); sheetPurchase.has_receipt = 0; showReceiptArea(sheetPurchase); } catch (err) { showReceiptArea(sheetPurchase, err.message); }
  }
});
sheet.addEventListener('close', () => { if (page !== 'links') refresh(); });
// Picks up new purchases when you return from ShopeePay.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !sheet.open) refresh(); });

if (!DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
refresh();
