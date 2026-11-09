import { CATEGORIES, SOURCE_LABELS, addDays, formatRM, localDate, summarize, windowStart } from './summary.js';

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

async function request(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { authorization: `Bearer ${store.get('kd-key')}`, 'content-type': 'application/json' } });
  if (res.status === 401) { store.del('kd-key'); renderGate('That access key was not accepted.'); throw new Error('unauthorized'); }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Could not save. Check your connection and try again.'); }
  return res.json();
}
const api = DEMO ? {
  load: async (d) => summarize(demoTxs.filter((t) => t.local_date >= windowStart(d)), d),
  update: async (id, f) => {
    const t = demoTxs.find((x) => x.id === id);
    Object.assign(t, { merchant: f.merchant, category: f.category, amount_sen: Math.round(parseFloat(f.amount) * 100), needs_review: 0 });
  },
  remove: async (id) => demoTxs.splice(demoTxs.findIndex((x) => x.id === id), 1),
  add: async (f) => demoTxs.push({ id: `m${Date.now()}`, merchant: f.merchant, category: f.category, amount_sen: Math.round(parseFloat(f.amount) * 100), source: 'manual', occurred_at: new Date(f.date === localDate() ? Date.now() : `${f.date}T12:00:00+08:00`).toISOString(), local_date: f.date, needs_review: 0 }),
} : {
  load: (d) => request(`/api/summary?date=${d}`),
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

function render() {
  const s = summary;
  const today = localDate();
  const [, cents] = (s.total / 100).toFixed(2).split('.');
  const whole = Math.floor(s.total / 100).toLocaleString('en-MY');
  const topCat = s.byCategory[0]?.total || 1;
  const weekMax = Math.max(...s.week.map((d) => d.total), 1);
  const showTip = !DEMO && !window.navigator.standalone && !matchMedia('(display-mode: standalone)').matches && !store.get('kd-tip');

  app.innerHTML = `
    <header class="dayline">
      <button class="step" data-go="-1" aria-label="Previous day">‹</button>
      <h1>${date === today ? 'Today, ' : ''}${dayName(date, { weekday: date === today ? undefined : 'short', day: 'numeric', month: 'long' })}</h1>
      <button class="step" data-go="1" aria-label="Next day" ${date >= today ? 'disabled' : ''}>›</button>
    </header>
    <div class="total" aria-label="${formatRM(s.total)}"><span class="rm">RM</span><span class="whole">${whole}</span><span class="sen">.${cents}</span></div>
    ${verdict(s)}
    ${ribbon(s)}
    ${showTip ? `<div class="tip"><span>Install this on your iPhone: in Safari, tap Share, then Add to Home Screen.</span><button data-tip>Dismiss</button></div>` : ''}
    ${s.count ? `
    <section><h2>Where it went</h2>
      ${s.byCategory.map((c) => `<div class="bar-row"><div><b>${esc(c.name)}</b><span>${formatRM(c.total)}</span></div><span class="bar" style="width:${Math.max(2, (c.total / topCat) * 100)}%"></span></div>`).join('')}
    </section>
    <section><h2>How you paid</h2><div class="paid">
      ${s.bySource.map((p) => `<div><span>${SOURCE_LABELS[p.name]}</span><b>${formatRM(p.total)}</b></div>`).join('')}
    </div></section>` : ''}
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
    <button class="add" data-add>Add purchase</button>`;
}

function openSheet(t) {
  const fromReceipt = t?.needs_review;
  sheet.innerHTML = `<form method="dialog">
    <h2>${t ? 'Edit purchase' : 'Add purchase'}</h2>
    ${fromReceipt ? '<p class="error">Check these details against your receipt.</p>' : ''}
    <label>Amount (RM)<input name="amount" inputmode="decimal" required value="${t ? (t.amount_sen / 100).toFixed(2) : ''}"></label>
    <label>Where<input name="merchant" required value="${t ? esc(t.merchant) : ''}"></label>
    <label>Category<select name="category">${CATEGORIES.map((c) => `<option ${(t?.category || 'Food') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <p class="error" hidden></p>
    <div class="actions">${t ? '<button type="button" class="quiet" data-del>Delete</button>' : '<button type="button" class="quiet" data-close>Cancel</button>'}
    <button class="primary">${t ? 'Save changes' : 'Add purchase'}</button></div></form>`;
  const form = sheet.querySelector('form');
  const fail = (e) => { const p = form.querySelector('.error[hidden]'); if (p) { p.hidden = false; p.textContent = e.message; } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    try { await (t ? api.update(t.id, fields) : api.add({ ...fields, date })); sheet.close(); refresh(); } catch (err) { fail(err); }
  };
  form.querySelector('[data-close]')?.addEventListener('click', () => sheet.close());
  form.querySelector('[data-del]')?.addEventListener('click', async () => {
    try { await api.remove(t.id); sheet.close(); refresh(); } catch (err) { fail(err); }
  });
  sheet.showModal();
}

async function refresh() {
  if (!DEMO && !store.get('kd-key')) return renderGate();
  try { summary = await api.load(date); render(); } catch (e) {
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
  else if (d.day) { date = d.day; selected = null; refresh(); }
  else if (d.tick) { selected = nextTick(el, e.detail === 0); render(); }
  else if (d.edit) openSheet(summary.transactions.find((t) => t.id === d.edit));
  else if (d.add !== undefined) openSheet(null);
  else if (d.tip !== undefined) { store.set('kd-tip', '1'); render(); }
});
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
// Picks up new purchases when you return from ShopeePay.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !sheet.open) refresh(); });

if (!DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
refresh();
