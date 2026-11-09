import { CATEGORIES, SOURCE_LABELS, addDays, budgetLine, formatRM, localDate, allowanceFor, payPeriod, periodFor, summarize, summarizePeriod, windowStart } from './summary.js';

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
  load: async (d) => summarize(demoTxs.filter((t) => t.local_date >= windowStart(d)), d, demoBudget(d).amount, demoBudget(d).source),
  loadHome: async (view, d) => {
    const today = localDate();
    return {
      ...summarizePeriod(demoTxs, { view, ...periodFor(view, d), today, income: demoIncome, commitments: commitmentsTotal() }),
      commitmentList: demoCommitments,
      todayTotal: demoTxs.filter((t) => t.local_date === today).reduce((a, t) => a + t.amount_sen, 0),
      todayBudget: demoBudget(today).amount,
      todayBudgetSource: demoBudget(today).source,
      defaultBudget: demoDefault,
    };
  },
  setBudget: async (d, amount) => { demoBudgets[d] = toSen(amount); },
  setIncome: async (amount) => { demoIncome = toSen(amount); },
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

const dock = () => `<nav class="dock" aria-label="Main">
  <button data-page="home" ${page === 'home' ? 'aria-current="page"' : ''}>Home</button>
  <button data-page="day" ${page === 'day' ? 'aria-current="page"' : ''}>Day</button>
  <button data-add>Add</button></nav>`;

const shortDate = (d) => dayName(d, { day: 'numeric', month: 'short' });

function incomeBlock(h) {
  if (h.income === null) {
    return `<section><h2>Income</h2><button class="income-prompt" data-income>Add your monthly income</button></section>`;
  }
  const over = h.left < 0;
  return `<section><h2>Income <button class="linkish" data-income>Change</button></h2>
    <span class="gauge"><i style="width:${Math.min(100, ((h.total + h.commitments) / h.income) * 100)}%"></i></span>
    <div class="money">
      <div><span>Received ${shortDate(h.start)}</span><b>${formatRM(h.income)}</b></div>
      <div><span>Spent and committed</span><b>${formatRM(h.total + h.commitments)}</b></div>
      <div><span>${over ? 'Overspent' : 'Left'}</span><b>${formatRM(Math.abs(h.left))}</b></div>
      ${h.daysToPayday !== null ? `<div><span>Can spend per day</span><b>${formatRM(h.dailyAllowance)}</b></div>
      <div><span>Next pay ${shortDate(h.nextPayday)}</span><b>${h.daysToPayday} ${h.daysToPayday === 1 ? 'day' : 'days'}</b></div>` : ''}
    </div></section>`;
}

function commitmentsBlock(h) {
  const current = h.daysToPayday !== null;
  const rows = h.commitmentList.map((c) => (current
    ? `<button class="list-row" data-commitment="${esc(c.id)}"><span>${esc(c.name)}</span><span>${formatRM(c.amount_sen)}</span></button>`
    : `<div class="list-row"><span>${esc(c.name)}</span><span>${formatRM(c.amount_sen)}</span></div>`)).join('');
  return `<section><h2>Fixed commitments${h.commitments ? `<small>${formatRM(h.commitments)}</small>` : ''}</h2>
    ${rows}${current ? `<button class="text-action" data-add-commitment>Add a commitment</button>` : ''}</section>`;
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
  const peak = Math.max(...h.days.map((d) => d.total), 1);
  const nextStart = addDays(h.end, 1);
  const label = `${shortDate(h.start)} to ${shortDate(h.end)}`;
  setOver(Boolean(h.todayBudget) && h.todayTotal > h.todayBudget);
  app.innerHTML = `
    <header class="dayline">
      <button class="step" data-shift="-1" aria-label="Previous ${isMonth ? 'pay period' : 'week'}">‹</button>
      <h1>${label}</h1>
      <button class="step" data-shift="1" aria-label="Next ${isMonth ? 'pay period' : 'week'}" ${nextStart > h.today ? 'disabled' : ''}>›</button>
    </header>
    <div class="range">
      <button data-range="week" aria-pressed="${!isMonth}">Weekly</button>
      <button data-range="month" aria-pressed="${isMonth}">Monthly</button>
    </div>
    ${bigTotal(h.total)}
    <p class="verdict">${h.count ? `${h.count} ${h.count === 1 ? 'purchase' : 'purchases'}<span>${formatRM(h.average)} a day on average</span>` : 'Nothing logged in this period.'}</p>
    ${budgetStrip(h.todayTotal, h.todayBudget, 'Today', h.today, h.todayBudgetSource)}
    ${eveningCheck(h.today)}
    ${isMonth ? incomeBlock(h) + commitmentsBlock(h) : ''}
    <section><h2>${isMonth ? 'Day by day' : 'Each day'}${h.biggest ? `<small>Highest ${formatRM(h.biggest.total)}</small>` : ''}</h2>
      <div class="week ${isMonth ? 'dense' : ''}" style="grid-template-columns:repeat(${h.days.length},1fr)">
      ${h.days.map((d) => `<button class="day ${d.date === h.today ? 'on' : ''}" data-day="${d.date}" ${d.date > h.today ? 'disabled' : ''} aria-label="${shortDate(d.date)}, ${formatRM(d.total)}">
        <i style="height:${Math.round((d.total / peak) * 92)}px"></i>${isMonth ? '' : `<span>${dayName(d.date, { weekday: 'narrow' })}</span>`}</button>`).join('')}
      </div>
      ${isMonth ? `<div class="axis"><span>${shortDate(h.start)}</span><span>${shortDate(h.end)}</span></div>` : ''}
    </section>
    ${h.count ? breakdown(h) : ''}
    ${moreBlock(h)}
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
    ${date === today ? eveningCheck(today) : ''}
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
        <small>${time(t.occurred_at)}, ${esc(t.needs_review ? '' : t.category)}${t.needs_review ? '<em>Tap to check</em>' : ''}</small></button>`).join('')
    : `<p class="empty">Double-tap the back of your iPhone on a ShopeePay receipt, or tap with Apple Pay. Purchases appear here.</p>`}
    </section>
    ${dock()}`;
  setOver(Boolean(s.budget) && s.total > s.budget);
}

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
    <p class="error" hidden></p>
    <div class="actions">${t ? '<button type="button" class="quiet" data-del>Delete</button>' : '<button type="button" class="quiet" data-close>Cancel</button>'}
    <button class="primary">${t ? 'Save changes' : 'Add purchase'}</button></div></form>`;
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
    if (page === 'home') { home = await api.loadHome(range, homeDate); renderHome(); } else { summary = await api.load(date); render(); }
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
  else if (d.checked) { store.set('kd-checked', d.checked); refresh(); }
  else if (d.defaultBudget !== undefined) openAmountSheet({ title: 'Default daily budget', label: 'Budget when you skip setting one (RM)', action: 'Save default', value: home.defaultBudget, optional: true, hint: 'Leave empty to use your can-spend-per-day amount.', save: (v) => api.setDefaultBudget(v) });
  else if (d.addCommitment !== undefined) openCommitmentAdd();
  else if (d.commitment) openCommitmentRemove(home.commitmentList.find((c) => c.id === d.commitment));
  else if (d.export !== undefined) downloadCsv();
  else if (d.tip !== undefined) { store.set('kd-tip', '1'); render(); }
});
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
// Picks up new purchases when you return from ShopeePay.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !sheet.open) refresh(); });

if (!DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
refresh();
