/**
 * VoxelFastNoise 的 JS 精确复刻（VoxelPlugin 内部噪声 = FastNoise 的封装）。
 *
 * 与 src/terrain/noise.ts（TerrainLab 主地形的简化 Perlin）不同，本文件的目标是
 * 「逐位对齐 VoxelPlugin」——同一个 (X, Y, Z, Seed) 下，JS 与 UE5/VoxelPlugin
 * 得到几乎一致的 Density。对齐点：
 *
 *   1. MT19937 种子器 + uniform 整数分布（拒绝采样），对应 std::mt19937；
 *   2. buildPerm 保留 VoxelPlugin SetSeed 的「256-j」历史 bug（见函数注释）；
 *   3. 12 梯度向量 LUT（3D Perlin 梯度表，2D 采样复用前两个分量）；
 *   4. Quintic 插值（FastNoise QUINTIC 默认）及其导数（解析导数，用于 IQ/Erosion）；
 *   5. FBM 的 FractalBounding 归一化（1 / Σamp），对应 VoxelFastNoise::FractalBounding；
 *   6. IQNoise：旋转域（40°）+ 导数加权的 Inigo Quilez 噪声；
 *   7. Erosion：按梯度方向流的 5×5 类 Gavoronoi 侵蚀核。
 *
 * 坐标语义（全库统一，勿改）：X = 水平，Y = 水平，Z = 高度（VoxelPlugin 体素语义）。
 * 转换到 Three.js 只发生在 Mesh 输出阶段（见 marching.ts），密度计算内部禁止改 Z。
 *
 * UE5 移植：本文件即 VoxelFastNoise 的 JS 镜像，逐函数对照
 * VoxelFastNoise.cpp / FastNoise.cpp 移植即可；数值锚点见各函数注释。
 */

/** 12 个 3D 梯度向量（FastNoise 梯度表，Gx/Gy/Gz 为三轴分量） */
const Gx = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const Gy = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const Gz = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];

/** FastFloor：向负无穷取整（Math.floor 的位运算快速版，负数行为必须一致） */
export function fastFloor(f: number): number {
  return f >= 0 ? Math.trunc(f) : Math.trunc(f) - 1;
}

