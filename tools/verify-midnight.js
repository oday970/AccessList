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

// THEMES.midnight.grad stops. The lightest is the worst case for light type.
const STOPS = { dark: '#0a1326', light: '#0d1b3a', mid: '#10142e' };
const GROUND = STOPS.light;

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

console.log('\n' + (fail ? `${fail} PROBLEM(S)` : 'All checks passed.'));
process.exit(fail ? 1 : 0);
