// Verifies the Midnight branch: WCAG ratios for every token that sets type,
// and the secondaries the three inks actually compute under `screen`.
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = (h) => { const [r, g, b] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const f2 = (n) => n.toFixed(2);

const GROUND = '#14161C';
const toHex = (a) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase()).join('');

// Composite src over dst with a separable blend fn at alpha a.
const blend = (fn) => (src, dst, a) => {
  const [s, d] = [hex(src), hex(dst)];
  return toHex(s.map((sc, i) => { const m = fn(sc, d[i]); return d[i] + a * (m - d[i]); }));
};
const screen = blend((s, d) => 255 - ((255 - s) * (255 - d)) / 255);
const multiply = blend((s, d) => (s * d) / 255);

const CYAN = '#0089B8', AMBER = '#F2A11A', SCARLET = '#D8214E';
const ALPHA = 0.6;

console.log('=== Type tokens on the Midnight ground ' + GROUND + ' ===');
const type = {
  '--ink       ': '#E8E4DC', '--ink-soft  ': '#A8A29A',
  '--cyan-t    ': '#4FC6E8', '--scarlet-t ': '#FF6E8A', '--amber-t   ': '#F5C267'
};
let fail = 0;
for (const [name, v] of Object.entries(type)) {
  const r = ratio(v, GROUND);
  const ok = r >= 4.5;
  if (!ok) fail++;
  console.log(`${name} ${v}  ${f2(r).padStart(6)}:1  ${ok ? 'PASS AA body' : 'FAIL'}`);
}

console.log('\n=== Raw inks as display type (needs 3:1 large-text floor) ===');
for (const [n, v] of [['cyan   ', CYAN], ['amber  ', AMBER], ['scarlet', SCARLET]]) {
  const r = ratio(v, GROUND);
  console.log(`${n} ${v}  ${f2(r).padStart(6)}:1  ${r >= 3 ? 'legal as display' : 'PIGMENT ONLY'}`);
}

console.log('\n=== Computed secondaries: screen on midnight (alpha ' + ALPHA + ') ===');
const lay = (a, b) => screen(b, screen(a, GROUND, ALPHA), ALPHA);
const pairs = [['cyan  x scarlet', CYAN, SCARLET], ['amber x scarlet', AMBER, SCARLET], ['cyan  x amber  ', CYAN, AMBER]];
for (const [n, a, b] of pairs) {
  const solo = screen(a, GROUND, ALPHA), cross = lay(a, b);
  const delta = Math.abs(L(cross) - L(solo));
  console.log(`${n} -> ${cross}   (single pass ${solo}, luminance separation ${delta.toFixed(3)})`);
  if (delta < 0.02) { console.log('   WARNING: crossing is not distinguishable from a single pass'); fail++; }
}

console.log('\n=== Same crossings under multiply, i.e. what we avoided ===');
const layM = (a, b) => multiply(b, multiply(a, GROUND, ALPHA), ALPHA);
for (const [n, a, b] of pairs) {
  const c = layM(a, b);
  console.log(`${n} -> ${c}   luminance ${L(c).toFixed(4)}${L(c) < 0.02 ? '   <- collapsed to black' : ''}`);
}

/* Solid fills, both grounds.

   This section exists because of a real bug. --scarlet-t is documented as
   "scarlet for type AND solid fills", and those two jobs travel in opposite
   directions when the ground flips: as a type colour it has to lighten on
   midnight, as a fill behind white text it has to stay dark. Lightening it
   and leaving --on-solid white shipped white on #FF6E8A at 2.68:1.

   Checking type tokens against the ground would never have caught it --
   the failing pair is fill vs its own label, and neither is the ground. */
console.log('\n=== Solid fills vs the type sitting on them ===');
const fills = {
  light: {
    ground: '#D5D5D5',
    pairs: [
      ['.btn                ', '#AD1739', '#FFFFFF'],   // --scarlet-t / --on-solid
      ['.btn--ghost:hover   ', '#005A73', '#FFFFFF'],   // --cyan-t    / --on-solid
      ['.launcher           ', '#D8214E', '#FFFFFF']    // --mark      / --on-mark
    ]
  },
  midnight: {
    ground: '#14161C',
    pairs: [
      ['.btn                ', '#FF6E8A', '#14161C'],
      ['.btn--ghost:hover   ', '#4FC6E8', '#14161C'],
      ['.launcher           ', '#D8214E', '#FFFFFF']
    ]
  }
};
for (const [scheme, { pairs }] of Object.entries(fills)) {
  console.log(` ${scheme}:`);
  for (const [name, bg, fg] of pairs) {
    const r = ratio(bg, fg);
    const ok = r >= 4.5;
    if (!ok) fail++;
    console.log(`   ${name} ${fg} on ${bg}  ${f2(r).padStart(6)}:1  ${ok ? 'PASS' : '*** FAIL AA ***'}`);
  }
}

console.log('\n' + (fail ? `${fail} PROBLEM(S)` : 'All checks passed.'));
process.exit(fail ? 1 : 0);
