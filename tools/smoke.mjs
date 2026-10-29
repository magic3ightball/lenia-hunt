// Headless check of the CPU core + search policy (the browser runs the same policy on the GPU).
// usage: node tools/smoke.mjs [candidates]
import { evaluate, mulberry32, nextCandidate, KEEPERS } from '../lenia-core.js';
import { ORBIUM, placeCells } from '../orbium.js';

const orb = evaluate(128, ORBIUM.p, 1, { init: (A, N) => placeCells(A, N, ORBIUM.cells) });
console.log('orbium ->', orb.cls, 'speed', orb.features?.speed.toFixed(3));
if (orb.cls !== 'glider') { console.error('FAIL: Orbium should classify as glider'); process.exit(1); }

const count = +(process.argv[2] ?? 0);
const rng = mulberry32(7);
const counts = {};
let lin = null, out = null;
const t0 = Date.now();
for (let i = 0; i < count; i++) {
  lin = nextCandidate(lin, out, rng);
  const seed = (rng() * 2 ** 32) >>> 0;
  out = evaluate(128, lin.p, seed);
  counts[out.cls] = (counts[out.cls] ?? 0) + 1;
  if (KEEPERS.has(out.cls)) console.log(i, out.cls, JSON.stringify(lin.p), 'speed', out.features.speed.toFixed(3));
}
if (count) console.log(`${count} candidates in ${((Date.now() - t0) / 1000).toFixed(0)}s`, counts);
