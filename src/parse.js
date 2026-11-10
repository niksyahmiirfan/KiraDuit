const EXCLUDED = /balance|baki|saved|discount|diskaun|voucher|coin|cashback|rebate|promo|reward/i;
const TOTAL_LABEL = /total|amount|jumlah|paid|dibayar/i;
// "Recipient reference" is a note, not the payee, so "recipient" must not be followed by "reference".
const MERCHANT_LABEL = /^(?:merchant(?: name)?|paid to|pay to|payee|transfer(?:red)? to|receiver|recipient(?! ref)(?: name)?|penerima(?! ref)|peniaga|dibayar kepada|to)\b\s*[:\-]?\s*(.*)$/i;
const NOTE_LABEL = /^(?:recipient reference|remarks?|note|payment details?|catatan|rujukan penerima)\b\s*[:\-]?\s*(.*)$/i;
// Lines that are labels on these screens, so a label is never read as another label's value.
const ANY_LABEL = /^(?:merchant(?: name)?|paid to|pay to|payee|transfer(?:red)? to|receiver|recipient(?: name| reference)?|remarks?|note|date ?(?:&|and) ?time|transaction (?:date|id|no\.?|number|time)|payment time|ref(?:erence)?(?: id| no\.?)?|order (?:id|no\.?)|to)\s*:?$/i;
const NOT_A_MERCHANT = /^(?:payment|you paid|total|view more|transaction|order)\b/i;
const REFERENCE_LABEL = /^(?:transaction (?:id|no\.?|number)|order (?:id|no\.?)|reference(?: no\.?| number| id)?|ref(?:\.| no\.?| id)|no\.? rujukan|id transaksi)\s*[:\-]?\s*(.*)$/i;
const SUCCESS = /success|successful|berjaya|completed|payment made|paid|transferred/i;
// A wrapped all-caps name, such as "AHMAD RUSYAIDI BIN" then "DARAZAKI".
const CAPS_WORD = /^[A-Z][A-Z'@.-]+$/;
const MONEY = /(?:RM|MYR)\s*-?\s*(\d[\d,]*(?:\.\d{1,2})?)/i;
const LOOKS_LIKE_VALUE = /^[A-Z0-9-]{8,}$/i;

/** Converts "RM12.50", "MYR 1,234.50", "12,50" or 12.5 to sen. Returns null if unusable. */
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  let s = value.replace(/[^\d.,]/g, '');
  if (/,\d{2}$/.test(s) && !s.includes('.')) s = s.replace(/,(\d{2})$/, '.$1');
  s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, cents = ''] = s.split('.');
  const sen = Number(whole) * 100 + Number(cents.padEnd(2, '0'));
  return sen > 0 ? sen : null;
}

/** Wallet amounts must be just a number with an optional currency, so stray text can't become a price. */
export function parseWalletAmount(value) {
  if (typeof value === 'number') return parseMoney(value);
  const text = String(value ?? '').trim();
  if (!/^(?:[A-Z]{2,3}|[$€£¥])?\s*\d[\d.,]*\s*(?:[A-Z]{2,3})?$/i.test(text)) return null;
  return parseMoney(text);
}

const labelled = (lines, pattern) => {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (!match) continue;
    let value = match[1]?.trim();
    let at = i;
    if (!value) {
      // When the screen text lists labels first and values later, the next line is another label, so give up.
      if (!lines[i + 1] || ANY_LABEL.test(lines[i + 1])) continue;
      value = lines[i + 1];
      at = i + 1;
    }
    const next = lines[at + 1];
    if (value === value.toUpperCase() && /[A-Z]/.test(value) && next && CAPS_WORD.test(next) && !ANY_LABEL.test(next) && !/^DUITNOW/.test(next)) {
      value = `${value} ${next}`;
    }
    return value;
  }
  return null;
};

/** Which app the receipt came from, judged from its text. Null means unknown, which is treated as ShopeePay. */
export function detectWallet(text) {
  const t = String(text || '');
  if (/touch\s*['’]?\s*n\s*['’]?\s*go|\btng\b/i.test(t)) return 'TNG eWallet';
  if (/aeon/i.test(t) || (/recipient reference/i.test(t) && /new transfer|share receipt/i.test(t))) return 'AEON Bank';
  if (/shopee/i.test(t)) return 'ShopeePay';
  return null;
}

/** Reads on-screen text from a QR payment receipt in ShopeePay, AEON Bank or TNG eWallet. */
export function parseReceipt(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const candidates = [];
  lines.forEach((line, i) => {
    const match = line.match(MONEY);
    if (!match || EXCLUDED.test(line) || EXCLUDED.test(lines[i - 1] || '')) return;
    const sen = parseMoney(match[1]);
    if (sen) candidates.push({ sen, labelled: TOTAL_LABEL.test(line) || TOTAL_LABEL.test(lines[i - 1] || '') });
  });
  const chosen = candidates.find((c) => c.labelled) || candidates[0];
  if (!chosen) return null;

  const named = labelled(lines, MERCHANT_LABEL)?.replace(/^[•·*\s-]+/, '').trim();
  const merchant = named && !NOT_A_MERCHANT.test(named) ? named : null;
  const reference = labelled(lines, REFERENCE_LABEL);
  const note = labelled(lines, NOTE_LABEL);
  return {
    amount_sen: chosen.sen,
    merchant: merchant && !MONEY.test(merchant) ? merchant : null,
    reference: reference && LOOKS_LIKE_VALUE.test(reference) ? reference : null,
    confirmed: SUCCESS.test(text),
    wallet: detectWallet(text),
    // The payer's own note, such as "Reclub Session", becomes the purchase's What field.
    note: note && !MONEY.test(note) && !LOOKS_LIKE_VALUE.test(note) ? note.slice(0, 120) : null,
  };
}

const RULES = [
  ['Groceries', /speedmart|mydin|lotus|aeon big|jaya grocer|giant|village grocer|econsave|nsk|pasar|grocer/i],
  ['Transport', /grab|petronas|shell|petron|caltex|bhpetrol|rapid|mrt|lrt|ktm|parking|tng|touch.?n.?go|smart ?selangor|toll/i],
  ['Food', /kopitiam|mamak|nasi|restoran|restaurant|cafe|kafe|coffee|kopi|zus|tealive|starbucks|bakery|mcd|mcdonald|kfc|burger|domino|pizza|sushi|ramen|gerai|warung|bistro|food|makan|roti|ayam/i],
  ['Bills', /tnb|tenaga|unifi|maxis|celcom|digi|umobile|yes 4g|indah water|air selangor|insurance|takaful/i],
  ['Fun', /gsc|tgv|cinema|netflix|spotify|steam|bowling|karaoke/i],
  ['Shopping', /uniqlo|watsons|guardian|mr\.? ?diy|ikea|shopee|lazada|padini|h&m|zara|kk mart|99 ?mart|family ?mart|7.?eleven/i],
];

export const merchantKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function guessCategory(merchant) {
  return RULES.find(([, pattern]) => pattern.test(merchant))?.[0] || 'Other';
}
