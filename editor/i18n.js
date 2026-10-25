// UI language. Strings live in editor/locales/<lang>.js under keys like 'save.dirty';
// t('file.readingName', { name }) fills {placeholders}. Works in the editor page and in the app's main
// process (no DOM needed). A key missing in a locale falls back to Russian, then to the key itself.
import ru from './locales/ru.js';
import en from './locales/en.js';

const DICTS = { ru, en };
export const LANGS = { ru: 'Русский', en: 'English' };
const KEY = 'city-labs-lang', listeners = [];

function initial() {
  try { const s = globalThis.window?.localStorage?.getItem(KEY); if (s && DICTS[s]) return s; } catch { /* no storage */ }
  return String(globalThis.navigator?.language ?? 'en').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}
let lang = initial();

export const getLang = () => lang;
export function setLang(l) {
  if (!DICTS[l] || l === lang) return;
  lang = l;
  try { globalThis.window?.localStorage?.setItem(KEY, l); } catch { /* no storage */ }
  if (globalThis.document) document.documentElement.lang = l;
  for (const fn of listeners) fn(l);
}
export const onLang = (fn) => listeners.push(fn);
export const hasKey = (key) => key in ru;

export function t(key, p) {
  let r = DICTS[lang][key] ?? ru[key] ?? key;
  if (p) r = r.replace(/\{(\w+)\}/g, (m, k) => (p[k] ?? m));
  return r;
}

/** Translate static markup: data-i18n (text), data-i18n-title, data-i18n-ph (placeholder) hold keys. */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
}
