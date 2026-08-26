// src/terrain/voxelNoise.ts
var Gx = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
var Gy = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
var Gz = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
function fastFloor(f) {
  return f >= 0 ? Math.trunc(f) : Math.trunc(f) - 1;
}
function quintic(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function quinticDeriv(t) {
  return 30 * t * t * (t - 1) * (t - 1);
}
function lerp(a, b, t) {
  return a + t * (b - a);
}
var MT19937 = class {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.i = 624;
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      this.mt[i] = Math.imul(1812433253, this.mt[i - 1] ^ this.mt[i - 1] >>> 30) + i >>> 0;
    }
  }
  twist() {
    for (let i = 0; i < 624; i++) {
      const y = this.mt[i] & 2147483648 | this.mt[(i + 1) % 624] & 2147483647;
      this.mt[i] = (this.mt[(i + 397) % 624] ^ y >>> 1 ^ (y & 1 ? 2567483615 : 0)) >>> 0;
    }
    this.i = 0;
  }
  next() {
    if (this.i >= 624) this.twist();
    let y = this.mt[this.i++];
    y ^= y >>> 11;
    y ^= y << 7 & 2636928640;
    y ^= y << 15 & 4022730752;
    y ^= y >>> 18;
    return y >>> 0;
  }
  /**
   * 均匀整数 [0, n]（拒绝采样）——镜像 std::uniform_int_distribution 的语义。
   * 关键：拒绝上限 lim 的计算方式必须逐位一致，否则置换表与 VoxelPlugin 不同。
   */
  uniform(n2) {
    const range = n2 + 1;
    const lim = 4294967296 - 4294967296 % range;
    let r;
    do {
      r = this.next();
    } while (r >= lim);
    return r % range;
  }
};
function buildPerm(seed) {
  const gen = new MT19937(seed | 0);
  const p = new Uint16Array(512);
  const p12 = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let j = 0; j < 256; j++) {
    const k = j + gen.uniform(256 - j);
    const l = p[j];
    p[j] = p[j + 256] = p[k];
    p[k] = l;
    p12[j] = p12[j + 256] = p[j] % 12;
  }
  return { p, p12 };
}
var VoxelNoise = class {
  constructor(seed) {
    this.gain = 0.5;
    this.lac = 2;
    this.fracBound = 1;
    this.seed = seed | 0;
    this.P = buildPerm(this.seed);
    this.setOct(7);
  }
  setOct(o) {
    let a = 1;
    let amp = 0.5;
    for (let i = 1; i < o; i++) {
      a += amp;
      amp *= this.gain;
    }
    this.fracBound = 1 / a;
  }
  /** 置换偏移 p[i]（每 octave 的采样偏移，FBM/IQ/Erosion 用它去相关） */
  pOffset(i) {
    return this.P.p[i & 255];
  }
  /** 2D 梯度索引：off 为置换偏移（每 octave 不同，实现去相关） */
  idx2(off, x, y) {
    const p = this.P.p;
    const p12 = this.P.p12;
    return p12[(x & 255) + p[(y & 255) + off] & 511];
  }
  /** 3D 梯度索引（嵌套置换，与 FastNoise Grad3 索引链一致） */
  idx3(off, x, y, z) {
    const p = this.P.p;
    const p12 = this.P.p12;
    return p12[(x & 255) + p[(y & 255) + p[(z & 255) + off]] & 511];
  }
  grad2(off, x, y, dx, dy) {
    const q = this.idx2(off, x, y);
    return dx * Gx[q] + dy * Gy[q];
  }
  /** grad2 + 返回梯度基向量（供解析导数计算） */
  grad2v(off, x, y, dx, dy) {
    const q = this.idx2(off, x, y);
    return [dx * Gx[q] + dy * Gy[q], Gx[q], Gy[q]];
  }
  grad3(off, x, y, z, dx, dy, dz) {
    const q = this.idx3(off, x, y, z);
    return dx * Gx[q] + dy * Gy[q] + dz * Gz[q];
  }
  /**
   * 2D Perlin（Quintic 插值）。deriv=true 时返回 [value, dD/dx, dD/dy]。
   * 数值锚点：整数格点处 value=0；输出约 [-1, 1]。
   */
  perlin2(x, y, off = 0, deriv = false) {
    const x0 = fastFloor(x);
    const y0 = fastFloor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = x - x0;
    const fy = y - y0;
    const xs = quintic(fx);
    const ys = quintic(fy);
    const a = this.grad2v(off, x0, y0, fx, fy);
    const b = this.grad2v(off, x1, y0, fx - 1, fy);
    const c = this.grad2v(off, x0, y1, fx, fy - 1);
    const d = this.grad2v(off, x1, y1, fx - 1, fy - 1);
    const va = a[0];
    const vb = b[0];
    const vc = c[0];
    const vd = d[0];
    const val = va + xs * (vb - va) + ys * (vc - va) + xs * ys * (va - vb - vc + vd);
    if (!deriv) return val;
    const dxI = quinticDeriv(fx);
    const dyI = quinticDeriv(fy);
    const dx = a[1] + xs * (b[1] - a[1]) + ys * (c[1] - a[1]) + xs * ys * (a[1] - b[1] - c[1] + d[1]) + dxI * (ys * (va - vb - vc + vd) + vb - va);
    const dy = a[2] + xs * (b[2] - a[2]) + ys * (c[2] - a[2]) + xs * ys * (a[2] - b[2] - c[2] + d[2]) + dyI * (xs * (va - vb - vc + vd) + vc - va);
    return [val, dx, dy];
  }
  /** 3D Perlin（Quintic 插值），Ravines 等体积示例使用 */
  perlin3(x, y, z, off = 0) {
    const x0 = fastFloor(x);
    const y0 = fastFloor(y);
    const z0 = fastFloor(z);
    const fx = x - x0;
    const fy = y - y0;
    const fz = z - z0;
    const xs = quintic(fx);
    const ys = quintic(fy);
    const zs = quintic(fz);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const z1 = z0 + 1;
    const a = lerp(this.grad3(off, x0, y0, z0, fx, fy, fz), this.grad3(off, x1, y0, z0, fx - 1, fy, fz), xs);
    const b = lerp(this.grad3(off, x0, y1, z0, fx, fy - 1, fz), this.grad3(off, x1, y1, z0, fx - 1, fy - 1, fz), xs);
    const c = lerp(this.grad3(off, x0, y0, z1, fx, fy, fz - 1), this.grad3(off, x1, y0, z1, fx - 1, fy, fz - 1), xs);
    const d = lerp(this.grad3(off, x0, y1, z1, fx, fy - 1, fz - 1), this.grad3(off, x1, y1, z1, fx - 1, fy - 1, fz - 1), xs);
    return lerp(lerp(a, b, ys), lerp(c, d, ys), zs);
  }
  /**
   * 2D FBM（分形布朗运动）。freq 在函数内部先乘到坐标上。
   * FractalBounding：Σamp 归一化，使输出有界（约 [-1, 1]）。
   * 每 octave 用置换偏移 p[i] 采样（去相关）。
   */
  fbm2(x, y, freq, oct) {
    x *= freq;
    y *= freq;
    let sum = this.perlin2(x, y, this.P.p[0]);
    let amp = 1;
    for (let i = 1; i < oct; i++) {
      x *= this.lac;
      y *= this.lac;
      amp *= this.gain;
      sum += this.perlin2(x, y, this.P.p[i]) * amp;
    }
    return sum * this.fracBound;
  }
  /** 带导数的 FBM（Erosion 示例的谷底屏蔽需要梯度） */
  fbm2d(x, y, freq, oct) {
    x *= freq;
    y *= freq;
    const s0 = this.perlin2(x, y, this.P.p[0], true);
    let sum = s0[0];
    let amp = 1;
    let dx = s0[1];
    let dy = s0[2];
    for (let i = 1; i < oct; i++) {
      x *= this.lac;
      y *= this.lac;
      amp *= this.gain;
      const v = this.perlin2(x, y, this.P.p[i], true);
      sum += v[0] * amp;
      dx += v[1] * amp;
      dy += v[2] * amp;
    }
    return [sum * this.fracBound, dx * this.fracBound, dy * this.fracBound];
  }
  /**
   * IQNoise（Inigo Quilez 式）：旋转域 + 导数加权。
   * 每 octave：w = amp / (1 + |∇n|²)（梯度大处权重低 → 脊线锐化），
   * 域旋转 40°（0.6981317008 rad）后倍频。VoxelPlugin 的 IQNoise 同构。
   * 数值锚点：输出约 [-1, 1]，含 ×fracBound 归一化。
   */
  iq2(x, y, freq, oct) {
    let xx = x * freq;
    let yy = y * freq;
    let sum = 0;
    let amp = 1;
    const ang = 0.6981317008;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let i = 0; i < oct; i++) {
      const n2 = this.perlin2(xx, yy, this.P.p[i], true);
      const w = amp / (1 + n2[1] * n2[1] + n2[2] * n2[2]);
      sum += n2[0] * w;
      const rx = c * xx - s * yy;
      const ry = s * xx + c * yy;
      xx = rx * 2;
      yy = ry * 2;
      amp *= 0.5;
    }
    return sum * this.fracBound;
  }
};

