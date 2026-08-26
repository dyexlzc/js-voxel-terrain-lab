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
  fbm2(x, y, freq2, oct) {
    x *= freq2;
    y *= freq2;
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
  fbm2d(x, y, freq2, oct) {
    x *= freq2;
    y *= freq2;
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
  iq2(x, y, freq2, oct) {
    let xx = x * freq2;
    let yy = y * freq2;
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

// src/terrain/voxelExamples.ts
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function cliffsHeight(n2, x, y, z, freq2) {
  const f = freq2;
  const sides = n2.perlin2(x * 0.1 * f, y * 0.1 * f, n2.pOffset(1));
  const p = clamp((z / 50 + 0.2 * sides) * 10, 0, 1);
  const top = n2.iq2(x, y, 0.01 * f, 15) * 25;
  return 50 * p + top * p;
}
function cliffsDensity(n2, x, y, z, freq2) {
  return z - cliffsHeight(n2, x, y, z, freq2);
}
var MODE_SPECS = [
  {
    id: "cliffs",
    n: 1,
    short: "Cliffs",
    title: "1 \xB7 VoxelExample_Cliffs\uFF08\u53F0\u5730\u60AC\u5D16\uFF09",
    zRange: [-15, 90],
    isVolumetric: false,
    formula: `sides = Perlin2(X\xB70.1\xB7f, Y\xB70.1\xB7f, off=1)
p     = clamp((Z/50 + 0.2\xB7sides)\xB710, 0, 1)  \u2190 \u663E\u5F0F\u4F9D\u8D56 Z
top   = IQ2(X, Y, 0.01\xB7f, 15)\xB725
h     = p\xB7(50 + top)                (h \u4F9D\u8D56 Z\uFF1A3D \u81EA\u6307\u578B SDF)
value = Z - h  (Z<h \u4E3A\u5B9E\u4F53)
\xB7 sides > 0.5: p\u22611\uFF0Ch\u226150+top\uFF0C\u5E73\u53F0\u9876\u9762 z=50+top
\xB7 sides < 0:   p=z/5+2sides \u7EBF\u6027\uFF0C0\u21921 \u5728 z\u2208[-10sides, 50-10sides]
  \u5F62\u6210 z=0 \u4E0E z=50+top \u4E24\u4E2A\u7B49\u503C\u9762 + \u4E2D\u95F4\u5B9E\u4F53\uFF08=\u5D16\u4F53\uFF09
\xB7 0<sides<0.5: \u8FC7\u6E21\u533A\uFF0Cp \u5728 z=50(0.5-sides) \u5904\u5C01 1\uFF0C\u5168\u7A0B solid
marching \u627E\u5230 2 \u4E2A\u96F6\u4EA4\u53C9 = \u9636\u68AF\u9876\u9762 + \u9636\u68AF\u4FA7\u9762\uFF08=\u5D16\u58C1\uFF09`
  },
  {
    id: "dunes",
    n: 2,
    short: "Dunes",
    title: "2 \xB7 VG_Example_Dunes\uFF08\u6C99\u4E18\uFF09",
    zRange: [-180, 40],
    isVolumetric: false,
    needsDunes: true,
    formula: `phase = FBM2(X, Y, 0.001\xB7f, 3) + 0.002\xB7(X\xB7dx + Y\xB7dy)\xB7f
h     = -75\xB7|sin(\u03C0\xB7phase)|
value = Z - h  (\u8584\u58F3 SDF\uFF0CZ<h \u4E3A\u5B9E\u4F53)
\u98CE\u5411 (dx, dy) \u51B3\u5B9A\u6C99\u4E18\u810A\u7EBF\u65B9\u5411`
  },
  {
    id: "cave",
    n: 3,
    short: "Cave",
    title: "3 \xB7 VoxelExample_Cave\uFF08\u6D1E\u7A74\uFF09",
    zRange: [-320, 520],
    isVolumetric: true,
    formula: `top    = FBM2(X, Y, 0.005\xB7f, 3)\xB7150
bot    = FBM2(X+391, Y-71, 0.008\xB7f, 3)\xB7150
tube   = 400 - |XY|
band   = SUnion(top-Z, Z-bot, 25) + 50
global = IQ2(X, Y, 0.005\xB7f, 15)\xB7200 + 150
value  = SInter(Z-global, SUnion(tube, band, 100), 15)
\u4F53\u5185 d>0 = \u7A7A\u6C14\uFF08\u6D1E\u7A74\u7A7A\u8154\uFF09\uFF0Cd<0 = \u5B9E\u4F53\uFF08\u5CA9\u77F3\uFF09`
  },
  {
    id: "ravines",
    n: 4,
    short: "Ravines",
    title: "4 \xB7 VoxelExample_Ravines\uFF08\u5CE1\u8C37\uFF09",
    zRange: [-120, 80],
    isVolumetric: true,
    formula: `f    = 0.02\xB7f
p    = Perlin3(X\xB7f, Y\xB7f, Z\xB7f, oct=1)
top  = SInter(Z, 5\xB7p, 5)
value = SUnion(Z+50, top, 5)
\u4F53\u5185 d>0 = \u7A7A\u6C14\uFF08\u5CE1\u8C37\u5F00\u53E3\uFF09\uFF0Cd<0 = \u5B9E\u4F53\uFF08\u5CA9\u58C1\uFF09`
  },
  {
    id: "erosion",
    n: 5,
    short: "Erosion",
    title: "5 \xB7 VG_Example_Erosion\uFF08\u4FB5\u8680\uFF09",
    zRange: [-180, 700],
    isVolumetric: false,
    needsSeed: true,
    formula: `q = FBM2D(X, Y, 0.001\xB7f, 3)            (val + \u2207)
w = smoothstep(-0.5, 0, q[0])
e = ErosionNoise(X, Y, 0.02\xB7f, 5)        (5\xD75 \u6D41\u5411\u6838)
h = 500\xB7(q[0] + 0.008\xB7e\xB7w)
value = Z - h  (\u8584\u58F3 SDF\uFF0CZ<h \u4E3A\u5B9E\u4F53)`
  },
  {
    id: "multi",
    n: 6,
    short: "Multi",
    title: "6 \xB7 VG_Example_MultiIndex\uFF08\u591A\u9891 FBM\uFF09",
    zRange: [-400, 400],
    isVolumetric: false,
    formula: `h = 300\xB7FBM2(X, Y, 0.002\xB7f, 7)        (7 oct FBM)
value = Z - h  (\u8584\u58F3 SDF\uFF0CZ<h \u4E3A\u5B9E\u4F53)`
  },
  {
    id: "iq",
    n: 7,
    short: "IQ",
    title: "7 \xB7 VoxelExample_IQNoise\uFF08IQ \u57DF\u65CB\u8F6C\uFF09",
    zRange: [-650, 650],
    isVolumetric: false,
    formula: `h = 500\xB7IQ2(X, Y, 0.001\xB7f, 15)        (15 oct, 40\xB0 \u57DF\u65CB\u8F6C)
value = Z - h  (\u8584\u58F3 SDF\uFF0CZ<h \u4E3A\u5B9E\u4F53)`
  },
  {
    id: "dunes_on_cliffs",
    n: 8,
    short: "Dunes\u2229Cliffs",
    title: "8 \xB7 Hybrid \xB7 Dunes-on-Cliffs\uFF08\u53F0\u5730+\u6C99\u4E18\uFF09",
    zRange: [-180, 130],
    isVolumetric: false,
    needsDunes: true,
    formula: `dC = Z - cliffsHeight(X, Y)
dD = Z - dunesHeight(X, Y)
value = SInter(dC, dD, 30)
\u53F0\u5730 + \u6C99\u4E18 SInter\uFF1A\u53EA\u5728\u4E24\u8005\u90FD\u5B9E\u7684\u5730\u65B9\u4E3A\u5B9E\uFF0C
\u8FB9\u754C k=30 \u5E73\u6ED1\u8FC7\u6E21`
  },
  {
    id: "cliffs_plus_iq",
    n: 9,
    short: "Cliffs\u222AIQ",
    title: "9 \xB7 Hybrid \xB7 Cliffs+IQ\uFF08\u53F0\u5730+IQ \u952F\u9F7F\uFF09",
    zRange: [-650, 650],
    isVolumetric: false,
    formula: `dC = Z - cliffsHeight(X, Y)
dI = Z - iqHeight(X, Y)
value = max(dC, dI)  (Intersection)
\u53F0\u5730\u4E3B\u4F53 + IQ \u566A\u58F0\u5C71\u810A\u4EA4\u96C6
= \u4E24\u8005\u90FD\u5B9E\u624D\u7B97\u5B9E\uFF0CIQ \u9AD8\u70B9\u4E0D\u4F1A\u6210\u4E3A\u7A7A\u4E2D\u6D6E\u5C9B`
  },
  {
    id: "ravine_plus_erosion",
    n: 10,
    short: "Rav\u2229Ero",
    title: "10 \xB7 Hybrid \xB7 Ravine+Erosion\uFF08\u5CE1\u8C37+\u4FB5\u8680\uFF09",
    zRange: [-400, 400],
    isVolumetric: false,
    needsSeed: true,
    formula: `hM = multiHeight(X, Y)                 (Multi \u57FA\u7EBF)
rav = pow(smoothstep(0.68, 0.94, |perlin|), 2)\xB7100
h   = hM - rav - 20\xB7fbm2(X\xB70.016\xB7f, Y\xB70.016\xB7f, 5)
value = Z - h  (\u8584\u58F3 SDF\uFF0CZ<h \u4E3A\u5B9E\u4F53)`
  },
  {
    id: "erosion_plus_multi",
    n: 11,
    short: "Ero\u222AMulti",
    title: "11 \xB7 Hybrid \xB7 Erosion+Multi\uFF08\u4FB5\u8680+\u591A\u9891\uFF09",
    zRange: [-400, 700],
    isVolumetric: false,
    needsSeed: true,
    formula: `hM = multiHeight(X, Y)
hE = erosionHeight(X, Y, seed)
value = SUnion(Z - hM, Z - hE, 40)
\u4E24\u9AD8\u5EA6\u573A SUnion\uFF1A\u9009\u8F83\u9AD8\u8005\uFF0Ck=40 \u5E73\u6ED1\u8FC7\u6E21`
  },
  {
    id: "iq_plus_ravine",
    n: 12,
    short: "IQ\u2229Ravine",
    title: "12 \xB7 Hybrid \xB7 IQ+Ravine\uFF08IQ \u5C71\u810A+\u5CE1\u8C37\uFF09",
    zRange: [-650, 650],
    isVolumetric: false,
    formula: `hI = iqHeight(X, Y)
rav = pow(smoothstep(0.68, 0.94, |perlin|), 2)\xB7200
h   = max(hI - rav, -200)
value = Z - h  (\u8584\u58F3 SDF\uFF0CZ<h \u4E3A\u5B9E\u4F53)
IQ \u4E3B\u5BFC\u5C71\u810A\uFF0Cravine \u5728\u9AD8\u503C\u5904\u4E0B\u5207`
  },
  {
    id: "region_driven",
    n: 13,
    short: "RegionDriven",
    title: "13 \xB7 Hybrid \xB7 RegionDriven\uFF085 \u533A\u57DF\u5408\u6210\uFF09",
    zRange: [-650, 700],
    isVolumetric: false,
    needsSeed: true,
    needsDunes: true,
    formula: `5 \u4E2A fbm2 smoothstep \u533A\u57DF\u63A9\u7801 \xD7 5 \u7B97\u5B50\uFF1A
  dune / cliff / rav / erosion / iq
\u6BCF\u4E2A\u7B97\u5B50\u6309\u5BF9\u5E94\u63A9\u7801\u52A0\u6743 SUnion \u5230\u80CC\u666F\u4E0A
  (k=15~30 \u5E73\u6ED1\u8FC7\u6E21)
TerrainLab model.ts \u533A\u57DF\u5408\u6210\u903B\u8F91\u7684 SDF \u5316\u91CD\u5199`
  }
];
var MODE_BY_ID = Object.fromEntries(
  MODE_SPECS.map((s) => [s.id, s])
);

// _cliffs_diag.ts
var n = new VoxelNoise(1337);
var freq = 1;
function zeroCrossings(x, y) {
  const zs = [];
  const z0 = -120, z1 = 220, steps = 340;
  let prevZ = z0;
  let prevD = cliffsDensity(n, x, y, z0, freq);
  for (let s = 1; s <= steps; s++) {
    const z = z0 + (z1 - z0) * s / steps;
    const d = cliffsDensity(n, x, y, z, freq);
    if (prevD >= 0 && d <= 0 || prevD <= 0 && d >= 0) {
      let lo = Math.min(prevZ, z), hi = Math.max(prevZ, z), dlo = prevD;
      for (let i = 0; i < 24; i++) {
        const m = (lo + hi) * 0.5, dm = cliffsDensity(n, x, y, m, freq);
        if (dlo >= 0 && dm >= 0 || dlo <= 0 && dm <= 0) {
          lo = m;
          dlo = dm;
        } else hi = m;
      }
      zs.push((lo + hi) * 0.5);
    }
    prevZ = z;
    prevD = d;
  }
  return zs;
}
function htmlSurface(x, y) {
  const zMin = -120, zMax = 220, steps = 48;
  let zPrev = zMax, dPrev = cliffsDensity(n, x, y, zMax, freq);
  for (let s = 1; s <= steps; s++) {
    const z = zMax - (zMax - zMin) * s / steps;
    const d = cliffsDensity(n, x, y, z, freq);
    if (dPrev >= 0 && d <= 0 || dPrev <= 0 && d >= 0) {
      let lo = Math.min(zPrev, z), hi = Math.max(zPrev, z), dlo = dPrev;
      for (let i = 0; i < 20; i++) {
        const m = (lo + hi) * 0.5, dm = cliffsDensity(n, x, y, m, freq);
        if (dlo >= 0 && dm >= 0 || dlo <= 0 && dm <= 0) {
          lo = m;
          dlo = dm;
        } else hi = m;
      }
      return (lo + hi) * 0.5;
    }
    zPrev = z;
    dPrev = d;
  }
  return zMin;
}
console.log("=== cliffs density \u5728 z \u65B9\u5411\u7684\u96F6\u4EA4\u53C9\uFF08marching \u4F1A\u5168\u90E8\u63D0\u53D6\uFF09===");
var maxZC = 0;
var minZC = 99;
var single = 0;
var multi = 0;
var samples = [];
for (let i = 0; i < 12; i++) {
  const x = -180 + i * 32;
  for (let j = 0; j < 8; j++) {
    const y = -140 + j * 40;
    const zc = zeroCrossings(x, y);
    const h = htmlSurface(x, y);
    maxZC = Math.max(maxZC, zc.length);
    minZC = Math.min(minZC, zc.length);
    if (zc.length <= 1) single++;
    else multi++;
    samples.push([x, y, zc, h]);
  }
}
console.log(`\u96F6\u4EA4\u53C9\u6570\u91CF: min=${minZC} max=${maxZC} | \u5355\u4EA4\u53C9=${single} \u591A\u4EA4\u53C9=${multi}`);
console.log("\n=== \u82E5\u5E72\u91C7\u6837\u70B9\u8BE6\u60C5 ===");
for (const [x, y, zc, h] of samples.slice(0, 12)) {
  console.log(`(${x},${y}) \u96F6\u4EA4\u53C9=[${zc.map((z) => z.toFixed(1)).join(", ")}]  HTML\u8868\u9762=${h.toFixed(1)}`);
}
console.log("\n=== \u591A\u4EA4\u53C9\u70B9\u7684 density \u5256\u9762 (x,y) \u56FA\u5B9A\uFF0C\u626B z ===");
var mp = samples.find((s) => s[2].length > 1);
if (mp) {
  const [x, y] = mp;
  const sides = n.perlin2(x * 0.1 * freq, y * 0.1 * freq, n.pOffset(1));
  const top = n.iq2(x, y, 0.01 * freq, 15) * 25;
  console.log(`x=${x} y=${y} sides=${sides.toFixed(3)} top=${top.toFixed(1)}`);
  for (let z = -10; z <= 90; z += 5) {
    const p = Math.max(0, Math.min(1, (z / 50 + 0.2 * sides) * 10));
    const d = z - (50 * p + top * p);
    console.log(`  z=${z.toFixed(1)} p=${p.toFixed(3)} d=${d.toFixed(1)}`);
  }
}
