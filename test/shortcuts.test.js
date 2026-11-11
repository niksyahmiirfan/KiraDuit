import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHORTCUTS, cleanShortcut, cleanShortcuts, shortcutCaption, shortcutHref } from '../public/shortcuts.js';

test('shortcut links are built for apps, websites and iPhone Shortcuts', () => {
  assert.equal(shortcutHref(DEFAULT_SHORTCUTS[0]), 'shortcuts://run-shortcut?name=Open%20TNG');
  assert.equal(shortcutHref(DEFAULT_SHORTCUTS[1]), 'shopeepaymy://');
  assert.equal(shortcutCaption({ kind: 'link', target: 'https://x.com' }), 'Open website');
  assert.equal(shortcutCaption({ kind: 'shortcut', target: 'Open Boost' }), 'Open app');
});

test('links are checked, and bare domains get https', () => {
  assert.equal(cleanShortcut({ name: 'Bank', kind: 'link', target: 'www.rhb.com.my' }).shortcut.target, 'https://www.rhb.com.my');
  assert.equal(cleanShortcut({ name: 'Grab', kind: 'link', target: 'grab://' }).shortcut.target, 'grab://');
  assert.match(cleanShortcut({ name: 'Bad', kind: 'link', target: 'javascript:alert(1)' }).error, /can't be used/);
  assert.match(cleanShortcut({ name: 'Bad', kind: 'link', target: 'DATA:text/html,x' }).error, /can't be used/);
  assert.match(cleanShortcut({ name: 'Bad', kind: 'link', target: 'hello' }).error, /Enter a link/);
  assert.match(cleanShortcut({ name: ' ', kind: 'link', target: 'grab://' }).error, /name/);
  assert.match(cleanShortcut({ name: 'Boost', kind: 'shortcut', target: '' }).error, /Shortcut/);
});

test('icons must be small PNG or JPEG data, and replace a built-in logo', () => {
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(cleanShortcut({ name: 'A', kind: 'link', target: 'a://', icon, logo: 'tng' }).shortcut.logo, null);
  assert.equal(cleanShortcut({ name: 'A', kind: 'link', target: 'a://', icon: 'data:image/svg+xml;base64,PHN2Zz4=' }).shortcut.icon, null);
  assert.equal(cleanShortcut({ name: 'A', kind: 'link', target: 'a://', logo: 'evil' }).shortcut.logo, null);
});

test('a list is limited to 12 and keeps ids unique', () => {
  const many = Array.from({ length: 13 }, (_, i) => ({ name: `A${i}`, kind: 'link', target: 'a://' }));
  assert.match(cleanShortcuts(many).error, /12/);
  const r = cleanShortcuts([{ id: 'x', name: 'A', kind: 'link', target: 'a://' }, { id: 'x', name: 'B', kind: 'link', target: 'b://' }]);
  assert.notEqual(r.shortcuts[0].id, r.shortcuts[1].id);
});