// _cliffs_diag3.ts
var n = new VoxelNoise(1337);
console.log("=== perlin2 \u8F93\u51FA\u8303\u56F4\u6D4B\u8BD5 ===");
var mn = 1e9;
var mx = -1e9;
var offs = [n.pOffset(0), n.pOffset(1), n.pOffset(2)];
for (let i = 0; i < 200; i++) {
  const x = -200 + i * 2;
  for (let j = 0; j < 20; j++) {
    const y = -200 + j * 20;
    const v = n.perlin2(x * 0.1, y * 0.1, n.pOffset(1));
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
}
console.log(`perlin2(x*0.1, y*0.1, pOffset(1)): min=${mn.toFixed(4)} max=${mx.toFixed(4)}`);
console.log(`pOffset(0..2) = ${offs.join(", ")}`);
var mn2 = 1e9;
var mx2 = -1e9;
for (let i = 0; i < 100; i++) {
  const x = -200 + i * 4;
  const v = n.iq2(x, 0, 0.01, 15);
  if (v < mn2) mn2 = v;
  if (v > mx2) mx2 = v;
}
console.log(`iq2(x,0,0.01,15) * 25: min=${(mn2 * 25).toFixed(1)} max=${(mx2 * 25).toFixed(1)}`);
var mn3 = 1e9;
var mx3 = -1e9;
for (let i = 0; i < 100; i++) {
  const x = -200 + i * 4;
  const v = n.fbm2(x, 0, 5e-3, 3);
  if (v < mn3) mn3 = v;
  if (v > mx3) mx3 = v;
}
console.log(`fbm2(x,0,0.005,3): min=${mn3.toFixed(4)} max=${mx3.toFixed(4)}`);
console.log("\n=== perlin2 \u7CBE\u786E\u62BD\u6837 ===");
for (const x of [-15, -10, -5, 0, 5, 10, 15]) {
  const v = n.perlin2(x, 0, n.pOffset(1));
  const v0 = n.perlin2(x, 0, n.pOffset(0));
  console.log(`x=${x} pOffset(1) -> ${v.toFixed(4)} | pOffset(0) -> ${v0.toFixed(4)}`);
}
