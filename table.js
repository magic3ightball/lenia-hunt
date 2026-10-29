// Card-table effects on top of the gallery, animated with GSAP (+ Flip plugin, loaded from CDN):
//  - booster pack: new finds stay sealed until you tear a pack (drag across the top, or click),
//    cards come out face down, glow by rarity, flip one by one, then fly into the gallery
//  - deck: draw a random collected card, it flies out and flips face up, then goes back
//  - grid <-> fan: Flip animates the gallery between a grid and a hand-of-cards arc
import { rarity } from './cards.js';

const gsap = window.gsap, Flip = window.Flip;
if (gsap && Flip) gsap.registerPlugin(Flip);
if (gsap && matchMedia('(prefers-reduced-motion: reduce)').matches) gsap.globalTimeline.timeScale(4);

const PACK_SIZE = 5;
let api = null;               // callbacks from app.js
let stage, stageBg, stageFlash, stageHint, stageUi;
let busy = false, mode = 'pile';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html = '') => { const e = document.createElement(tag); e.className = cls; e.innerHTML = html; return e; };
const cardSize = () => { const w = Math.min(250, innerWidth * 0.62, (innerHeight - 140) * 63 / 88); return { CW: w, CH: w * 88 / 63 }; };
const BACK_HTML = '<div class="cback"><div class="cb-rings"></div><div class="cb-logo">LENIA<small>HUNT</small></div></div>';

export function initTable(callbacks) {
  api = callbacks;
  stage = el('div', 'stage', '<div class="stage-bg"></div><div class="stage-flash"></div><div class="stage-hint"></div><div class="stage-ui"></div>');
  document.body.append(stage);
  [stageBg, stageFlash, stageHint, stageUi] = ['.stage-bg', '.stage-flash', '.stage-hint', '.stage-ui'].map((s) => stage.querySelector(s));
  $('pilePrev').addEventListener('click', () => pileStep(-1));
  $('pileNext').addEventListener('click', () => pileStep(1));
  $('pileDraw').addEventListener('click', drawFromDeck);
  $('pileShuffle').addEventListener('click', pileShuffle);
  $('viewPile').addEventListener('click', () => setView('pile'));
  $('packBtn').addEventListener('click', openPack);
  $('viewGrid').addEventListener('click', () => setView('grid'));
  $('viewFan').addEventListener('click', () => setView('fan'));
  addEventListener('resize', layoutView);
  let saved = 'pile';
  try { saved = localStorage.getItem(VIEW_KEY) || 'pile'; } catch {}
  setView(saved, { animate: false });
  updateBar();
}

// ---------- bar (deck + pack + view toggle) ----------
export function updateBar() {
  if (!api) return;
  const sealed = api.sealed().length;
  const packs = Math.ceil(sealed / PACK_SIZE);
  const btn = $('packBtn');
  btn.hidden = !sealed;
  btn.querySelector('.pack-badge').textContent = packs > 1 ? `${packs}팩 · ${sealed}장` : `${sealed}장`;
  btn.classList.toggle('ready', sealed > 0);
  $('viewGrid').classList.toggle('on', mode === 'grid');
  $('viewFan').classList.toggle('on', mode === 'fan');
  $('viewPile').classList.toggle('on', mode === 'pile');
}

// ---------- stage helpers ----------
function showStage() {
  busy = true;
  document.documentElement.classList.add('stage-open');
  stage.classList.add('on');
  gsap.fromTo(stageBg, { opacity: 0 }, { opacity: 1, duration: 0.35 });
}
function hideStage() {
  return gsap.to(stageBg, {
    opacity: 0, duration: 0.3,
    onComplete: () => { document.documentElement.classList.remove('stage-open'); stage.classList.remove('on'); stage.querySelectorAll('.flipper, .pack').forEach((n) => n.remove()); stageUi.innerHTML = ''; hint(''); busy = false; },
  });
}
function hint(text) { stageHint.textContent = text; gsap.fromTo(stageHint, { opacity: 0, y: 6 }, { opacity: text ? 1 : 0, y: 0, duration: 0.3 }); }
function buttons(list) {
  stageUi.innerHTML = '';
  for (const [label, fn, primary] of list) {
    const b = el('button', primary ? 'primary' : '', label);
    b.onclick = (ev) => { ev.stopPropagation(); fn(); };
    stageUi.append(b);
  }
  gsap.from(stageUi.children, { opacity: 0, y: 10, duration: 0.3, stagger: 0.06 });
}

