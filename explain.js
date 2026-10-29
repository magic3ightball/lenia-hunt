// Live figures for the "how it works" section: kernel, growth curve, gallery scatter.
import { kernelPatch } from './lenia-core.js';

const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function fitCanvas(cv) {
  // keep the drawing sharp at whatever width CSS gives the canvas
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round((r.width || cv.width) * dpr));
  const h = Math.round(w * (cv.dataset.aspect ? +cv.dataset.aspect : cv.height / cv.width));
  if (!cv.dataset.aspect) cv.dataset.aspect = cv.height / cv.width;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { ctx: cv.getContext('2d'), w, h, s: dpr };
}

export function drawKernel(p, lut) {
  const cv = $('exKernel');
  if (!cv || !p) return;
  const D = 2 * p.R + 1, w = kernelPatch(p.R, p.beta);
  let max = 0;
  for (const v of w) max = Math.max(max, v);
  const off = document.createElement('canvas');
  off.width = D; off.height = D;
  const octx = off.getContext('2d'), img = octx.createImageData(D, D);
  for (let i = 0; i < D * D; i++) {
    const v = Math.round((w[i] / max) * 255);
    img.data.set([lut[v * 3], lut[v * 3 + 1], lut[v * 3 + 2], 255], i * 4);
  }
  octx.putImageData(img, 0, 0);
  const { ctx, w: W, h: H } = fitCanvas(cv);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#090c15'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(off, 0, 0, W, H);
  $('exKernelCap').textContent = `R=${p.R}, 고리 높이 β=[${p.beta.join(', ')}]`;
}

export function drawGrowth(p) {
  const cv = $('exGrowth');
  if (!cv || !p) return;
  const { ctx, w: W, h: H, s } = fitCanvas(cv);
  const padL = 26 * s, padR = 10 * s, top = 22 * s, bot = 18 * s;
  const umax = Math.min(1, Math.max(0.3, p.mu * 2.2));
  const X = (u) => padL + (u / umax) * (W - padL - padR);
  const Y = (g) => top + ((1 - g) / 2) * (H - top - bot);
  ctx.fillStyle = '#090c15'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = css('--line2'); ctx.lineWidth = s;
  ctx.beginPath();
  ctx.moveTo(padL, Y(0)); ctx.lineTo(W - padR, Y(0));
  ctx.moveTo(padL, Y(1)); ctx.lineTo(padL, Y(-1));
  ctx.stroke();
  // ±sigma band around mu
  ctx.fillStyle = 'rgba(79,183,160,.18)';
  ctx.fillRect(X(p.mu - p.sigma), Y(1), X(p.mu + p.sigma) - X(p.mu - p.sigma), Y(-1) - Y(1));
  ctx.strokeStyle = css('--teal'); ctx.lineWidth = 2 * s;
  ctx.beginPath();
  for (let i = 0; i <= 400; i++) {
    const u = (i / 400) * umax, d = (u - p.mu) / p.sigma, g = 2 * Math.exp(-0.5 * d * d) - 1;
    i ? ctx.lineTo(X(u), Y(g)) : ctx.moveTo(X(u), Y(g));
  }
  ctx.stroke();
  ctx.font = `${10 * s}px system-ui`;
  ctx.fillStyle = css('--dim');
  ctx.textAlign = 'right';
  ctx.fillText('+1', padL - 4 * s, Y(1) + 4 * s);
  ctx.fillText('0', padL - 4 * s, Y(0) + 4 * s);
  ctx.fillText('−1', padL - 4 * s, Y(-1) + 4 * s);
  ctx.fillText('이웃 평균 u →', W - padR, H - 4 * s);
  ctx.textAlign = 'left';
  ctx.fillText('자람', padL + 4 * s, Y(1) + 10 * s);
  ctx.fillText('줄어듦', padL + 4 * s, Y(-1) - 4 * s);
  ctx.fillStyle = css('--accent');
  ctx.textAlign = 'right';
  ctx.fillText(`μ = ${p.mu}   σ = ${p.sigma}`, W - padR, 13 * s);
  ctx.textAlign = 'left';
}

export function drawScatter(gallery, selId) {
  const cv = $('exScatter');
  if (!cv) return;
  const { ctx, w: W, h: H, s } = fitCanvas(cv);
  ctx.fillStyle = '#090c15'; ctx.fillRect(0, 0, W, H);
  const pad = 30 * s;
  // square-root axes spread the crowd of slow, steady creatures near the origin
  const sx = (v) => pad + Math.sqrt(Math.min(1, Math.max(0, v) / 0.6)) * (W - pad * 1.4);
  const sy = (v) => H - pad - Math.sqrt(Math.min(1, Math.max(0, v) / 0.25)) * (H - pad * 1.6);
  ctx.strokeStyle = css('--line2'); ctx.lineWidth = s;
  ctx.beginPath(); ctx.moveTo(pad, 8 * s); ctx.lineTo(pad, H - pad); ctx.lineTo(W - 6 * s, H - pad); ctx.stroke();
  ctx.fillStyle = css('--dim'); ctx.font = `${10 * s}px system-ui`;
  ctx.textAlign = 'right';
  ctx.fillText('속도 (R / 시간, √축) →', W - 6 * s, H - pad + 16 * s);
  ctx.textAlign = 'left';
  ctx.fillText('↑ 질량 변동 (√축)', pad + 4 * s, 14 * s);
  if (!gallery.length) { ctx.fillText('도감이 비어 있습니다', W / 2 - 40 * s, H / 2); return; }
  for (const g of gallery) {
    const x = sx(g.features.speed), y = sy(g.features.massCV);
    const r = (3 + Math.min(6, (g.novelty >= 9.99 ? 2 : g.novelty) * 2.5)) * s;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = css(`--${g.cls}`); ctx.globalAlpha = 0.75; ctx.fill(); ctx.globalAlpha = 1;
    if (g.id === selId) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * s; ctx.stroke(); }
  }
  ctx.fillStyle = css('--dim');
  ctx.textAlign = 'right';
  ctx.fillText('점 크기 = 저장 당시 새로움', W - 6 * s, 14 * s);
  ctx.textAlign = 'left';
}
