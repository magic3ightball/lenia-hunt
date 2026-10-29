import {
  Tracker, SAMPLE_EVERY, KEEPERS, seedBlob, mulberry32, featureVector, novelty,
  nextCandidate, b64encode, b64decode, measure,
} from './lenia-core.js';
import { LeniaGPU } from './gpu.js';
import { ORBIUM, placeCells } from './orbium.js';
import { drawKernel, drawGrowth, drawScatter } from './explain.js';
import { buildCard, creatureName } from './cards.js';
import { initTable, updateBar, layoutFan, tableDebug } from './table.js';

const N = 128;              // tile size for both search and viewer, so replays are faithful
const T = 4;                // search atlas is T x T tiles
const NOVELTY_MIN = 0.35;   // minimum kNN distance in feature space to enter the gallery
const GALLERY_MAX = 150;
const STORE_KEY = 'lenia-hunt-gallery-v1';
const CLASSES = ['glider', 'pulsing-mover', 'oscillator', 'static', 'unstable', 'chaotic', 'explodes', 'dies'];
const KO = { glider: '글라이더', 'pulsing-mover': '맥동 이동체', oscillator: '진동체', static: '정지', unstable: '불안정', chaotic: '혼돈', explodes: '폭발', dies: '소멸' };

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- colormap (matches the display shader) ----------
const STOPS = [[0, [.03, .04, .08]], [.25, [.05, .33, .42]], [.5, [.35, .72, .58]], [.8, [.98, .82, .42]], [1, [1, .97, .9]]];
const LUT = new Uint8ClampedArray(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = Math.pow(i / 255, 0.8);
  let k = 0;
  while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
  const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1];
  const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  for (let c = 0; c < 3; c++) LUT[i * 3 + c] = 255 * (c0[c] + (c1[c] - c0[c]) * f);
}

// ---------- gallery store ----------
let gallery = [];
function loadGallery() {
  try { gallery = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { gallery = []; }
}
function saveGallery() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(gallery)); } catch (e) { console.warn('gallery not persisted', e); }
}

// ---------- hunt ----------
const rng = mulberry32((Math.random() * 2 ** 32) >>> 0);
let hunt;
try { hunt = new LeniaGPU($('hunt'), { tile: N, T }); } catch (e) { fatal(e); }
const slots = Array.from({ length: T * T }, () => ({ lin: null, seed: 0, tracker: null, t: 0 }));
const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
const recent = [];
let evaluated = 0, keepersSeen = 0, running = false, busyMs = 0;

function startSlot(k, outcome) {
  const s = slots[k];
  s.lin = nextCandidate(s.lin, outcome, rng, gallery);
  s.seed = (rng() * 2 ** 32) >>> 0;
  const A = new Float32Array(N * N);
  seedBlob(A, N, s.lin.p.R, mulberry32(s.seed));
  hunt.setTile(k, s.lin.p, A);
  s.tracker = new Tracker(s.lin.p, N);
  s.t = 0;
  s.tracker.observe(0, A);
}

function finish(k, view) {
  const s = slots[k], tr = s.tracker, cls = tr.cls;
  evaluated++;
  counts[cls]++;
  recent.unshift(cls); recent.length = Math.min(recent.length, 64);
  let outcome = { cls, features: tr.features };
  if (KEEPERS.has(cls)) {
    keepersSeen++;
    const vec = featureVector(tr.features);
    const nov = novelty(vec, gallery.map((g) => g.vec));
    if (nov >= NOVELTY_MIN) {
      const crop = tr.crop(view);
      const { radial, ...f } = tr.features;
      const entry = {
        id: `${Date.now().toString(36)}-${k}`, p: s.lin.p, seed: s.seed, cls,
        features: { ...f, radial }, vec, novelty: Number.isFinite(nov) ? nov : 9.99,
        crop: { S: crop.S, b64: b64encode(crop.data) }, foundAt: Date.now(), parent: s.lin.parent,
        evaluatedAt: evaluated, opened: false, // sealed in a booster pack until torn open
      };
      gallery.push(entry);
      pruneGallery();
      saveGallery();
      renderGallery();
    }
  }
  startSlot(k, outcome);
}

