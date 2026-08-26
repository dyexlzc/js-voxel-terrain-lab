/** 种子化 Perlin 噪声库（移植自 VoxelFree Terrain Lab） */
export class NoiseLib {
  p: Uint8Array;

  constructor(seed = 1337) {
    this.p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let s = seed >>> 0;
    const rng = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (256 - i));
      const t = perm[i];
      perm[i] = perm[i + j];
      perm[i + j] = t;
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  fade(t: number) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  lerp(t: number, a: number, b: number) {
    return a + t * (b - a);
  }

  grad2(h: number, x: number, y: number) {
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1 ? -u : u) + (h & 2 ? -2 * v : 2 * v));
  }

  perlin2(x: number, y: number) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const X = fx & 255;
    const Y = fy & 255;
    x -= fx;
    y -= fy;
    const u = this.fade(x);
    const v = this.fade(y);
    const A = this.p[X] + Y;
    const B = this.p[X + 1] + Y;
    return (
      this.lerp(
        v,
        this.lerp(u, this.grad2(this.p[A], x, y), this.grad2(this.p[B], x - 1, y)),
        this.lerp(u, this.grad2(this.p[A + 1], x, y - 1), this.grad2(this.p[B + 1], x - 1, y - 1))
      ) / 1.6
    );
  }

  grad3(h: number, x: number, y: number, z: number) {
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  }

  perlin3(x: number, y: number, z: number) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const X = fx & 255;
    const Y = fy & 255;
    const Z = fz & 255;
    x -= fx;
    y -= fy;
    z -= fz;
    const u = this.fade(x);
    const v = this.fade(y);
    const w = this.fade(z);
    const A = this.p[X] + Y;
    const AA = this.p[A] + Z;
    const AB = this.p[A + 1] + Z;
    const B = this.p[X + 1] + Y;
    const BA = this.p[B] + Z;
    const BB = this.p[B + 1] + Z;
    return (
      this.lerp(
        w,
        this.lerp(
          v,
          this.lerp(u, this.grad3(this.p[AA], x, y, z), this.grad3(this.p[BA], x - 1, y, z)),
          this.lerp(u, this.grad3(this.p[AB], x, y - 1, z), this.grad3(this.p[BB], x - 1, y - 1, z))
        ),
        this.lerp(
          v,
          this.lerp(u, this.grad3(this.p[AA + 1], x, y, z - 1), this.grad3(this.p[BA + 1], x - 1, y, z - 1)),
          this.lerp(u, this.grad3(this.p[AB + 1], x, y - 1, z - 1), this.grad3(this.p[BB + 1], x - 1, y - 1, z - 1))
        )
      ) / 1.6
    );
  }

  fbm2(x: number, y: number, oct: number) {
    let v = 0;
    let a = 1;
    let f = 1;
    let m = 0;
    for (let i = 0; i < oct; i++) {
      v += this.perlin2(x * f, y * f) * a;
      m += a;
      a *= 0.5;
      f *= 2;
    }
    return v / m;
  }

  ridged2(x: number, y: number, oct: number) {
    let v = 0;
    let a = 1;
    let f = 1;
    let w = 1;
    let m = 0;
    for (let i = 0; i < oct; i++) {
      let n = 1 - Math.abs(this.perlin2(x * f, y * f));
      n *= n;
      v += n * w * a;
      w = Math.min(1, Math.max(0, n * 2));
      m += a;
      a *= 0.5;
      f *= 2;
    }
    return v / m;
  }

  perlin1(x: number) {
    const fx = Math.floor(x);
    const X = fx & 255;
    x -= fx;
    const g0 = this.p[X] & 1 ? x : -x;
    const g1 = this.p[X + 1] & 1 ? x - 1 : -(x - 1);
    return this.lerp(this.fade(x), g0, g1) * 2;
  }

  /**
   * Worley F1 + 空间连续振幅场（山脉区域场核心）：
   * 每个网格单元一个抖动特征点（= 一个"区域主峰"候选）。
   * out[0] = F1：到最近特征点的距离（0~约1.1）；
   * out[1] = 振幅（0~1）：邻域特征点哈希振幅的高斯核加权平均。
   *
   * 连续性要点（避免垂直断崖）：
   * - 振幅不做 top-k 选择（最近/次近单元切换点会产生跳变），而是
   *   对全部邻近特征点求和型加权 → 处处连续；
   * - 5×5 搜索窗口保证 jitter=0.92 时 F1/F2 不因窗口移位而跳变；
   * - 特征点包围盒预剔除远处单元，控制计算量。
   */
  worley2(x: number, y: number, out: Float32Array) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    let f1 = Infinity;
    let ampSum = 0;
    let wSum = 0;
    const cut = 2.1 * 2.1;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const cx = fx + dx;
        const cy = fy + dy;
        // 特征点包围盒 [cx+0.04, cx+0.96]² 的最近距离（jitter=0.92 → ±0.46）
        const bx = x < cx + 0.04 ? cx + 0.04 : x > cx + 0.96 ? cx + 0.96 : x;
        const by = y < cy + 0.04 ? cy + 0.04 : y > cy + 0.96 ? cy + 0.96 : y;
        const bddx = x - bx;
        const bddy = y - by;
        if (bddx * bddx + bddy * bddy >= cut) continue;
        const ix = cx & 255;
        const iy = cy & 255;
        const h1 = this.p[(this.p[ix] + iy) & 255] / 255;
        const h2 = this.p[(this.p[(ix + 57) & 255] + iy) & 255] / 255;
        const h3 = this.p[(this.p[(ix + 113) & 255] + iy) & 255] / 255;
        const px = cx + 0.5 + (h1 - 0.5) * 0.92;
        const py = cy + 0.5 + (h2 - 0.5) * 0.92;
        const ddx = x - px;
        const ddy = y - py;
        const d2 = ddx * ddx + ddy * ddy;
        const d = Math.sqrt(d2);
        if (d < f1) f1 = d;
        // 高斯核 σ≈0.35（1/(2σ²)≈4.08）：峰顶处本单元主导，单元边界平滑混合
        const w = Math.exp(-d2 * 4.08);
        ampSum += h3 * w;
        wSum += w;
      }
    }
    out[0] = f1;
    out[1] = wSum > 0 ? ampSum / wSum : 0.5;
  }

  /**
   * 折叠峰谷噪声（Minecraft 1.18 "Peaks & Valleys"，即 folded ridges）：
   *   PV = 1 - | 3 * |weirdness| - 2 |
   * 其中 weirdness = FBM(x, y, oct) 输出（约 [-1, 1]）。
   *
   * 输出范围 [-1, 1]：+1 = 山脊/峰顶，-1 = 谷底。
   * 相比普通 ridged 噪声，折叠变换的拓扑会发生「回折」——
   * 峰链常常首尾相接围出一圈内部洼地（Minecraft 的 mountain rings），
   * 山体因此呈现「环状山脊 + 围谷 + 次级峰群」而非单一穹顶。
   *
   * 数值行为（UE5 C++ 移植后的单元测试锚点）：
   *   |w| = 0    → PV = -1（谷底）
   *   |w| = 2/3  → PV = +1（脊顶）
   *   |w| = 1    → PV =  0（坡面）
   *
   * 移植要点：纯函数、无内部状态，先取 FBM 再折叠即可；
   * octaves 建议 2~4（过低无细节，过高会破坏环状拓扑的尺度感）。
   */
  peaksValleys2(x: number, y: number, oct: number) {
    const w = this.fbm2(x, y, oct);
    return 1 - Math.abs(3 * Math.abs(w) - 2);
  }
}

