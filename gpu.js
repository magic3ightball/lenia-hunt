// WebGL2 Lenia engine. The world is a T x T atlas of independent toroidal tiles,
// each with its own kernel and growth parameters, so one draw call steps many
// candidates at once (search) or a single world (viewer, T = 1).
import { kernelPatch } from './lenia-core.js';

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos * .5 + .5; gl_Position = vec4(aPos, 0., 1.); }`;

const STEP_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uA, uTaps, uP;
uniform int uTile, uT;
out vec4 o;
void main(){
  ivec2 g = ivec2(gl_FragCoord.xy);
  ivec2 ti = g / uTile, org = ti * uTile, loc = g - org;
  int mask = uTile - 1;                    // tile is a power of two
  vec4 P = texelFetch(uP, ti, 0);          // mu, sigma, dt, tap count
  float a = texelFetch(uA, g, 0).r;
  if (P.z == 0.) { o = vec4(a, 0., 0., 1.); return; }
  int n = int(P.w), row = ti.y * uT + ti.x;
  float u = 0.;
  for (int k = 0; k < n; k++) {
    vec3 tp = texelFetch(uTaps, ivec2(k, row), 0).xyz;   // dx, dy, weight
    ivec2 q = (loc + ivec2(tp.xy) + uTile) & mask;
    u += tp.z * texelFetch(uA, org + q, 0).r;
  }
  float d = (u - P.x) / P.y;
  a = clamp(a + P.z * (2. * exp(-.5 * d * d) - 1.), 0., 1.);
  o = vec4(a, 0., 0., 1.);
}`;

const SHOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uA; uniform float uTiles; uniform float uGrid;
in vec2 vUv; out vec4 o;
vec3 cmap(float t){
  // deep ink -> teal -> warm gold -> near white
  vec3 c0 = vec3(.03,.04,.08), c1 = vec3(.05,.33,.42), c2 = vec3(.35,.72,.58), c3 = vec3(.98,.82,.42), c4 = vec3(1.,.97,.9);
  t = clamp(t, 0., 1.);
  if (t < .25) return mix(c0, c1, t / .25);
  if (t < .5) return mix(c1, c2, (t - .25) / .25);
  if (t < .8) return mix(c2, c3, (t - .5) / .3);
  return mix(c3, c4, (t - .8) / .2);
}
void main(){
  float a = texture(uA, vUv).r;
  vec3 c = cmap(pow(a, .8));
  if (uGrid > 0.) {
    vec2 f = fract(vUv * uTiles);
    vec2 px = fwidth(vUv * uTiles);
    float line = max(step(f.x, px.x * 1.5), step(f.y, px.y * 1.5));
    c = mix(c, vec3(.2,.22,.3), line);
  }
  o = vec4(c, 1.);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export class LeniaGPU {
  constructor(canvas, { tile = 128, T = 1, rmax = 16 } = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
    this.gl = gl; this.canvas = canvas;
    this.tile = tile; this.T = T; this.W = tile * T; this.rmax = rmax; this.KD = 2 * rmax + 1;
    this.stepProg = compile(gl, VS, STEP_FS);
    this.showProg = compile(gl, VS, SHOW_FS);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const mk = (w, h, fmt, ifmt, type, filter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      return t;
    };
    // state: RGBA32F so readPixels(RGBA, FLOAT) is always legal
    this.tex = [0, 1].map(() => mk(this.W, this.W, gl.RGBA, gl.RGBA32F, gl.FLOAT, gl.NEAREST));
    this.fbo = this.tex.map((t) => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return f;
    });
    // per-tile sparse kernel: one row of (dx, dy, w) taps per tile, near-zero weights dropped
    this.maxTaps = this.KD * this.KD;
    this.tapTex = mk(this.maxTaps, T * T, gl.RGBA, gl.RGBA32F, gl.FLOAT, gl.NEAREST);
    this.pTex = mk(T, T, gl.RGBA, gl.RGBA32F, gl.FLOAT, gl.NEAREST);
    this.params = new Float32Array(T * T * 4);
    this.cur = 0;
    this.readBuf = new Float32Array(this.W * this.W * 4);
    this.U = (prog, n) => gl.getUniformLocation(prog, n);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Set tile k's parameters and initial state (Float32Array tile*tile). p = null pauses the tile.
  setTile(k, p, A) {
    const { gl, T, tile, KD, rmax } = this;
    const tx = k % T, ty = Math.floor(k / T);
    const taps = new Float32Array(this.maxTaps * 4);
    let n = 0;
    if (p) {
      if (p.R > rmax) throw new Error(`R ${p.R} > rmax ${rmax}`);
      const w = kernelPatch(p.R, p.beta), D = 2 * p.R + 1;
      let wmax = 0;
      for (const v of w) wmax = Math.max(wmax, v);
      for (let j = 0; j < D; j++)
        for (let i = 0; i < D; i++) {
          const v = w[j * D + i];
          if (v > wmax * 1e-4) { taps.set([i - p.R, j - p.R, v, 0], n * 4); n++; }
        }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tapTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, k, this.maxTaps, 1, gl.RGBA, gl.FLOAT, taps);
    this.params.set(p ? [p.mu, p.sigma, p.dt, n] : [0.15, 0.015, 0, 0], k * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.pTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, T, T, gl.RGBA, gl.FLOAT, this.params);
    if (A) {
      const rgba = new Float32Array(tile * tile * 4);
      for (let i = 0; i < tile * tile; i++) rgba[i * 4] = A[i];
      gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, tx * tile, ty * tile, tile, tile, gl.RGBA, gl.FLOAT, rgba);
    }
  }

  step(n = 1) {
    const { gl } = this;
    gl.useProgram(this.stepProg);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.W, this.W);
    gl.uniform1i(this.U(this.stepProg, 'uA'), 0);
    gl.uniform1i(this.U(this.stepProg, 'uTaps'), 1);
    gl.uniform1i(this.U(this.stepProg, 'uP'), 2);
    gl.uniform1i(this.U(this.stepProg, 'uTile'), this.tile);
    gl.uniform1i(this.U(this.stepProg, 'uT'), this.T);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tapTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.pTex);
    for (let s = 0; s < n; s++) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1 - this.cur]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.cur = 1 - this.cur;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Reads the whole atlas back (synchronous). Use tileView() to slice one tile.
  read() {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    gl.readPixels(0, 0, this.W, this.W, gl.RGBA, gl.FLOAT, this.readBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.readBuf;
  }
  tileView(k, out = new Float32Array(this.tile * this.tile)) {
    const { T, tile, W } = this, tx = k % T, ty = Math.floor(k / T), buf = this.readBuf;
    for (let y = 0; y < tile; y++) {
      const row = ((ty * tile + y) * W + tx * tile) * 4;
      for (let x = 0; x < tile; x++) out[y * tile + x] = buf[row + x * 4];
    }
    return out;
  }

  render({ grid = false } = {}) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.showProg);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.uniform1i(this.U(this.showProg, 'uA'), 0);
    gl.uniform1f(this.U(this.showProg, 'uTiles'), this.T);
    gl.uniform1f(this.U(this.showProg, 'uGrid'), grid ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
