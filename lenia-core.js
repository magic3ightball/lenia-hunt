// Lenia core: CPU FFT simulation, feature extraction, classification.
// Shared by the search worker, the main-thread fallback, and tools/smoke.mjs.

// ---------- PRNG ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- kernel & growth ----------
// Standard Lenia kernel: concentric rings with peak heights `beta`,
// each ring shaped by the exponential bump exp(4 - 1/(x(1-x))).
export function kernelValue(r, beta) {
  if (r <= 0 || r >= 1) return 0;
  const B = beta.length;
  const br = B * r;
  const idx = Math.min(B - 1, Math.floor(br));
  const x = br - idx;
  if (x <= 0 || x >= 1) return 0;
  return beta[idx] * Math.exp(4 - 1 / (x * (1 - x)));
}

// Returns a (2R+1)^2 normalized weight array, row-major, centered.
export function kernelPatch(R, beta) {
  const D = 2 * R + 1;
  const w = new Float32Array(D * D);
  let sum = 0;
  for (let y = -R; y <= R; y++)
    for (let x = -R; x <= R; x++) {
      const v = kernelValue(Math.hypot(x, y) / R, beta);
      w[(y + R) * D + (x + R)] = v;
      sum += v;
    }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
}

export function growth(u, mu, sigma) {
  const d = (u - mu) / sigma;
  return 2 * Math.exp(-0.5 * d * d) - 1;
}