function makeFlipper(entry, { CW, CH }, onCardClick = () => {}) {
  const f = el('div', 'flipper', `<div class="face back">${BACK_HTML}</div><div class="face front"></div>`);
  f.style.width = `${CW}px`; f.style.height = `${CH}px`;
  f.querySelector('.front').append(api.makeCard(entry, { onSelect: onCardClick }));
  f.dataset.rar = rarity(entry).key;
  gsap.set(f, { rotationY: 180, transformPerspective: 1400, transformOrigin: '50% 50%' });
  stage.append(f);
  return f;
}

function flash(f) {
  const r = f.getBoundingClientRect();
  const gold = f.dataset.rar === 'legend';
  stageFlash.style.background = `radial-gradient(circle, ${gold ? '#ffe9a8' : '#e2c8ff'} 0%, ${gold ? '#f2b33d88' : '#9b5cff66'} 30%, transparent 65%)`;
  gsap.fromTo(stageFlash,
    { left: r.left + r.width / 2, top: r.top + r.height / 2, scale: 0.2, opacity: 1 },
    { scale: 3.2, opacity: 0, duration: 0.9, ease: 'power2.out' });
}

// Flip face up. Rare cards shake and charge before turning (TCG Pocket's light cue, Balatro's springy flip).
function reveal(f) {
  if (f.dataset.revealed) return Promise.resolve();
  f.dataset.revealed = '1';
  f.classList.remove('hoverable');
  const big = f.dataset.rar === 'rare' || f.dataset.rar === 'legend';
  const tl = gsap.timeline();
  if (big) {
    tl.to(f, { scale: '+=0.06', duration: 0.25, ease: 'power2.out' })
      .to(f, { x: '+=5', duration: 0.045, repeat: 9, yoyo: true, ease: 'none' }, '<');
  }
  tl.to(f, { rotationY: 0, rotation: `+=${(Math.random() - 0.5) * 5}`, duration: 0.65, ease: 'back.out(1.9)' });
  if (big) tl.add(() => flash(f), '-=0.5').to(f, { scale: '-=0.06', duration: 0.4, ease: 'power2.out' }, '-=0.3');
  return tl.then();
}

// ---------- deck draw ----------
function drawFromDeck() {
  if (busy || !gsap) return;
  const pool = api.opened();
  const deck = currentPileTop() ?? $('gallery');
  if (!pool.length) return;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  let back = () => {};
  const top = deck;
  const d = top.getBoundingClientRect();
  const size = cardSize(), { CW, CH } = size;
  showStage();
  const f = makeFlipper(entry, size, () => { back(); api.view(entry); });
  const s0 = d.width / CW;
  gsap.set(f, { x: d.left + d.width / 2 - CW / 2, y: d.top + d.height / 2 - CH / 2, scale: s0, rotation: -8 });
  const cx = innerWidth / 2 - CW / 2, cy = innerHeight / 2 - CH / 2 - 24;
  gsap.timeline()
    .to(f, { x: cx, y: cy, scale: 1.08, rotation: 0, duration: 0.55, ease: 'power3.out' })
    .add(() => reveal(f), '-=0.2');
  hint('덱에서 한 장 뽑았어요. 마우스를 올리면 살아 움직여요.');
  back = () => {
    const r = top.getBoundingClientRect();
    buttons([]);
    hint('');
    gsap.timeline()
      .to(f, { rotationY: 180, duration: 0.45, ease: 'power2.in' })
      .to(f, { x: r.left + r.width / 2 - CW / 2, y: r.top + r.height / 2 - CH / 2, scale: r.width / CW, rotation: -8, duration: 0.5, ease: 'power3.inOut' })
      .add(() => { hideStage(); });
  };
  stageBg.onclick = back;
  buttons([
    ['관찰창에서 보기', () => { back(); api.view(entry); }, true],
    ['덱에 돌려놓기', back],
  ]);
}