function pruneGallery() {
  while (gallery.length > GALLERY_MAX) {
    // drop the member that is least distinct from the rest
    let worst = 0, worstN = Infinity;
    gallery.forEach((g, i) => {
      const nv = novelty(g.vec, gallery.filter((_, j) => j !== i).map((h) => h.vec));
      if (nv < worstN) { worstN = nv; worst = i; }
    });
    gallery.splice(worst, 1);
  }
}

const views = slots.map(() => new Float32Array(N * N));
function huntBatch() {
  const t0 = performance.now();
  hunt.step(SAMPLE_EVERY);
  hunt.read();
  for (let k = 0; k < slots.length; k++) {
    const s = slots[k];
    s.t += SAMPLE_EVERY;
    const view = hunt.tileView(k, views[k]);
    if (s.tracker.observe(s.t, view)) finish(k, view);
  }
  busyMs += performance.now() - t0;
}

// MessageChannel loop instead of rAF so the hunt keeps going when the tab/pane is hidden.
const chan = new MessageChannel();
chan.port1.onmessage = () => {
  if (!running) return;
  const t0 = performance.now();
  do huntBatch(); while (performance.now() - t0 < 25);
  hunt.render({ grid: true });
  renderStats();
  chan.port2.postMessage(0); // not setTimeout: hidden tabs clamp chained timers to 1 Hz
};
function setRunning(on) {
  running = on;
  $('huntToggle').textContent = on ? '⏸ 사냥 멈춤' : '▶ 사냥 재개';
  $('huntToggle').classList.toggle('primary', !on);
  if (on) chan.port2.postMessage(0);
}
$('huntToggle').onclick = () => setRunning(!running);

function renderStats() {
  const secs = busyMs / 1000; // time actually spent searching
  const rate = secs > 0 ? (evaluated / secs) * 60 : 0;
  $('stats').textContent = `평가 ${evaluated} · 분당 ${rate.toFixed(0)} · 생존자 ${keepersSeen} · 도감 ${gallery.length}`;
  $('tally').innerHTML = CLASSES.map((c) => `<span><i style="background:var(--${c})"></i>${KO[c]} ${counts[c]}</span>`).join('');
  $('recent').innerHTML = recent.map((c) => `<span class="chip" title="${KO[c]}" style="background:var(--${c})"></span>`).join('');
}

// ---------- viewer ----------
let viewer;
try { viewer = new LeniaGPU($('view'), { tile: N, T: 1 }); } catch (e) { fatal(e); }
let viewEntry = null, viewP = null, playing = true, viewT = 0;

function selectEntry(entry, mode) {
  viewEntry = entry;
  viewP = { ...entry.p, beta: entry.p.beta.slice() };
  const A = new Float32Array(N * N);
  if (mode === 'orbium') placeCells(A, N, ORBIUM.cells);
  else if (mode === 'crop' && entry.crop) {
    const S = entry.crop.S, d = b64decode(entry.crop.b64), o = (N - S) >> 1;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) A[(y + o) * N + x + o] = d[y * S + x] / 255;
  } else seedBlob(A, N, viewP.R, mulberry32(entry.seed));
  viewer.setTile(0, viewP, A);
  viewT = 0;
  syncSliders();
  const f = entry.features;
  $('viewTitle').innerHTML = `관찰창 <small>${entry.name ?? (entry.features ? `${creatureName(entry)} · ${KO[entry.cls]}` : KO[entry.cls] ?? '')}${mode === 'crop' ? ' · 최종 형태에서' : mode === 'seed' ? ' · 시드에서' : ''}</small>`;
  $('viewInfo').textContent =
    `R=${viewP.R}  β=[${viewP.beta.join(', ')}]  μ=${viewP.mu}  σ=${viewP.sigma}  dt=${viewP.dt}` +
    (entry.seed != null && entry.ref !== 'orbium-auto' && mode !== 'orbium' ? `  seed=${entry.seed}` : '') +
    (f ? `\n속도 ${f.speed.toFixed(3)}R/t · 직진성 ${f.straight.toFixed(2)} · 질량변동 ${(f.massCV * 100).toFixed(1)}% · 형태변동 ${f.shapeVar.toFixed(3)} · 길쭉함 ${f.elong.toFixed(2)}` : '');
  document.querySelectorAll('.tcard').forEach((c) => c.classList.toggle('sel', c.dataset.id === entry.id));
  drawKernel(viewP, LUT); drawGrowth(viewP); drawScatter(openedList(), entry.id);
}

