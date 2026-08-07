/* Verifies the Midnight token set in index.html.

   Run after ANY change to a colour token:  node tools/verify-midnight.js

   Two things earned this file. First, --mut (#5e6f9e) is a legitimate token
   of THEMES.midnight that is only 3.74:1 here -- it labels chrome in the
   panel, but on a page it would be setting paragraphs, so it must never
   reach type. Second, and the reason this script exists at all: an earlier
   check compared every type token against the GROUND and passed while the
   page's primary button rendered white on a light fill at 2.68:1. A fill
   against its own label is a pair in which neither side is the ground.
   Both relationships are checked below.

   Contrast is measured against the gradient's LIGHTEST stop, not --bg.
   Measuring against the darkest stop flatters every token by ~0.5:1. */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = (h) => { const [r, g, b] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const f2 = (n) => n.toFixed(2);

// The deep-space --grad stops. The lightest is the worst case for light type.
const STOPS = { dark: '#05060f', light: '#080a1e', mid: '#06060f' };
const GROUND = STOPS.light;

/* The nebula field sits above those stops, so the real worst case is not a
   gradient stop at all -- it is the ceiling the field is allowed up to.
   Derived here rather than hard-coded, so that raising a text token or
   swapping an accent moves the ceiling with it instead of silently
   invalidating it. */
const CEIL = 0.013;                    // what index.html clamps the field to
const ADMIN_WORST = '#1e193c';         // admin's five washes fully stacked
const SURF = [120, 160, 255, 0.08];    // --surf, laid over the field by cards

let fail = 0;
const check = (label, fg, bg, need, note) => {
  const r = ratio(fg, bg);
  const ok = r >= need;
  if (!ok) fail++;
  console.log(`  ${label.padEnd(22)} ${fg} on ${bg}  ${f2(r).padStart(6)}:1  ${ok ? 'PASS' : '*** FAIL (needs ' + need + ') ***'}${note ? '  ' + note : ''}`);
};

console.log(`=== Type on the ground (worst gradient stop ${GROUND}) ===`);
check('--text', '#e6edff', GROUND, 4.5);
check('--dim', '#9fb2e0', GROUND, 4.5);
check('--mut-t', '#8494c4', GROUND, 4.5, '(small labels)');
check('--accent', '#4f8cff', GROUND, 4.5, '(links)');
check('--accent2', '#6aa6ff', GROUND, 4.5, '(accent type)');

console.log('\n=== --mut must stay OFF type ===');
{
  const r = ratio('#5e6f9e', GROUND);
  const belowBody = r < 4.5;
  console.log(`  --mut #5e6f9e on ${GROUND}  ${f2(r).padStart(6)}:1  ${belowBody ? 'below AA body, as documented' : 'UNEXPECTED: now passes'}`);
  console.log('  (kept for fidelity to THEMES.midnight; --mut-t is what type uses)');
}

console.log('\n=== Solid fills vs the type sitting on them ===');
check('.btn', '#04102b', '#4f8cff', 4.5, '(--on-accent)');
check('.btn:hover', '#04102b', '#6aa6ff', 4.5);
check('.launcher', '#04102b', '#4f8cff', 4.5);
check('board rank 1', '#04102b', '#4f8cff', 4.5);
console.log('  -- the pairing this catches --');
{
  const r = ratio('#ffffff', '#4f8cff');
  console.log(`  white on --accent       ${f2(r).padStart(6)}:1  correctly NOT used (this is why --on-accent exists)`);
  if (r >= 4.5) { console.log('  *** white now passes: --on-accent may be redundant, re-check ***'); fail++; }
}

console.log('\n=== Every stop of the gradient, for the tokens that ride over all of it ===');
for (const [name, stop] of Object.entries(STOPS)) {
  const worst = Math.min(ratio('#9fb2e0', stop), ratio('#4f8cff', stop));
  const ok = worst >= 4.5;
  if (!ok) fail++;
  console.log(`  ${name.padEnd(6)} ${stop}  weakest of --dim/--accent  ${f2(worst).padStart(6)}:1  ${ok ? 'PASS' : '*** FAIL ***'}`);
}

/* The nebula ceiling.

   index.html paints a randomised field and clamps its brightest pixel to
   CEIL; admin.css uses fixed washes whose full-overlap worst case is
   ADMIN_WORST. Neither is worth anything unless the tokens still clear
   4.5:1 on a ground that bright -- WITH a card's --surf glass on top of it,
   which is the case that is easy to forget because it is two layers deep. */
console.log('\n=== The nebula ceiling ===');
{
  const over = (f, bg) => f.slice(0, 3).map((v, i) => v * f[3] + bg[i] * (1 - f[3]));
  const lumOf = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratioRGB = (a, b) => { const [x, y] = [lumOf(a), lumOf(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  // the brightest ground each surface permits
  const grounds = {
    'site (clamped to CEIL)': (() => {
      // a violet at exactly the ceiling: the hue that costs least light, so
      // it is the brightest-looking colour the clamp will ever allow through
      let best = hex(GROUND);
      for (let v = 0; v < 120; v++) {
        const cand = [v * 0.42, v * 0.26, v];      // violet ramp
        if (lumOf(cand) <= CEIL) best = cand;
      }
      return best;
    })(),
    'admin (washes stacked)': hex(ADMIN_WORST)
  };

  for (const [name, ground] of Object.entries(grounds)) {
    const glassed = over(SURF, ground);
    console.log(` ${name}  ground ${ground.map(Math.round)}  luminance ${lumOf(ground).toFixed(5)}`);
    if (lumOf(ground) > CEIL + 0.0005) {
      console.log(`   *** ground is over the ${CEIL} ceiling ***`);
      fail++;
    }
    for (const [n, v] of Object.entries({ '--dim': '#9fb2e0', '--mut-t': '#8494c4', '--accent': '#4f8cff' })) {
      const bare = ratioRGB(hex(v), ground);
      const onGlass = ratioRGB(hex(v), glassed);
      const ok = bare >= 4.5 && onGlass >= 4.5;
      if (!ok) fail++;
      console.log(`   ${n.padEnd(9)} ${f2(bare).padStart(6)}:1 bare | ${f2(onGlass).padStart(6)}:1 through --surf  ${ok ? 'PASS' : '*** FAIL ***'}`);
    }
  }
}

console.log('\n=== Nebula hue bands must exclude green / yellow / orange ===');
{
  const BANDS = [[196, 212], [220, 244], [244, 272], [272, 292], [300, 322], [330, 346]];
  const forbidden = BANDS.filter(([lo, hi]) => !(lo >= 195 && hi <= 346));
  console.log(`  six bands, span ${Math.min(...BANDS.map(b => b[0]))}-${Math.max(...BANDS.map(b => b[1]))}deg`);
  if (forbidden.length) { console.log('  *** a band strays outside 195-346 ***'); fail++; }
  else console.log('  all inside 195-346: green/yellow/orange unreachable by construction  PASS');
}

console.log('\n' + (fail ? `${fail} PROBLEM(S)` : 'All checks passed.'));
process.exit(fail ? 1 : 0);