// ---------- booster pack ----------
async function openPack() {
  if (busy || !gsap) return;
  const list = api.sealed().slice(0, PACK_SIZE);
  if (!list.length) return;
  const size = cardSize(), { CW, CH } = size;
  showStage();
  stageBg.onclick = null;
  const PW = CW * 1.06, PH = CH * 1.08;
  const px = innerWidth / 2 - PW / 2, py = innerHeight / 2 - PH / 2 - 10;
  const rares = list.filter((e) => ['rare', 'legend'].includes(rarity(e).key)).length;
  const pack = el('div', 'pack', `
    <div class="pack-top"><div class="pack-cut"></div></div>
    <div class="pack-body">
      <div class="pack-art">${BACK_HTML}</div>
      <b>LENIA HUNT</b><span>사냥터 확장팩 · ${list.length}장</span>
    </div>`);
  pack.style.width = `${PW}px`; pack.style.height = `${PH}px`;
  stage.append(pack);
  gsap.set(pack, { x: px, y: py });
  gsap.from(pack, { y: -PH * 1.3, rotation: -14, duration: 0.8, ease: 'back.out(1.5)' });
  const idle = gsap.to(pack, { rotation: 1.4, duration: 1, yoyo: true, repeat: -1, ease: 'sine.inOut', delay: 0.8 });
  hint(rares ? '윗부분을 옆으로 그어 뜯어요 (눌러도 돼요) · 이 팩에서 빛이 새어 나와요…' : '윗부분을 옆으로 그어 뜯어요 (눌러도 돼요)');
  if (rares) gsap.to(pack, { boxShadow: '0 0 40px 6px #c89bffaa', duration: 0.9, yoyo: true, repeat: -1 });
  await tear(pack, PW);
  idle.kill();
  gsap.killTweensOf(pack, 'boxShadow');

  // strip flies off, cards slide up out of the pack, pack drops away
  const top = pack.querySelector('.pack-top');
  gsap.to(top, { x: PW * 0.9, y: -PH * 0.5, rotation: 38, opacity: 0, duration: 0.7, ease: 'power2.out' });
  const flippers = list.map((e) => makeFlipper(e, size));
  stage.append(pack); // keep the pack body in front while cards rise
  flippers.forEach((f, i) => gsap.set(f, { x: px + (PW - CW) / 2, y: py + PH - CH - 8 - i * 2, rotation: 0, zIndex: i })); // hidden inside the pack
  await gsap.to(flippers, { y: `-=${CH * 0.6}`, duration: 0.6, stagger: 0.05, ease: 'power2.out' }).then();
  await gsap.to(pack, { y: innerHeight + 40, rotation: 10, duration: 0.55, ease: 'power2.in' }).then();
  pack.remove();

  // spread face down in an arc; rarity glows on the backs (Hearthstone-style anticipation)
  const n = flippers.length, spread = Math.min(innerWidth - CW * 0.7 - 32, n * CW * 0.62);
  const sc = Math.min(1, (innerWidth - 32) / (spread + CW * 0.8)) * (innerWidth < 600 ? 0.7 : 0.82);
  flippers.forEach((f, i) => {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    gsap.to(f, {
      x: innerWidth / 2 - CW / 2 + t * spread, y: innerHeight / 2 - CH / 2 - 30 + Math.abs(t) * 40,
      rotation: t * 16, scale: sc, duration: 0.6, delay: i * 0.07, ease: 'back.out(1.4)',
    });
    f.classList.add('hoverable');
  });
  hint('카드를 눌러 한 장씩 뒤집어요 · 금빛은 전설, 보랏빛은 레어');
  let left = n;
  const done = () => {
    hint(`${n}장 모두 열었어요`);
    buttons([[`도감에 넣기 (${n}장)`, () => collect(list, flippers, size), true]]);
  };
  flippers.forEach((f) => f.addEventListener('click', async () => {
    if (f.dataset.revealed) return;
    gsap.to(f, { zIndex: 50 + (n - left) });
    await reveal(f);
    if (--left === 0) done();
  }));
  buttons([['한 번에 다 뒤집기', async () => {
    buttons([]);
    for (const f of flippers) if (!f.dataset.revealed) { reveal(f); left--; await new Promise((r) => setTimeout(r, 180)); }
    setTimeout(done, 700);
  }]]);
}