function syncSliders() {
  $('mu').value = viewP.mu; $('muOut').textContent = viewP.mu.toFixed(4);
  $('sigma').value = viewP.sigma; $('sigmaOut').textContent = viewP.sigma.toFixed(4);
}
for (const key of ['mu', 'sigma']) {
  $(key).oninput = () => {
    if (!viewP) return;
    viewP[key] = +$(key).value;
    $(key + 'Out').textContent = viewP[key].toFixed(4);
    viewer.setTile(0, viewP, null);
    drawGrowth(viewP);
  };
}
$('speed').oninput = () => ($('speedOut').textContent = `${$('speed').value}×`);
$('speedOut').textContent = `${$('speed').value}×`;
$('playToggle').onclick = () => { playing = !playing; $('playToggle').textContent = playing ? '⏸' : '▶'; };
$('replaySeed').onclick = () => viewEntry && selectEntry(viewEntry, viewEntry.ref === 'orbium-auto' ? 'orbium' : 'seed');
$('spawnCrop').onclick = () => viewEntry && selectEntry(viewEntry, viewEntry.crop ? 'crop' : 'orbium');
const ORB_ENTRY = { id: 'orbium', ref: 'orbium-auto', name: 'Orbium (기준)', p: ORBIUM.p, cls: 'glider' };
$('loadOrbium').onclick = () => selectEntry({ ...ORB_ENTRY, ref: 'orbium' }, 'orbium');

function viewFrame() {
  if (viewer && viewP && playing) { const n = +$('speed').value; viewer.step(n); viewT += n; }
  viewer?.render();
  requestAnimationFrame(viewFrame);
}

// ---------- gallery UI ----------
const openedList = () => gallery.filter((g) => g.opened !== false);
const sealedList = () => gallery.filter((g) => g.opened === false).sort((a, b) => a.foundAt - b.foundAt);