export function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

export function smoothstep(e0: number, e1: number, x: number) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 分段线性样条（Minecraft overworld noise-router 的 offset spline 思路）：
 * 以升序控制点 (xs, ys) 把气候参数（大陆度 / 侵蚀度 / PV）映射为地形系数。
 * 与硬编码 if-else 链相比，控制点即调参表，美术可直接改数值调地形分布。
 *
 * 契约：xs 严格升序；xs/ys 等长；x 越界取端点值。
 * UE5 移植：TArray<FVector2D> 传入 + 线性扫描（控制点 ≤ 8 个，无需二分）。
 */
export function spline(x: number, xs: readonly number[], ys: readonly number[]) {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
    }
  }
  return ys[n - 1];
}

/**
 * 软量化（阶梯地形通用整形）：把 [0,1] 连续场量化为 steps 级台阶，
 * 台阶肩部用 smoothstep 过渡。
 *
 * 为什么不用 floor() 直接量化：floor 在台阶边界产生零宽度的垂直跳变，
 * 网格化后就是「方块状断崖」；软量化保留台地形态但高度处处连续。
 *
 * UE5 移植：
 *   float SoftQuant(float X, int Steps) {
 *     float V = FMath::Clamp(X, 0.f, 1.f) * Steps;
 *     float F = FMath::FloorToFloat(V);
 *     return (F + SmoothStep(0.25f, 0.75f, V - F)) / Steps;
 *   }
 */
export function softQuant(x: number, steps: number) {
  const v = clamp(x, 0, 1) * steps;
  const f = Math.floor(v);
  return (f + smoothstep(0.25, 0.75, v - f)) / steps;
}