// ---------- FFT (radix-2, in place, separate re/im) ----------
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  // transform one strided line
  return function fft(re, im, off, stride, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = off + i * stride, b = off + j * stride;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const wr = cos[k], wi = sgn * sin[k];
          const a = off + (i + j) * stride, b = a + half * stride;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

function fft2(re, im, N, fft, inverse) {
  for (let y = 0; y < N; y++) fft(re, im, y * N, 1, inverse);
  for (let x = 0; x < N; x++) fft(re, im, x, N, inverse);
  if (inverse) {
    const s = 1 / (N * N);
    for (let i = 0; i < re.length; i++) { re[i] *= s; im[i] *= s; }
  }
}

// ---------- simulation ----------
export class LeniaCPU {
  constructor(N, p) {
    this.N = N;
    this.p = p;
    this.A = new Float32Array(N * N);
    this.fft = makeFFT(N);
    this.re = new Float64Array(N * N);
    this.im = new Float64Array(N * N);
    // kernel FFT
    const R = p.R, D = 2 * R + 1, w = kernelPatch(R, p.beta);
    const kr = new Float64Array(N * N), ki = new Float64Array(N * N);
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++) {
        const xx = (x + N) % N, yy = (y + N) % N;
        kr[yy * N + xx] += w[(y + R) * D + (x + R)];
      }
    fft2(kr, ki, N, this.fft, false);
    this.kr = kr; this.ki = ki;
  }
  step() {
    const { N, A, re, im, kr, ki } = this;
    const { mu, sigma, dt } = this.p;
    for (let i = 0; i < N * N; i++) { re[i] = A[i]; im[i] = 0; }
    fft2(re, im, N, this.fft, false);
    for (let i = 0; i < N * N; i++) {
      const a = re[i], b = im[i];
      re[i] = a * kr[i] - b * ki[i];
      im[i] = a * ki[i] + b * kr[i];
    }
    fft2(re, im, N, this.fft, true);
    const inv2s2 = 1 / (2 * sigma * sigma);
    for (let i = 0; i < N * N; i++) {
      const d = re[i] - mu;
      const e = d * d * inv2s2; // skip exp() deep in the tail: it is slow there and G = -1 anyway
      let v = A[i] + dt * (e > 30 ? -1 : 2 * Math.exp(-e) - 1);
      A[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
}

// ---------- parameter / seed generation ----------
const RING_SETS = [[1], [1], [1], [1, 0.5], [0.5, 1], [1, 1], [1, 0.5, 0.25], [0.25, 1, 0.5], [1, 0.33, 0.66], [0.5, 1, 0.5]];

export function randomParams(rng) {
  const beta = RING_SETS[Math.floor(rng() * RING_SETS.length)].slice();
  const B = beta.length;
  // Multi-ring kernels want somewhat larger mu (Chan 2019, Fig. 4 parameter maps).
  const mu = B === 1 ? 0.1 + rng() * 0.25 : 0.14 + rng() * 0.26;
  // Gliders live in a thin band where sigma ~ mu/10; sample a band around it.
  const sigma = mu * (0.06 + rng() * 0.12);
  const R = 10 + Math.floor(rng() * 6);
  const dt = 0.1; // fixed so batched GPU tiles share one sampling cadence
  return { R, beta, mu: round4(mu), sigma: round4(sigma), dt };
}

export function mutateParams(p, rng, amt = 1) {
  const q = { ...p, beta: p.beta.slice() };
  q.mu = round4(clamp(p.mu * (1 + gauss(rng) * 0.04 * amt), 0.05, 0.6));
  q.sigma = round4(clamp(p.sigma * (1 + gauss(rng) * 0.06 * amt), 0.004, 0.12));
  if (rng() < 0.2 * amt) {
    const i = Math.floor(rng() * q.beta.length);
    q.beta[i] = round4(clamp(q.beta[i] + gauss(rng) * 0.15, 0.1, 1));
    const m = Math.max(...q.beta);
    q.beta = q.beta.map((b) => round4(b / m));
  }
  return q;
}

// Random asymmetric noise disc around the grid center. Everything is drawn from
// `rng`, so (params, seed) fully reproduce a candidate.
export function seedBlob(A, N, R, rng) {
  const rad = R * (0.9 + rng() * 1.1);
  const density = 0.5 + rng() * 0.5;
  const amp = 0.45 + rng() * 0.55;
  const cx = N / 2, cy = N / 2;
  // a random linear tilt makes the blob lopsided, which favours motion
  const bx = gauss(rng) * 0.5, by = gauss(rng) * 0.5;
  const r0 = Math.ceil(rad);
  for (let y = -r0; y <= r0; y++)
    for (let x = -r0; x <= r0; x++) {
      const dx = x / rad, dy = y / rad;
      if (dx * dx + dy * dy >= 1) continue;
      const v = rng() < density ? rng() * amp * (1 + bx * dx + by * dy) : 0;
      A[((cy + y + N) % N) * N + ((cx + x + N) % N)] = clamp(v, 0, 1);
    }
}

// ---------- measurement ----------
// Torus-aware centroid via circular mean, plus mass and second moments around it.
export function measure(A, N) {
  let m = 0, cxs = 0, cxc = 0, cys = 0, cyc = 0, occ = 0;
  const tw = (2 * Math.PI) / N;
  for (let y = 0; y < N; y++) {
    const sy = Math.sin(y * tw), cy = Math.cos(y * tw);
    for (let x = 0; x < N; x++) {
      const a = A[y * N + x];
      if (a === 0) continue;
      m += a;
      if (a > 0.1) occ++;
      cxs += a * Math.sin(x * tw); cxc += a * Math.cos(x * tw);
      cys += a * sy; cyc += a * cy;
    }
  }
  if (m < 1e-6) return { mass: 0, cx: N / 2, cy: N / 2, occ: 0, coherence: 0 };
  const cx = ((Math.atan2(cxs, cxc) / tw) + N) % N;
  const cy = ((Math.atan2(cys, cyc) / tw) + N) % N;
  // coherence ~1 for one compact blob, ~0 when mass is spread around the torus
  const coherence = Math.min(Math.hypot(cxs, cxc), Math.hypot(cys, cyc)) / m;
  return { mass: m, cx, cy, occ: occ / (N * N), coherence };
}

function wrapDelta(d, N) {
  if (d > N / 2) d -= N;
  if (d < -N / 2) d += N;
  return d;
}

// Rotation-invariant shape descriptor around the centroid:
// radial mass profile (6 bins up to 2R), elongation, and lopsidedness.
export function shapeDescriptor(A, N, cx, cy, R) {
  const bins = new Float64Array(6);
  let m = 0, sxx = 0, syy = 0, sxy = 0, mx = 0, my = 0, m3 = 0;
  const rmax = 2 * R;
  const x0 = Math.floor(cx - rmax), y0 = Math.floor(cy - rmax);
  for (let j = 0; j <= 2 * rmax; j++)
    for (let i = 0; i <= 2 * rmax; i++) {
      const x = (x0 + i + N * 4) % N, y = (y0 + j + N * 4) % N;
      const a = A[y * N + x];
      if (a === 0) continue;
      const dx = x0 + i - cx, dy = y0 + j - cy;
      const r = Math.hypot(dx, dy);
      if (r > rmax) continue;
      bins[Math.min(5, Math.floor((r / rmax) * 6))] += a;
      m += a; sxx += a * dx * dx; syy += a * dy * dy; sxy += a * dx * dy;
      mx += a * dx; my += a * dy; m3 += a * r * r * r;
    }
  if (m < 1e-6) return { radial: Array(6).fill(0), elong: 0, spread: 0 };
  for (let i = 0; i < 6; i++) bins[i] /= m;
  const tr = (sxx + syy) / m, det = (sxx * syy - sxy * sxy) / (m * m);
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  return {
    radial: Array.from(bins),
    elong: 1 - Math.sqrt(l2 / l1), // 0 round, ->1 rod
    spread: Math.sqrt(tr) / R, // RMS radius in units of R
  };
}

// ---------- run + classify ----------
export const SAMPLE_EVERY = 5; // steps between measurements
export const MAX_STEPS = 400; // screening horizon (40 time units at dt=0.1)
export const CONFIRM_STEPS = 1500; // provisional keepers must survive this long

// Accumulates measurements for one candidate. Shared by CPU evaluate() and the GPU batch search.
// observe() returns null while still running, or the final class string when decided.
// Two stages: everything is screened at MAX_STEPS; only provisional keepers continue to
// CONFIRM_STEPS and are re-classified on the late window, which weeds out slow growers.
export class Tracker {
  constructor(p, N, maxSteps = MAX_STEPS, confirmSteps = CONFIRM_STEPS) {
    this.p = p; this.N = N; this.maxSteps = maxSteps; this.confirmSteps = confirmSteps;
    this.track = []; this.shapes = [];
    this.px = null; this.py = null; this.ux = 0; this.uy = 0;
    this.cls = null; this.features = null; this.last = null; this.stage1 = null;
  }
  get horizon() { return this.stage1 ? this.confirmSteps : this.maxSteps; }
  observe(t, A) {
    const { N, p } = this;
    const s = measure(A, N);
    this.last = s;
    if (s.mass < 0.5) return (this.cls = 'dies');
    if (s.occ > 0.3) return (this.cls = 'explodes');
    if (this.px !== null) { this.ux += wrapDelta(s.cx - this.px, N); this.uy += wrapDelta(s.cy - this.py, N); }
    this.px = s.cx; this.py = s.cy;
    this.track.push({ t: t * p.dt, mass: s.mass, x: this.ux, y: this.uy, occ: s.occ, coh: s.coherence });
    if (t >= 100 && this.track.length % 4 === 0) {
      const d = shapeDescriptor(A, N, s.cx, s.cy, p.R);
      d.t = t * p.dt;
      this.shapes.push(d);
    }
    if (t < this.horizon) return null;
    const f = features(this.track, this.shapes, p.R);
    let cls = classify(f);
    if (!this.stage1) {
      if (!KEEPERS.has(cls)) { this.features = f; return (this.cls = cls); }
      this.stage1 = { cls, mass: s.mass };
      return null;
    }
    // long-run mass change since screening also counts as instability
    if (Math.abs(s.mass - this.stage1.mass) / this.stage1.mass > 0.25) cls = 'unstable';
    this.features = f;
    return (this.cls = cls);
  }
  crop(A) {
    const s = this.last;
    return cropAround(A, this.N, s.cx, s.cy, Math.min(this.N >> 1, Math.ceil(this.p.R * 2.2)));
  }
}

// Runs one candidate on the CPU and returns a summary.
export function evaluate(N, p, seed, opts = {}) {
  const rng = mulberry32(seed);
  const sim = new LeniaCPU(N, p);
  if (opts.init) opts.init(sim.A, N, rng); else seedBlob(sim.A, N, p.R, rng);
  const tr = new Tracker(p, N);
  for (let t = 0; ; t++) {
    if (t > 0) sim.step();
    if (t % SAMPLE_EVERY === 0 && tr.observe(t, sim.A)) break;
  }
  const res = { p, seed, N, track: tr.track, cls: tr.cls, features: tr.features };
  if (tr.features) { res.state = sim.A; res.crop = tr.crop(sim.A); }
  return res;
}

function stats(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(v) };
}

export function features(track, shapes, R) {
  const late = track.slice(Math.floor(track.length / 2));
  const T = late[late.length - 1].t - late[0].t || 1;
  const dx = late[late.length - 1].x - late[0].x, dy = late[late.length - 1].y - late[0].y;
  const speed = Math.hypot(dx, dy) / T / R; // grid units per time unit, per R
  // straightness: net displacement vs path length (1 = straight glider, ~0 = wander)
  let path = 0;
  for (let i = 1; i < late.length; i++) path += Math.hypot(late[i].x - late[i - 1].x, late[i].y - late[i - 1].y);
  const straight = path > 1e-6 ? Math.hypot(dx, dy) / path : 0;
  const ms = stats(late.map((s) => s.mass));
  const massCV = ms.sd / ms.mean;
  const occ = stats(late.map((s) => s.occ)).mean;
  const coh = stats(late.map((s) => s.coh)).mean;
  // compare first vs second half of late window to catch slow growth/decay
  const h = Math.floor(late.length / 2);
  const m1 = stats(late.slice(0, h).map((s) => s.mass)).mean;
  const m2 = stats(late.slice(h).map((s) => s.mass)).mean;
  const trend = (m2 - m1) / ms.mean;
  const drift = Math.abs(trend);
  // shape stability: variance of radial profile across late snapshots
  shapes = shapes.filter((sh) => sh.t >= late[0].t);
  let shapeVar = 0;
  const radial = Array(6).fill(0);
  let elong = 0, spread = 0;
  for (const s of shapes) { s.radial.forEach((v, i) => (radial[i] += v / shapes.length)); elong += s.elong / shapes.length; spread += s.spread / shapes.length; }
  for (const s of shapes) s.radial.forEach((v, i) => (shapeVar += (v - radial[i]) ** 2));
  shapeVar = shapes.length ? Math.sqrt(shapeVar / shapes.length) : 1;
  return {
    speed, straight, massCV, drift, trend, occ, coh, shapeVar,
    massR2: ms.mean / (R * R), radial, elong, spread,
  };
}

export function classify(f) {
  // spread out over the torus -> treat as a field/soup, not a creature
  if (f.coh < 0.35 || f.spread > 1.6) return 'chaotic';
  if (f.drift > 0.12) return 'unstable';
  const moving = f.speed > 0.01 && f.straight > 0.3;
  if (moving) return f.massCV > 0.03 || f.shapeVar > 0.03 ? 'pulsing-mover' : 'glider';
  if (f.massCV > 0.01 || f.shapeVar > 0.02) return 'oscillator';
  return 'static';
}

export const KEEPERS = new Set(['glider', 'pulsing-mover', 'oscillator']);

// Feature vector for novelty, each dimension scaled to roughly unit range.
export function featureVector(f) {
  return [
    Math.min(f.speed / 0.4, 2),
    Math.min(f.massCV / 0.05, 2),
    Math.min(f.shapeVar / 0.04, 2),
    Math.log(Math.max(f.massR2, 1e-3)) / 2,
    f.elong * 2,
    f.spread,
    f.straight,
    ...f.radial.map((v) => v * 3),
  ];
}

export function novelty(vec, archive, k = 3) {
  if (!archive.length) return Infinity;
  const ds = archive.map((a) => Math.sqrt(a.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0))).sort((a, b) => a - b);
  const kk = Math.min(k, ds.length);
  return ds.slice(0, kk).reduce((a, b) => a + b, 0) / kk;
}

// ---------- crop encode/decode (8-bit, base64) ----------
export function cropAround(A, N, cx, cy, half) {
  const S = 2 * half;
  const out = new Uint8Array(S * S);
  const x0 = Math.round(cx) - half, y0 = Math.round(cy) - half;
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++)
      out[j * S + i] = Math.round(A[((y0 + j + N * 4) % N) * N + ((x0 + i + N * 4) % N)] * 255);
  return { S, data: out };
}

