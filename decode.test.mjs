/**
 * Extracts the decoder logic out of public/index.html and exercises it.
 *
 * The decoder lives inline in the page on purpose — no build step, and anyone
 * can open the file and add a signature. The cost of that choice is that the
 * logic needs pulling out to be tested, which is what this does.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const html = readFileSync(path.join(root, 'public/index.html'), 'utf8');
const inline = html.split('<script>')[1].split('</script>')[0];

// Cut at the start of the render section's comment banner, not inside it.
const marker = inline.indexOf('5 · RENDER');
if (marker === -1) throw new Error('Could not find the render section marker in index.html');
const logic = inline.slice(0, inline.lastIndexOf('/*', marker));

const { detect, SIGNATURES } = new Function(
  logic + '; return { detect, SIGNATURES };'
)();

let failures = 0;
const fail = (msg) => { console.error('  FAIL  ' + msg); failures++; };

/* ── 1 · autodetect ─────────────────────────────────────────────────────
   [ part number, expected signature id ]  — null means "should not match"  */

const DETECT = [
  ['D38999/26WD35SN',   'd38999'],
  ['M22759/16-20-9',    'm22759'],
  ['M27500-20SD2S23',   'm27500'],
  ['M39029/56-348',     'm39029'],
  ['M85049/38-15W',     'm85049'],
  ['M83513/01-A01N',    'm83513'],
  ['MS3106A-18-1S',     'm5015'],
  ['MS27467T15B35S',    'ms38999'],
  ['PT06E-12-3S',       'm26482'],
  ['8STA6E11A98SN',     'souriau'],
  ['EN3645-002M1305',   'en3645'],
  ['M23053/5-103-0',    'm23053'],
  ['M22520/1-01',       'm22520'],
  ['DT04-4P-E004',      'deutsch'],
  ['DTM06-12SA',        'deutsch'],
  ['HDP24-24-21PE',     'deutschHD'],
  ['GXL-16-BK/WH',      'j1128'],
  ['TXL-18-RD',         'j1128'],
  ['FLRY-B-1.5-RD',     'j1128'],
  ['43025-0400',        'molexMF'],
  ['SM06B-SRSS-TB',     'jst'],
  ['B4B-XH-A',          'jst'],
  ['PHR-2',             'jst'],
  ['09330062601',       'harting'],
  ['M12A-04PMMS',       'm12'],
  ['DF13-4S-1.25C',     'hirose'],
  ['SOMETHING-WEIRD-1', null]
];

console.log('autodetect');
for (const [pn, want] of DETECT) {
  const got = detect(pn);
  const id = got ? got.id : null;
  if (id !== want) fail(`${pn} → expected ${want ?? 'no match'}, got ${id ?? 'no match'}`);
}
console.log(`  ${DETECT.length} cases`);

/* ── 2 · parsers ────────────────────────────────────────────────────────
   Every part number with a parser must decode fully, and must produce the
   expected field labels. Catches a regex that silently stops capturing.   */

const PARSE = [
  ['D38999/26WD35SN', ['spec','style','finish','shell size','arrangement','contacts','key']],
  ['M22759/16-20-9',  ['spec','slash sheet','gauge','color']],
  ['M27500-20SD2S23', ['spec','gauge','basic wire','conductors','shield','jacket']],
  ['M39029/56-348',   ['spec','slash sheet','contact no.']],
  ['M85049/38-15W',   ['spec','slash sheet','shell size','finish']],
  ['M83513/01-A01N',  ['spec','slash sheet','arrangement','variant','termination']],
  ['MS3106A-18-1S',   ['style','class','shell size','arrangement','contacts']],
  ['DT04-4P-E004',    ['family','half','positions','contacts','variant']],
  ['DTM06-12SA',      ['family','half','positions','contacts','variant']],
  ['GXL-16-BK/WH',    ['wire type','gauge','base','stripe']],
  ['FLRY-B-1.5-RD',   ['family','class','area','base']]
];

console.log('parsers');
for (const [pn, want] of PARSE) {
  const sig = detect(pn);
  if (!sig?.parse) { fail(`${pn} has no parser`); continue; }
  const res = sig.parse(pn);
  if (res.error) { fail(`${pn} → ${res.error}`); continue; }
  const got = res.segments.filter(s => s.label !== null).map(s => s.label);
  if (got.join('|') !== want.join('|')) {
    fail(`${pn} → fields [${got.join(', ')}], expected [${want.join(', ')}]`);
  }
}
console.log(`  ${PARSE.length} cases`);

/* ── 3 · malformed input must degrade, never throw ──────────────────── */

console.log('malformed input');
const JUNK = ['D38999', 'D38999/', 'M22759/', 'DT04-', '', '   ', 'M27500-', '////', 'D38999/26WD35'];
for (const pn of JUNK) {
  const sig = detect(pn);
  if (!sig?.parse) continue;
  try {
    const res = sig.parse(pn);
    if (!res.error && !res.segments) fail(`${pn} returned neither error nor segments`);
  } catch (e) {
    fail(`${pn} threw: ${e.message}`);
  }
}
console.log(`  ${JUNK.length} cases`);

/* ── 4 · registry hygiene ───────────────────────────────────────────── */

console.log('registry');
const ids = SIGNATURES.map(s => s.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) fail(`duplicate signature ids: ${[...new Set(dupes)].join(', ')}`);
for (const s of SIGNATURES) {
  if (!s.ind || !s.fam) fail(`${s.id} is missing industry or family`);
  if (!(s.re instanceof RegExp)) fail(`${s.id} has no regex`);
  if (!s.parse && !s.note) fail(`${s.id} has no parser and no explanatory note`);
}
console.log(`  ${SIGNATURES.length} signatures`);

console.log('');
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('all checks passed');
