const EXCLUDED = /balance|baki|saved|discount|diskaun|voucher|coin|cashback|rebate|promo|reward/i;
const TOTAL_LABEL = /total|amount|jumlah|paid|dibayar/i;
const MERCHANT_LABEL = /^(?:merchant(?: name)?|paid to|pay to|payee|recipient|penerima|peniaga|dibayar kepada|to)\b\s*[:\-]?\s*(.*)$/i;
const NOT_A_MERCHANT = /^(?:payment|you paid|total|view more|transaction|order)\b/i;
const REFERENCE_LABEL = /^(?:transaction (?:id|no\.?|number)|order (?:id|no\.?)|reference(?: no\.?| number)?|ref(?:\.| no\.?)|no\.? rujukan|id transaksi)\s*[:\-]?\s*(.*)$/i;
const SUCCESS = /success|successful|berjaya|completed|payment made|paid/i;
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
    if (match[1]) return match[1].trim();
    if (lines[i + 1]) return lines[i + 1];
  }
  return null;
};

/** Reads on-screen text from a ShopeePay payment receipt. */
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
  return {
    amount_sen: chosen.sen,
    merchant: merchant && !MONEY.test(merchant) ? merchant : null,
    reference: reference && LOOKS_LIKE_VALUE.test(reference) ? reference : null,
    confirmed: SUCCESS.test(text),
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
