/**
 * VoxelPlugin 示例地形的 Density 公式（体渲染用）。
 *
 * 坐标语义（严格保持 VoxelPlugin）：
 *   X = 水平，Y = 水平，Z = 高度（向上）。
 *   密度约定：density > 0 = 空气，density < 0 = 实体，表面 = density 0。
 *   （VoxelPlugin 体素值正=空、负=实的约定；Marching Tetrahedra 按此判 inside。）
 *
 * CSG 算子使用标准 SDF 语义：
 *   Union        ≈ min(a,b)
 *   Intersection ≈ max(a,b)
 *   Smooth 版本见下方两函数——方向绝不能写反（历史上 Ravines 的
 *   「平面 bug」就是 Union/Intersection 互换导致的）。
 *
 * UE5 移植：每个公式即 VoxelExample_*.cpp 的 TranslateBody 逐行翻译，
 * 常量（频率/倍频/幅度/k）保持原值即可复现。
 */

import { VoxelNoise } from "./voxelNoise";

export function clamp(x: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, x));
}

/**
 * Smooth Union（min-like）：
 *   h = clamp(0.5 + 0.5·(b-a)/k, 0, 1)
 *   return (b + (a-b)·h) - k·h·(1-h)
 * k→0 退化为 Math.min。h 权重使交班处坡面平滑，k 即平滑半径。
 */
export function smoothUnion(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}

/**
 * Smooth Intersection（max-like）：
 *   h = clamp(0.5 - 0.5·(b-a)/k, 0, 1)
 *   return (b + (a-b)·h) + k·h·(1-h)
 * k→0 退化为 Math.max。注意与 Union 的符号差异（+k 与 -k）。
 */
export function smoothIntersection(a: number, b: number, k: number): number {
  if (k <= 0) return Math.max(a, b);
  const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h + k * h * (1 - h);
}

/* ============================================================
 * VoxelExample_Cave（体积 SDF）
 *
 *   top    = PerlinFractal2D(X, Y, freq=0.005, oct=3) × 150   // 洞穴带上边界
 *   bot    = PerlinFractal2D(X+391, Y-71, freq=0.008, oct=3) × 150
 *            （坐标偏移仅用于与 top 去相关，不改语义）
 *   tube   = 400 - sqrt(X² + Y²)                              // 沿 Z 轴圆柱（限洞径）
 *   band   = SmoothUnion(top - Z, Z - bot, k=25) + 50         // 上下边界的外部并集
 *   global = IQNoise2D(X, Y, freq=0.005, oct=15) × 200 + 150  // 全局地表
 *   value  = SmoothIntersection(Z - global, SmoothUnion(tube, band, k=100), k=15)
 *
 * 解读（正=空气约定下）：
 *   Z > global            → 空气（天空）；
 *   Z < global 且在圆柱内且在 [bot, top] 带内 → 空气（洞穴空腔）；
 *   其余 → 实体。
 * 即「地下 + 圆柱内 + 垂直带内」挖出蜿蜒洞穴，顶部被 global 地表封住。
 *
 * 性能要点：top/bot/tube/global 只依赖 (X,Y)，与 Z 无关——
 * 按 (X,Y) 列缓存（CaveColumn）后，每个体素的密度计算只剩 3 次 CSG。
 * ============================================================ */

export interface CaveColumn {
  top: number;
  bot: number;
  tube: number;
  global: number;
}

/** 洞穴列缓存：一次算齐 4 个 (X,Y) 相关场（freq 为全局频率缩放） */
export function caveColumn(n: VoxelNoise, x: number, y: number, freq: number): CaveColumn {
  return {
    top: n.fbm2(x, y, 0.005 * freq, 3) * 150,
    bot: n.fbm2(x + 391, y - 71, 0.008 * freq, 3) * 150,
    tube: 400 - Math.hypot(x, y),
    global: n.iq2(x, y, 0.005 * freq, 15) * 200 + 150,
  };
}

/** 由列缓存求密度（Z 为高度） */
export function caveDensity(z: number, c: CaveColumn): number {
  const band = smoothUnion(c.top - z, z - c.bot, 25) + 50;
  return smoothIntersection(z - c.global, smoothUnion(c.tube, band, 100), 15);
}

/* ============================================================
 * VoxelExample_Ravines（体积 SDF）
 *
 *   f    = 0.02（频率，直接缩放 3D 坐标）
 *   p    = Perlin3(X·f, Y·f, Z·f, oct=1)
 *   top  = SmoothIntersection(Z, 5·p, k=5)
 *   value = SmoothUnion(Z + 50, top, k=5)
 *
 * 解读：地面在 Z=0 附近，5·p 提供起伏；Z+50 的 Union 从下方截断，
 * 形成深约 50 的侵蚀槽（峡谷）。正=空气约定同上。
 * ============================================================ */

export function ravinesDensity(n: VoxelNoise, x: number, y: number, z: number, freq: number): number {
  const f = 0.02 * freq;
  const p = n.perlin3(x * f, y * f, z * f, n.pOffset(0));
  const top = smoothIntersection(z, 5 * p, 5);
  return smoothUnion(z + 50, top, 5);
}
