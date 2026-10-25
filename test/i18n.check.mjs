// Localization: every key the UI uses exists in every locale, and the locales have the same keys.
//   node test/i18n.check.mjs
import fs from 'node:fs';
import ru from '../editor/locales/ru.js';
import en from '../editor/locales/en.js';
import { GENERATORS } from '../mcp/generators.js';

const KEY = /^[a-z][\w]*(\.[\w]+)+$/;
const used = new Set();
for (const f of ['editor/main.js', 'editor/inspector.js', 'editor/kinds.js', 'mcp/ops.js', 'app/main.mjs']) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
  for (const m of s.matchAll(/\bt\([^,()]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) { used.add(m[1]); used.add(m[2]); }
  // key tables (hints, layer and registry labels, script examples, top-bar buttons): quoted dotted keys
  for (const m of s.matchAll(/'((?:hint|layers|defs\.group|script\.ex|top|common|kind)\.[\w.]+)'/g)) used.add(m[1]);
}
for (const m of fs.readFileSync('editor/index.html', 'utf8').matchAll(/data-i18n(?:-title|-ph)?="([^"]+)"/g)) used.add(m[1]);
// generator names, help and parameter labels are built from the generator definitions
for (const g of GENERATORS) { used.add(`gen.${g.id}`); used.add(`gen.${g.id}.help`); for (const q of g.params) used.add(`gen.p.${q.name}`); }
const bad = [...used].filter((k) => !KEY.test(k));
const missing = { ru: [...used].filter((k) => KEY.test(k) && !(k in ru)), en: [...used].filter((k) => KEY.test(k) && !(k in en)) };
const onlyRu = Object.keys(ru).filter((k) => !(k in en)), onlyEn = Object.keys(en).filter((k) => !(k in ru));
const unused = Object.keys(ru).filter((k) => !used.has(k));
let fail = false;
for (const [what, list] of [['not a key', bad], ['missing in ru', missing.ru], ['missing in en', missing.en], ['only in ru', onlyRu], ['only in en', onlyEn]]) {
  if (list.length) { fail = true; console.log(`FAIL ${what}: ${list.join(', ')}`); }
}
if (unused.length) console.log(`note: ${unused.length} keys not found in code (built dynamically?): ${unused.join(', ')}`);
console.log(fail ? 'i18n check failed' : `OK ${used.size} keys used, ${Object.keys(en).length} in each locale`);
process.exit(fail ? 1 : 0);