// Drag across the top strip to tear it (follows the pointer); a plain click also opens.
function tear(pack, PW) {
  return new Promise((resolve) => {
    const top = pack.querySelector('.pack-top');
    let x0 = null, p = 0, moved = false, done = false;
    const set = (v) => { p = v; top.style.setProperty('--tear', v); gsap.set(top, { rotation: -v * 7, y: -v * 6, transformOrigin: '0% 100%' }); };
    const finish = () => {
      if (done) return;
      done = true;
      pack.style.pointerEvents = 'none';
      gsap.to({ v: p }, { v: 1, duration: 0.18, onUpdate() { set(this.targets()[0].v); }, onComplete: resolve });
    };
    pack.addEventListener('pointerdown', (e) => { x0 = e.clientX; moved = false; try { pack.setPointerCapture(e.pointerId); } catch {} });
    pack.addEventListener('pointermove', (e) => {
      if (x0 === null || done) return;
      const v = Math.min(1, Math.abs(e.clientX - x0) / (PW * 0.8));
      if (v > 0.04) moved = true;
      set(v);
    });
    const release = () => {
      if (x0 === null || done) return;
      x0 = null;
      if (!moved || p > 0.45) finish();
      else gsap.to({ v: p }, { v: 0, duration: 0.25, onUpdate() { set(this.targets()[0].v); } });
    };
    pack.addEventListener('pointerup', release);
    pack.addEventListener('pointercancel', () => { x0 = null; });
    pack.addEventListener('click', () => { if (!moved) finish(); }); // plain click always opens
  });
}

async function collect(list, flippers, { CW }) {
  buttons([]);
  hint('');
  pileTopId = list[list.length - 1].id;
  api.markOpened(list.map((e) => e.id));         // re-renders the gallery with the new cards
  document.querySelector('.gallery-wrap').scrollIntoView({ block: 'start' });
  await new Promise((r) => requestAnimationFrame(r));
  const targets = list.map((e) => document.querySelector(`.tcard[data-id="${e.id}"]`));
  targets.forEach((t) => t && (t.style.visibility = 'hidden'));
  gsap.to(stageBg, { opacity: 0.25, duration: 0.5 });
  await Promise.all(flippers.map((f, i) => {
    const t = targets[i];
    if (!t) return gsap.to(f, { opacity: 0, duration: 0.3 }).then();
    const r = t.getBoundingClientRect();
    return gsap.to(f, {
      x: r.left + r.width / 2 - CW / 2, y: r.top + r.height / 2 - (CW * 88 / 63) / 2,
      scale: r.width / CW, rotation: 0, duration: 0.75, delay: i * 0.08, ease: 'power3.inOut',
    }).then(() => { t.style.visibility = ''; f.style.visibility = 'hidden'; gsap.fromTo(t, { y: -6 }, { y: 0, duration: 0.4, ease: 'back.out(3)', clearProps: 'transform' }); });
  }));
  await hideStage().then();
  updateBar();
  if (api.sealed().length) hint('');
}