export function b64encode(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64decode(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ---------- utils ----------
export function gauss(rng) {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function round4(v) { return Math.round(v * 10000) / 10000; }

// ---------- search policy ----------
// Creatures live on the edge between "dies" and "explodes". Each search slot keeps a
// lineage and nudges sigma toward that edge after every failure; keepers spawn
// mutated offspring. Returns the next params for this slot.
export function nextCandidate(lineage, outcome, rng, gallery = []) {
  const fresh = () => {
    // a third of fresh starts branch off a saved creature to explore its neighbourhood
    if (gallery.length && rng() < 0.33) {
      const g = gallery[Math.floor(rng() * gallery.length)];
      return { p: mutateParams(g.p, rng, 1.5), tries: 0, parent: g.id };
    }
    return { p: randomParams(rng), tries: 0, parent: null };
  };
  if (!lineage || !outcome) return fresh();
  const p = { ...lineage.p, beta: lineage.p.beta.slice() };
  const tries = lineage.tries + 1;
  if (tries > 24) return fresh();
  const f = outcome.features;
  const nudge = (dir) => {
    const k = 1 + dir * (0.05 + rng() * 0.15);
    p.sigma = Math.round(clamp(p.sigma * k, 0.003, 0.15) * 1e4) / 1e4;
  };
  switch (outcome.cls) {
    case 'dies': nudge(+1); break;
    case 'explodes': case 'chaotic': nudge(-1); break;
    case 'unstable': nudge(f && f.trend > 0 ? -0.5 : +0.5); break;
    case 'static': return { p: mutateParams(p, rng, 1), tries, parent: lineage.parent };
    default: // keeper: explore its neighbourhood half the time, else start over
      return rng() < 0.5 ? { p: mutateParams(p, rng, 0.7), tries: 0, parent: lineage.parent } : fresh();
  }
  return { p, tries, parent: lineage.parent };
}
