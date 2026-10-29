// Trading-card style gallery: every saved creature gets a name, HP, type, two "moves"
// and a rarity, all derived from its measured features. Hovering a card brings the
// creature to life inside the art window (small CPU sim that follows it around).
import { LeniaCPU, measure, b64decode } from './lenia-core.js';

const TYPES = {
  glider: { ko: '활공', glyph: '➤', cls: 'glide' },
  'pulsing-mover': { ko: '맥동', glyph: '✺', cls: 'pulse' },
  oscillator: { ko: '고동', glyph: '◉', cls: 'osc' },
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const PRE = ['Or', 'Ve', 'Lu', 'Ca', 'Sy', 'Pte', 'Gy', 'Ar', 'Ne', 'Ku', 'Ta', 'Ro', 'Phi', 'Sa', 'Hex', 'Mo', 'Pyr', 'Ze'];
const MID = ['bi', 'lo', 'ri', 'ne', 'ta', 'mu', 'so', 'ra', 'li', 'cy', 'do', 've'];
const SUF = { glider: ['um', 'ium', 'ix', 'ax'], 'pulsing-mover': ['ora', 'enta', 'is', 'ura'], oscillator: ['ula', 'ella', 'on', 'oma'] };

// Latin-ish species name in the spirit of Chan's "Orbium", stable per creature id.
export function creatureName(e) {
  if (e.name) return e.name;
  const h = hash(e.id);
  const suf = SUF[e.cls] ?? ['um'];
  const mids = 1 + (h >>> 20) % 2;
  let s = PRE[h % PRE.length];
  for (let i = 0; i < mids; i++) s += MID[(h >>> (5 + i * 6)) % MID.length];
  return s + suf[(h >>> 14) % suf.length];
}

const r10 = (v, lo = 10, hi = 300) => Math.max(lo, Math.min(hi, Math.round(v / 10) * 10));

export const RARITY = {
  common: { key: 'common', label: '커먼', sym: '●' },
  unc: { key: 'unc', label: '언커먼', sym: '◆' },
  rare: { key: 'rare', label: '레어', sym: '★' },
  legend: { key: 'legend', label: '전설', sym: '✦' },
};
// Tier is assigned by app.js from the creature's novelty rank within the whole collection (e.rarity).
export function rarity(e) {
  return RARITY[e.rarity] ?? RARITY.common;
}

function moves(e) {
  const f = e.features, B = e.p.beta.length;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const first = {
    glider: { name: '직선 활공', cost: 1, dmg: r10(f.speed * 220), text: `몸을 흐트러뜨리지 않고 ${f.speed.toFixed(2)}R/시간으로 미끄러진다. 직진성 ${f.straight.toFixed(2)}.` },
    'pulsing-mover': { name: '맥동 돌진', cost: 1, dmg: r10(f.speed * 160 + f.massCV * 600), text: `질량이 ${pct(f.massCV)}씩 부풀었다 줄며 ${f.speed.toFixed(2)}R/시간으로 나아간다.` },
    oscillator: { name: '숨고르기', cost: 1, dmg: r10(f.massCV * 1200), text: `제자리에서 질량이 ${pct(f.massCV)}만큼 오르내린다. 형태 변동 ${f.shapeVar.toFixed(3)}.` },
  }[e.cls];
  const second = {
    name: B === 1 ? '외고리 공명' : `${B}겹 고리 공명`, cost: B,
    dmg: r10(e.p.R * 6 + f.elong * 60 + f.shapeVar * 400, 20),
    text: `반경 R=${e.p.R}, 고리 높이 [${e.p.beta.join(', ')}]의 커널로 이웃을 끌어당긴다.`,
  };
  return [first, second];
}

function flavor(e) {
  const f = e.features;
  const shape = f.elong > 0.45 ? '길쭉한' : f.elong > 0.2 ? '살짝 찌그러진' : '동그란';
  const size = f.massR2 > 1.2 ? '큰' : f.massR2 > 0.6 ? '보통 크기의' : '작은';
  const how = e.cls === 'glider' ? '한 방향으로 끝없이 떠돈다'
    : e.cls === 'pulsing-mover' ? '숨 쉬듯 박동하며 자리를 옮긴다'
    : '한자리에서 심장처럼 뛴다';
  const hint = f.speed > 0.3 ? ' 사냥터에서 가장 빠른 축에 든다.' : f.massCV > 0.05 ? ' 박동이 눈에 띄게 크다.' : '';
  return `${size} ${shape} 몸으로 ${how}.${hint}`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Draw a crop (S×S, 8-bit) into a canvas through the colormap LUT.
export function paintCrop(canvas, data, S, lut) {
  if (canvas.width !== S) { canvas.width = S; canvas.height = S; }
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const v = data[(S - 1 - y) * S + x], o = (y * S + x) * 4; // flip: GL row 0 is the bottom
      img.data[o] = lut[v * 3]; img.data[o + 1] = lut[v * 3 + 1]; img.data[o + 2] = lut[v * 3 + 2]; img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
}

export function buildCard(e, { no, total, lut, parentName, selected, onSelect, onDelete }) {
  const t = TYPES[e.cls] ?? TYPES.oscillator;
  const f = e.features;
  const rar = rarity(e);
  const [m1, m2] = moves(e);
  const name = creatureName(e);
  const hp = r10(f.massR2 * 120, 30, 300);
  const dot = `<i class="en ${t.cls}">${t.glyph}</i>`;
  const card = document.createElement('div');
  card.className = `tcard ${t.cls} r-${rar.key}${selected ? ' sel' : ''}`;
  card.dataset.id = e.id;
  card.innerHTML = `
    <div class="tc-inner">
      <div class="tc-top">
        <span class="tc-stage">${parentName ? '1진화' : '기본'}</span>
        <span class="tc-name">${esc(name)}</span>
        <span class="tc-hp"><small>HP</small>${hp}</span>
        ${dot}
      </div>
      ${parentName ? `<div class="tc-evo">${esc(parentName)}에서 변이</div>` : ''}
      <div class="tc-art"><canvas></canvas><div class="tc-holo"></div></div>
      <div class="tc-strip">No.${String(no).padStart(3, '0')} · ${t.ko} 타입 렌야 · 질량 ${f.massR2.toFixed(2)}R² · 퍼짐 ${f.spread.toFixed(2)}R</div>
      <div class="tc-moves">
        ${[m1, m2].map((m) => `
          <div class="tc-move">
            <span class="tc-cost">${dot.repeat(m.cost)}</span>
            <span class="tc-mname">${m.name}</span>
            <span class="tc-dmg">${m.dmg}</span>
            <p>${m.text}</p>
          </div>`).join('')}
      </div>
      <div class="tc-stats">
        <div><small>성장 중심 μ</small>${e.p.mu}</div>
        <div><small>성장 폭 σ</small>${e.p.sigma}</div>
        <div><small>반경 R</small>${e.p.R}</div>
      </div>
      <p class="tc-flavor">${flavor(e)}</p>
      <div class="tc-foot">
        <span>seed ${e.seed}</span>
        <span class="tc-rar" title="도감 안 새로움 순위 ${e.rarityRank ?? '?'}">${no}/${total} ${rar.sym} ${rar.label}</span>
      </div>
    </div>
    <div class="tc-glare"></div>
    <div class="tc-badge" title="${rar.label} · 도감 안 새로움 ${e.rarityRank ?? '?'}위">${rar.sym}</div>
    <button class="tc-del" title="도감에서 삭제">×</button>`;

  const art = card.querySelector('.tc-art canvas');
  const data = b64decode(e.crop.b64);
  paintCrop(art, data, e.crop.S, lut);

  // pointer-driven tilt + light position (CSS variables)
  card.addEventListener('pointermove', (ev) => {
    const r = card.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width, py = (ev.clientY - r.top) / r.height;
    card.style.setProperty('--mx', `${px * 100}%`);
    card.style.setProperty('--my', `${py * 100}%`);
    card.style.setProperty('--rx', `${(0.5 - py) * 14}deg`);
    card.style.setProperty('--ry', `${(px - 0.5) * 18}deg`);
    card.style.setProperty('--pos', `${px * 100}% ${py * 100}%`);
  });
  card.addEventListener('pointerenter', () => { card.classList.add('live'); animate.start(e, art, data, lut); });
  card.addEventListener('pointerleave', () => {
    card.classList.remove('live');
    card.style.removeProperty('--rx'); card.style.removeProperty('--ry');
    animate.stop();
    paintCrop(art, data, e.crop.S, lut);
  });
  card.addEventListener('click', (ev) => {
    if (ev.target.closest('.tc-del')) { ev.stopPropagation(); onDelete(e); return; }
    onSelect(e);
  });
  return card;
}

// One live card at a time: CPU Lenia on a 128 torus seeded with the saved final form;
// the art window follows the creature's centroid so gliders stay in frame.
const animate = {
  sim: null, raf: 0, frame: null,
  start(e, canvas, data, lut) {
    this.stop();
    const N = 128, S = e.crop.S;
    const sim = new LeniaCPU(N, e.p);
    const o = (N - S) >> 1;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) sim.A[(y + o) * N + x + o] = data[y * S + x] / 255;
    this.sim = sim;
    const win = new Uint8Array(S * S);
    const tick = () => {
      if (this.sim !== sim) return;
      sim.step(); sim.step();
      const m = measure(sim.A, N);
      if (m.mass < 0.5) return;
      const x0 = Math.round(m.cx) - (S >> 1), y0 = Math.round(m.cy) - (S >> 1);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++)
          win[y * S + x] = Math.round(sim.A[((y0 + y + N * 4) % N) * N + ((x0 + x + N * 4) % N)] * 255);
      paintCrop(canvas, win, S, lut);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  stop() { cancelAnimationFrame(this.raf); this.sim = null; },
};