// ---------- views: pile (stacked deck) / fan / grid, switched with GSAP Flip ----------
const VIEW_KEY = 'lenia-hunt-view';
let pileTopId = null;
const PILE_SHOW = 7; // cards visible in the stack below the top one

function hashAngle(id) { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0; return ((h % 1000) / 1000) * 7 - 3.5; }
const galleryCards = () => [...$('gallery').querySelectorAll('.tcard')];

function clearLaid(cards) {
  cards.forEach((c) => {
    c.style.left = c.style.top = c.style.width = c.style.zIndex = c.style.opacity = c.style.pointerEvents = '';
    gsap.set(c, { clearProps: 'transform' });
  });
}

export function setView(next, { animate = true } = {}) {
  const g = $('gallery');
  const cards = galleryCards();
  if (next === mode && animate) return;
  const state = animate && Flip ? Flip.getState(cards) : null;
  mode = next;
  try { localStorage.setItem(VIEW_KEY, mode); } catch {}
  g.classList.toggle('laid', mode !== 'grid');
  g.classList.toggle('fan', mode === 'fan');
  g.classList.toggle('pile', mode === 'pile');
  $('pileNav').hidden = mode !== 'pile';
  clearLaid(cards);
  g.style.height = '';
  layoutView();
  if (state) {
    g.classList.add('flipping');
    Flip.from(state, {
      duration: 0.8, ease: 'power3.inOut', stagger: { each: 0.015, from: mode === 'pile' ? 'end' : 'start' }, absolute: true,
      onComplete: () => g.classList.remove('flipping'),
    });
  }
  updateBar();
}

// Re-applies the current layout (after re-render, resize).
export function layoutView() {
  if (mode === 'fan') fanLayout();
  else if (mode === 'pile') layoutPile();
}
export const layoutFan = layoutView; // old name used by app.js

function fanLayout() {
  const g = $('gallery');
  const cards = galleryCards();
  const n = cards.length;
  if (!n) { g.style.height = ''; return; }
  const W = g.clientWidth;
  const cw = Math.min(200, W * 0.42), ch = cw * 88 / 63;
  const A = Math.min(64, Math.max(8, n * 5)) * Math.PI / 180;
  // keep the outermost (rotated) cards inside the panel
  const half = (cw * Math.cos(A / 2) + ch * Math.sin(A / 2)) / 2;
  const R = n === 1 ? 0 : Math.min(1800, Math.max(0, W - 2 * half - 8) / (2 * Math.sin(A / 2)));
  const pivotY = 70 + R + ch / 2;
  cards.forEach((c, i) => {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5, th = t * A;
    const x = W / 2 + R * Math.sin(th), y = pivotY - R * Math.cos(th);
    c.style.width = `${cw}px`;
    c.style.left = `${x - cw / 2}px`;
    c.style.top = `${y - ch / 2}px`;
    c.style.zIndex = i + 1;
    gsap.set(c, { x: 0, y: 0, rotation: th * 180 / Math.PI });
  });
  g.style.height = `${pivotY - R * Math.cos(A / 2) + ch * 0.75 + 30}px`;
}

function pileIndex(cards) {
  const i = cards.findIndex((c) => c.dataset.id === pileTopId);
  return i < 0 ? 0 : i;
}