/** Quintic 缓动：t³(t(6t-15)+10)，FastNoise QUINTIC 插值 */
export function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Quintic 导数：30t²(t-1)²（解析导数，供 IQ/Erosion 的导数加权使用） */
export function quinticDeriv(t: number): number {
  return 30 * t * t * (t - 1) * (t - 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

/**
 * MT19937 梅森旋转（32 位）——对应 std::mt19937。
 * UE5 移植：直接用 std::mt19937 / FRandomStream 之外的原始实现，
 * 逐位一致（twist 参数 1812433253 / 0x9908b0df 均为标准值）。
 */
class MT19937 {
  private mt = new Uint32Array(624);
  private i = 624;

  constructor(seed: number) {
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      this.mt[i] = (Math.imul(1812433253, this.mt[i - 1] ^ (this.mt[i - 1] >>> 30)) + i) >>> 0;
    }
  }

  private twist() {
    for (let i = 0; i < 624; i++) {
      const y = (this.mt[i] & 0x80000000) | (this.mt[(i + 1) % 624] & 0x7fffffff);
      this.mt[i] = (this.mt[(i + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
    }
    this.i = 0;
  }

  next(): number {
    if (this.i >= 624) this.twist();
    let y = this.mt[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /**
   * 均匀整数 [0, n]（拒绝采样）——镜像 std::uniform_int_distribution 的语义。
   * 关键：拒绝上限 lim 的计算方式必须逐位一致，否则置换表与 VoxelPlugin 不同。
   */
  uniform(n: number): number {
    const range = n + 1;
    const lim = 0x100000000 - (0x100000000 % range);
    let r: number;
    do {
      r = this.next();
    } while (r >= lim);
    return r % range;
  }
}

/**
 * 构建置换表（对应 VoxelFastNoise::SetSeed 内的 BuildPermutation）。
 *
 * 历史 bug（刻意保留）：`p[j] = p[j+256] = p[k]` 把 p[j+256] 直接覆盖为 p[k]
 * 而不是独立洗牌——VoxelPlugin 上游如此，JS 复刻必须保持一致才能逐位对齐。
 * p12[j] = p[j] % 12：置换值 → 梯度索引（12 梯度 LUT）。
 */
function buildPerm(seed: number) {
  const gen = new MT19937(seed | 0);
  const p = new Uint16Array(512);
  const p12 = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let j = 0; j < 256; j++) {
    const k = j + gen.uniform(256 - j);
    const l = p[j];
    p[j] = p[j + 256] = p[k]; // ← 256-j 历史 bug（见上）
    p[k] = l;
    p12[j] = p12[j + 256] = p[j] % 12;
  }
  return { p, p12 };
}

/** murmur32 最终izer（Erosion 核的 cell 哈希，对应 murmur_hash3 混合器） */
export function murmur32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * VoxelNoise：VoxelPlugin 的 VoxelFastNoise 等价类。
 *
 * 状态：置换表 P（p: 0..255 置换，p12: 梯度索引）、gain（默认 0.5）、
 * lac（lacunarity=2）、fracBound（FractalBounding 归一化）。
 * setOct 重算 fracBound——oct 改变后必须调用（FBM 归一化系数随层数变化）。
 *
 * UE5 移植：成员与函数名一一对应 VoxelFastNoise；gain/lac/fracBound 语义相同。
 */
export class VoxelNoise {
  seed: number;
  private P: { p: Uint16Array; p12: Uint8Array };
  gain = 0.5;
  lac = 2;
  fracBound = 1;

  constructor(seed: number) {
    this.seed = seed | 0;
    this.P = buildPerm(this.seed);
    this.setOct(7);
  }

  setOct(o: number) {
    let a = 1;
    let amp = 0.5;
    for (let i = 1; i < o; i++) {
      a += amp;
      amp *= this.gain;
    }
    this.fracBound = 1 / a;
  }

  /** 置换偏移 p[i]（每 octave 的采样偏移，FBM/IQ/Erosion 用它去相关） */
  pOffset(i: number): number {
    return this.P.p[i & 255];
  }

  /** 2D 梯度索引：off 为置换偏移（每 octave 不同，实现去相关） */
  private idx2(off: number, x: number, y: number): number {
    const p = this.P.p;
    const p12 = this.P.p12;
    return p12[((x & 255) + p[(y & 255) + off]) & 511];
  }

  /** 3D 梯度索引（嵌套置换，与 FastNoise Grad3 索引链一致） */
  private idx3(off: number, x: number, y: number, z: number): number {
    const p = this.P.p;
    const p12 = this.P.p12;
    return p12[((x & 255) + p[(y & 255) + p[(z & 255) + off]]) & 511];
  }

  private grad2(off: number, x: number, y: number, dx: number, dy: number): number {
    const q = this.idx2(off, x, y);
    return dx * Gx[q] + dy * Gy[q];
  }

  /** grad2 + 返回梯度基向量（供解析导数计算） */
  private grad2v(off: number, x: number, y: number, dx: number, dy: number): [number, number, number] {
    const q = this.idx2(off, x, y);
    return [dx * Gx[q] + dy * Gy[q], Gx[q], Gy[q]];
  }

  private grad3(off: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
    const q = this.idx3(off, x, y, z);
    return dx * Gx[q] + dy * Gy[q] + dz * Gz[q];
  }

  /**
   * 2D Perlin（Quintic 插值）。deriv=true 时返回 [value, dD/dx, dD/dy]。
   * 数值锚点：整数格点处 value=0；输出约 [-1, 1]。
   */
  perlin2(x: number, y: number, off = 0, deriv = false): number | [number, number, number] {
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
    const dx =
      a[1] + xs * (b[1] - a[1]) + ys * (c[1] - a[1]) + xs * ys * (a[1] - b[1] - c[1] + d[1]) +
      dxI * (ys * (va - vb - vc + vd) + vb - va);
    const dy =
      a[2] + xs * (b[2] - a[2]) + ys * (c[2] - a[2]) + xs * ys * (a[2] - b[2] - c[2] + d[2]) +
      dyI * (xs * (va - vb - vc + vd) + vc - va);
    return [val, dx, dy];
  }

  /** 3D Perlin（Quintic 插值），Ravines 等体积示例使用 */
  perlin3(x: number, y: number, z: number, off = 0): number {
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
  fbm2(x: number, y: number, freq: number, oct: number): number {
    x *= freq;
    y *= freq;
    let sum = this.perlin2(x, y, this.P.p[0]) as number;
    let amp = 1;
    for (let i = 1; i < oct; i++) {
      x *= this.lac;
      y *= this.lac;
      amp *= this.gain;
      sum += (this.perlin2(x, y, this.P.p[i]) as number) * amp;
    }
    return sum * this.fracBound;
  }

  /** 带导数的 FBM（Erosion 示例的谷底屏蔽需要梯度） */
  fbm2d(x: number, y: number, freq: number, oct: number): [number, number, number] {
    x *= freq;
    y *= freq;
    const s0 = this.perlin2(x, y, this.P.p[0], true) as [number, number, number];
    let sum = s0[0];
    let amp = 1;
    let dx = s0[1];
    let dy = s0[2];
    for (let i = 1; i < oct; i++) {
      x *= this.lac;
      y *= this.lac;
      amp *= this.gain;
      const v = this.perlin2(x, y, this.P.p[i], true) as [number, number, number];
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
  iq2(x: number, y: number, freq: number, oct: number): number {
    let xx = x * freq;
    let yy = y * freq;
    let sum = 0;
    let amp = 1;
    const ang = 0.6981317008;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let i = 0; i < oct; i++) {
      const n = this.perlin2(xx, yy, this.P.p[i], true) as [number, number, number];
      const w = amp / (1 + n[1] * n[1] + n[2] * n[2]);
      sum += n[0] * w;
      const rx = c * xx - s * yy;
      const ry = s * xx + c * yy;
      xx = rx * 2;
      yy = ry * 2;
      amp *= 0.5;
    }
    return sum * this.fracBound;
  }
}

/**
 * Erosion 噪声（VG_Example_Erosion 的 GetErosion 等价物）：
 * 每 octave 在 5×5 邻域内找最近特征点（murmur32 哈希定位），
 * 沿 Perlin 梯度在「指向特征点方向」上的投影流动（负号 = 向洼地汇聚）。
 * 注意：输出不乘 fracBound（与旧实现一致，幅度天然有界于 ±Σamp≈2）。
 *
 * 数值契约（UE5 移植锚点）：
 *   - 特征点位置 = cell 中心 + 0.5×(cos, sin)(hash·2π)，仅在 5×5 邻域内；
 *   - 流向 dir = -(∇perlin · d̂nearest)，权重 exp(-2·d²)；
 *   - 每 octave 坐标 ×2、幅度 ×0.5。
 */
export function erosionNoise(n: VoxelNoise, x: number, y: number, freq: number, oct: number, seed: number): number {
  let xx = x * freq;
  let yy = y * freq;
  let sum = 0;
  let amp = 1;
  const TAU = Math.PI * 2;
  for (let o = 0; o < oct; o++) {
    const cx = fastFloor(xx);
    const cy = fastFloor(yy);
    const fx = xx - cx;
    const fy = yy - cy;
    let best = 1e9;
    let bx = 0;
    let by = 0;
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        const h = murmur32((((cx + i) * 374761393) ^ ((cy + j) * 668265263) ^ (seed + o * 97)) | 0);
        const ang = (h / 4294967296) * TAU;
        const px = i + 0.5 + 0.5 * Math.cos(ang);
        const py = j + 0.5 + 0.5 * Math.sin(ang);
        const dx = fx - px;
        const dy = fy - py;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          bx = dx;
          by = dy;
        }
      }
    }
    const g = n.perlin2(xx, yy, n.pOffset(o), true) as [number, number, number];
    const dir = -(g[1] * bx + g[2] * by);
    sum += dir * Math.exp(-best * 2) * amp;
    xx *= 2;
    yy *= 2;
    amp *= 0.5;
  }
  return sum;
}