function cardOpts(g, extra = {}) {
  const opened = openedList();
  const dexNo = opened.slice().sort((a, b) => a.foundAt - b.foundAt).findIndex((x) => x.id === g.id) + 1;
  const parent = g.parent && gallery.find((x) => x.id === g.parent);
  return {
    no: dexNo || opened.length + 1, total: Math.max(opened.length, dexNo), lut: LUT,
    parentName: parent ? creatureName(parent) : null,
    selected: viewEntry?.id === g.id,
    onSelect: (e) => viewInViewer(e),
    onDelete: (e) => { gallery = gallery.filter((x) => x.id !== e.id); saveGallery(); renderGallery(); },
    ...extra,
  };
}
function viewInViewer(e) {
  selectEntry(e, 'seed');
  $('view').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Rarity is relative: rank every creature by how far it is from all the others (leave-one-out
// kNN novelty), then top 5% = 전설, next 15% = 레어, next 30% = 언커먼, rest = 커먼. Recomputed
// on every change, so a card can drop a tier when look-alikes show up later.
function assignRarity() {
  const n = gallery.length;
  const vecs = gallery.map((g) => g.vec);
  const scored = gallery.map((g, i) => ({ g, s: n > 1 ? novelty(g.vec, vecs.filter((_, j) => j !== i)) : 1 }));
  scored.sort((a, b) => b.s - a.s);
  const legend = Math.max(1, Math.round(n * 0.05)), rare = legend + Math.round(n * 0.15), unc = rare + Math.round(n * 0.30);
  scored.forEach(({ g, s }, r) => {
    g.rarityScore = s;
    g.rarity = r < legend ? 'legend' : r < rare ? 'rare' : r < unc ? 'unc' : 'common';
    g.rarityRank = `${r + 1}/${n}`;
  });
}

function renderGallery() {
  assignRarity();
  const el = $('gallery');
  const sort = $('sortBy').value;
  const opened = openedList();
  const list = opened.slice().sort((a, b) =>
    sort === 'novel' ? b.rarityScore - a.rarityScore : sort === 'speed' ? b.features.speed - a.features.speed : b.foundAt - a.foundAt);
  const sealed = gallery.length - opened.length;
  $('galCount').textContent = `${opened.length}마리${sealed ? ` · 봉인 ${sealed}장` : ''}`;
  drawScatter(opened, viewEntry?.id);
  updateBar();
  if (!list.length) {
    el.innerHTML = `<div class="empty">${sealed ? '확장팩을 뜯으면 카드가 여기에 들어옵니다.' : '아직 비어 있습니다. 사냥이 돌면 움직이는 생물이 확장팩에 쌓입니다.'}</div>`;
    el.style.height = '';
    return;
  }
  el.innerHTML = '';
  for (const g of list) el.append(buildCard(g, cardOpts(g)));
  layoutFan();
}
$('sortBy').onchange = renderGallery;
$('clearBtn').onclick = () => { if (confirm('도감을 모두 비울까요?')) { gallery = []; saveGallery(); renderGallery(); } };
$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify({ format: 'lenia-hunt/1', N, gallery }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lenia-hunt-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('importFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const have = new Set(gallery.map((g) => g.id));
    for (const g of data.gallery ?? []) if (!have.has(g.id)) gallery.push(g);
    pruneGallery(); saveGallery(); renderGallery();
  } catch (err) { alert('가져오기 실패: ' + err.message); }
  e.target.value = '';
};

function fatal(e) {
  document.body.insertAdjacentHTML('afterbegin', `<div style="background:#5a1d24;padding:12px 20px">GPU 초기화 실패: ${e.message}. WebGL2 + EXT_color_buffer_float 가 필요합니다.</div>`);
  throw e;
}

// ---------- boot ----------
loadGallery();
renderGallery();
for (let k = 0; k < slots.length; k++) startSlot(k, null);
hunt.render({ grid: true });
renderStats();
initTable({
  opened: openedList, sealed: sealedList,
  makeCard: (e, extra = {}) => buildCard(e, cardOpts(e, { selected: false, ...extra })),
  view: (e) => viewInViewer(e),
  markOpened: (ids) => { for (const g of gallery) if (ids.includes(g.id)) g.opened = true; saveGallery(); renderGallery(); },
});
const lastOpened = openedList().sort((a, b) => a.foundAt - b.foundAt).pop();
if (lastOpened) selectEntry(lastOpened, 'seed');
else selectEntry(ORB_ENTRY, 'orbium');
window.addEventListener('resize', () => { drawKernel(viewP, LUT); drawGrowth(viewP); drawScatter(openedList(), viewEntry?.id); });
requestAnimationFrame(viewFrame);
setRunning(new URLSearchParams(location.search).get('autostart') !== '0');

// debugging / automated checks
window.lenia = { get gallery() { return gallery; }, counts, slots, hunt, viewer, get evaluated() { return evaluated; }, setRunning, selectEntry, measure, NOVELTY_MIN,
  // run n search batches synchronously (for a hidden/frozen browser pane)
  table: tableDebug,
  runBatches(n) { for (let i = 0; i < n; i++) huntBatch(); hunt.render({ grid: true }); renderStats(); return evaluated; } };