// Stack the cards like a physical deck: top card face up, the next few peeking out behind it.
function layoutPile() {
  const g = $('gallery');
  const cards = galleryCards();
  const n = cards.length;
  if (!n) { g.style.height = ''; updatePileNav(0, 0); return; }
  const W = g.clientWidth;
  const cw = Math.min(260, W * 0.78), ch = cw * 88 / 63;
  const start = pileIndex(cards);
  pileTopId = cards[start].dataset.id;
  cards.forEach((c, i) => {
    const k = (i - start + n) % n; // depth in the stack, 0 = top
    const d = Math.min(k, PILE_SHOW);
    c.style.width = `${cw}px`;
    c.style.left = `${W / 2 - cw / 2 + d * 3.5}px`;
    c.style.top = `${24 + d * 3}px`;
    c.style.zIndex = n - k;
    c.style.opacity = k > PILE_SHOW ? '0' : '';
    c.style.pointerEvents = k === 0 ? '' : 'none';
    c.classList.toggle('pile-top', k === 0);
    gsap.set(c, { x: 0, y: 0, rotation: k === 0 ? 0 : hashAngle(c.dataset.id) });
  });
  g.style.height = `${ch + 24 + PILE_SHOW * 3 + 24}px`;
  updatePileNav(start + 1, n);
}

function updatePileNav(i, n) {
  $('pileCount').textContent = n ? `${i} / ${n}` : '0장';
  $('pilePrev').disabled = $('pileNext').disabled = $('pileDraw').disabled = n < 2;
}

let pileBusy = false;
// Top card slides off to the side and tucks under the deck (dir = 1), or the bottom card comes back on top (dir = -1).
function pileStep(dir) {
  const cards = galleryCards();
  const n = cards.length;
  if (mode !== 'pile' || n < 2 || pileBusy || !gsap) return;
  pileBusy = true;
  const start = pileIndex(cards);
  const top = cards[start], cw = top.offsetWidth;
  if (dir > 0) {
    gsap.timeline({ onComplete: () => { pileBusy = false; } })
      .to(top, { x: cw * 0.95, y: -20, rotation: 14, duration: 0.24, ease: 'power2.out' })
      .add(() => {
        const state = Flip.getState(cards);
        pileTopId = cards[(start + 1) % n].dataset.id;
        layoutPile();
        Flip.from(state, { duration: 0.4, ease: 'power2.inOut', absolute: false });
      });
  } else {
    const prev = cards[(start - 1 + n) % n];
    const state = Flip.getState(cards);
    pileTopId = prev.dataset.id;
    layoutPile();
    Flip.from(state, { duration: 0.35, ease: 'power2.inOut', targets: cards.filter((c) => c !== prev) });
    gsap.fromTo(prev, { x: -cw * 0.95, y: -20, rotation: -14 }, { x: 0, y: 0, rotation: 0, duration: 0.38, ease: 'back.out(1.4)', onComplete: () => { pileBusy = false; } });
  }
}

// Shuffle animation, then a random card ends up on top.
function pileShuffle() {
  const cards = galleryCards();
  const n = cards.length;
  if (mode !== 'pile' || n < 2 || pileBusy) return;
  pileBusy = true;
  const visible = cards.filter((c) => c.style.opacity !== '0');
  const tl = gsap.timeline({ onComplete: () => { pileBusy = false; } });
  visible.forEach((c, i) => {
    const side = i % 2 ? 1 : -1;
    tl.to(c, { x: side * c.offsetWidth * 0.55, rotation: side * 8, duration: 0.16, ease: 'power2.out' }, i * 0.025)
      .to(c, { x: 0, rotation: hashAngle(c.dataset.id), duration: 0.18, ease: 'power2.in' }, 0.2 + i * 0.025);
  });
  tl.add(() => {
    let j = Math.floor(Math.random() * (n - 1));
    if (j >= pileIndex(cards)) j++;
    const state = Flip.getState(cards);
    pileTopId = cards[j].dataset.id;
    layoutPile();
    Flip.from(state, { duration: 0.35, ease: 'power2.out' });
  });
}

export function setPileTop(id) { pileTopId = id; }
export function currentPileTop() { return mode === 'pile' ? galleryCards()[pileIndex(galleryCards())] : null; }

export const tableDebug = { openPack, drawFromDeck, setView, pileStep, pileShuffle, get mode() { return mode; } };
