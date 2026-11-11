// Shortcuts page entries, shared by the server and the demo so both validate the same way.

export const MAX_SHORTCUTS = 12;
export const LOGOS = ['tng', 'spay', 'mae'];

export const DEFAULT_SHORTCUTS = [
  { id: 'tng', name: "Touch 'n Go eWallet", kind: 'shortcut', target: 'Open TNG', logo: 'tng', icon: null },
  { id: 'spay', name: 'ShopeePay', kind: 'link', target: 'shopeepaymy://', logo: 'spay', icon: null },
  { id: 'mae', name: 'MAE by Maybank2u', kind: 'shortcut', target: 'Open MAE', logo: 'mae', icon: null },
];

// Links run when tapped, so schemes that can run code in the page are refused.
const BLOCKED_SCHEMES = /^(?:javascript|data|vbscript|file|blob|about):/i;
const ICON = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/;

export const shortcutHref = (s) => (s.kind === 'shortcut'
  ? `shortcuts://run-shortcut?name=${encodeURIComponent(s.target)}`
  : s.target);

export const shortcutCaption = (s) => (s.kind === 'link' && /^https?:/i.test(s.target) ? 'Open website' : 'Open app');

/** Checks one shortcut. Returns { shortcut } or { error }. */
export function cleanShortcut(input) {
  const name = String(input?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return { error: 'Give the shortcut a name.' };
  const kind = input?.kind === 'shortcut' ? 'shortcut' : 'link';
  let target = String(input?.target ?? '').trim();
  if (kind === 'shortcut') {
    target = target.slice(0, 80);
    if (!target) return { error: 'Enter the name of the iPhone Shortcut to run.' };
  } else {
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(target)) target = `https://${target}`;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target) || target.length > 300) return { error: 'Enter a link such as https://example.com or an app link such as shopeepaymy://' };
    if (BLOCKED_SCHEMES.test(target)) return { error: "That kind of link can't be used." };
  }
  const icon = typeof input?.icon === 'string' && ICON.test(input.icon) && input.icon.length <= 80000 ? input.icon : null;
  const logo = LOGOS.includes(input?.logo) ? input.logo : null;
  const id = /^[\w-]{1,40}$/.test(input?.id ?? '') ? input.id : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { shortcut: { id, name, kind, target, logo: icon ? null : logo, icon } };
}

export function cleanShortcuts(list) {
  if (!Array.isArray(list)) return { error: 'Send a list of shortcuts.' };
  if (list.length > MAX_SHORTCUTS) return { error: `Keep it to ${MAX_SHORTCUTS} shortcuts.` };
  const out = [];
  for (const item of list) {
    const { shortcut, error } = cleanShortcut(item);
    if (error) return { error };
    if (out.some((s) => s.id === shortcut.id)) shortcut.id += `-${out.length}`;
    out.push(shortcut);
  }
  return { shortcuts: out };
}
