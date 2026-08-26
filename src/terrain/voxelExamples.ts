/**
 * VoxelPlugin 示例地形的 Density 公式（体渲染用）+ TerrainLab 改写混合体。
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
 * 本文件共三类密度：
 *   A. VoxelExample 1~7：原版 7 个示例（mountain_terrain_demo (2).html）
 *      1 Cliffs · 2 Dunes · 3 Cave · 4 Ravines · 5 Erosion · 6 Multi · 7 IQ
 *      高度场示例（1/2/5/6/7）通过 density = h(X,Y) - Z 包成薄壳 SDF；
 *      体示例（3/4）保留原始 volumetric 公式。
 *
 *   B. TerrainLab 探索区域掩码（model.ts regionMasks）：5 个 fbm2 低频连续
 *      噪声场 smoothstep 出来的 [0,1] 区域掩码。每个掩码独立于高度，专门
 *      标识「这片区域应被某种地形算子主导」。
 *
 *   C. 混合算法（Hybrid 1~6）：把 A 类的 1~7 算子按 B 类的区域掩码加权混合，
 *      形成 6 个可采样 SDF 的新算法——每个混合都是单一 density 公式。
 *      由此 CaveLab 不再只有 Cave/Ravines 两例，而能展示 1~7 + 6 个混合 = 13 个
 *      体密度算法（同一种 Marching Tetrahedra 管线，体素坐标语义不变）。
 *
 * UE5 移植：每个公式即 VoxelExample_*.cpp 的 TranslateBody 逐行翻译，
 * 常量（频率/倍频/幅度/k）保持原值即可复现。
 */

import { VoxelNoise, erosionNoise } from "./voxelNoise";

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

/* =====================================================================
 * B. TerrainLab 探索过的「区域掩码」算法（来自 model.ts regionMasks）
 * ===================================================================== */

/** 5 个区域掩码——原 model.ts 公式逐字翻译（独立于 height，只取决于 X/Y）。 */
export interface RegionMasks {
  duneMask: number;
  cliffMask: number;
  ravMask: number;
  eroMask: number;
  iqMask: number;
}

export interface RegionParams {
  regionScale: number;     // 区域尺度（u 空间频率）
  regionThreshold: number;  // 区域门槛
  sDune: number;
  sCliff: number;
  sRavine: number;
  sErosion: number;
  sIQ: number;
}

const DEFAULT_REGION_PARAMS: RegionParams = {
  regionScale: 0.0006,
  regionThreshold: 0.35,
  sDune: 1,
  sCliff: 1,
  sRavine: 1,
  sErosion: 1,
  sIQ: 1,
};

/** 区域掩码：fbm2 + smoothstep 门控 + 强度乘子。返回的 [0,1] 字段相互独立 */
export function regionMasks(
  n: VoxelNoise,
  x: number,
  y: number,
  P: RegionParams = DEFAULT_REGION_PARAMS
): RegionMasks {
  const rs = P.regionScale;
  const th = P.regionThreshold;
  const duneN = n.fbm2(x * rs + 10.7, y * rs + 42.3, 1, 3);
  const cliffN = n.fbm2(x * rs + 137.5, y * rs + 258.9, 1, 3);
  const ravN = n.fbm2(x * rs + 391.2, y * rs + 487.6, 1, 3);
  const eroN = n.fbm2(x * rs + 523.8, y * rs + 614.1, 1, 3);
  const iqN = n.fbm2(x * rs + 789.3, y * rs + 856.7, 1, 3);
  const t1 = th;
  const t2 = th + 0.2;
  return {
    duneMask: smoothstep01(t1, t2, duneN) * P.sDune,
    cliffMask: smoothstep01(t1, t2, cliffN) * P.sCliff,
    ravMask: smoothstep01(t1, t2, ravN) * P.sRavine,
    eroMask: smoothstep01(t1, t2, eroN) * P.sErosion,
    iqMask: smoothstep01(t1, t2, iqN) * P.sIQ,
  };
}

/** 标准 smoothstep：clamp((x-a)/(b-a), 0, 1) 后三次平滑（与 noise.ts 同语义） */
function smoothstep01(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/* =====================================================================
 * A. VoxelExample 1~7 密度公式
 * ===================================================================== */

/* ----- 1. VoxelExample_Cliffs（3D 自指型 SDF，依赖 query Z） -----
 * 原公式（demo exampleHeight(name, x, y, zp, n)，zp=query Z）：
 *   base  = fbm2(X, Y, 0.005·f, 3) + offset/10
 *   sides = perlin2(X·0.1·f, Y·0.1·f, off=1)
 *   p     = clamp((zp/50 + 0.2·sides)·10, 0, 1)
 *   top   = iq2(X, Y, 0.01·f, 15)·25
 *   h     = 50·p + lerp(0, top, p) + base·0.0
 *
 * 关键设计：p 显式依赖查询 Z。这意味着 density = z - h(z, x, y) 是自指型 3D
 * 场（z 既出现在左端又出现在 h 里），但不是 bug，是 cliffs 几何形状的本质：
 *   - sides > 0.5 的「高台地」区域：p 恒 = 1，h = 50+top（z=50~75 的平台顶面）
 *   - sides < 0 的「低台地」区域：低 z 时 p=0 → h=0（z=0 处的地平面）
 *     随 z 升高，p 线性爬到 1，h 同步爬到 50+top → 形成 z=0 与 z=50+top 两个
 *     等值面，中间填充实体 = 「崖体」
 *   - 0<sides<0.5 的「崖壁过渡带」：p 在 z=50·(0.5-sides) 处变 1，这一区段
 *     看不到 d=0 等值面（全程 solid），相邻 (x,y) 的高低平台通过崖壁连接
 *
 * 因此 marching tetrahedra 在 cliffs 区域会找到 2 个零交叉（z=0 和 z=50+top），
 * 低台地区域在 z=0 与 z=50+top 之间全部是 solid 实体——这就是「悬崖」的来源。
 * 几何上类似 1D 阶梯函数 lifted 到 3D：d=0 等值面 = 阶梯顶面 + 阶梯侧面。
 *
 * 历史误会（已澄清）：之前误判「原版 zp=0 固定，把查询 z 代入是 bug」，
 * 实际上原 demo exampleHeight(name, x, y, zp, n) 的 zp 就是查询 z，
 * 3D 自指是 cliffs 算法本身的设计，不是错误。把 zp 锁死成 0 会把 cliffs
 * 退化成 2D 高度场（只有 z=0 与 z=50+top 之间的二选一 surface），失去崖壁。
 *
 * 符号约定：d = z - h（z<h → d<0 → 实体，z>h → d>0 → 空气），与 VoxelPlugin
 * 一致；∇d 主要沿 +Z，与"空气在上"的视觉一致。
 *
 * Z 范围 [-15, 90]：下 15 单位空气（z=0 低台地顶面之下无意义），上 5 单位
 * 空气（z=70 顶面之上需要空气层），主表面 z∈[0, 75]。
 */
export function cliffsHeight(n: VoxelNoise, x: number, y: number, z: number, freq: number): number {
  const f = freq;
  const sides = n.perlin2(x * 0.1 * f, y * 0.1 * f, 1) as number;
  // 关键：zp = query z（demo 原版即如此，p 显式依赖 z 才是 cliffs 算法的设计）
  const p = clamp((z / 50 + 0.2 * sides) * 10, 0, 1);
  const top = n.iq2(x, y, 0.01 * f, 15) * 25;
  return 50 * p + top * p;
}
export function cliffsDensity(n: VoxelNoise, x: number, y: number, z: number, freq: number): number {
  // 标准 SDF 约定：z - h（z<h → d<0 → 实体，z>h → d>0 → 空气），
  // 与 VoxelPlugin 一致；梯度 ∇d 主要沿 +Z，与"空气在上"的视觉一致。
  return z - cliffsHeight(n, x, y, z, freq);
}

/* ----- 2. VG_Example_Dunes（高度场 → 薄壳 SDF） -----
 * 原公式：
 *   phase = fbm2(X, Y, 0.001·f, 3) + 0.002·(X·dx + Y·dy)·f
 *   h     = -75·|sin(π·phase)|   (范围 [-75, 0])
 * 包成 SDF：d = z - h（z<h → 实体）；Z 范围 ≈ [-200, 50] 才能完整看到沙丘波。
 */
export interface DunesParams {
  windX: number;
  windY: number;
}
export const DEFAULT_DUNES_PARAMS: DunesParams = { windX: 1, windY: 0 };

export function dunesHeight(n: VoxelNoise, x: number, y: number, freq: number, P: DunesParams = DEFAULT_DUNES_PARAMS): number {
  const dx = P.windX, dy = P.windY;
  const phase = n.fbm2(x, y, 0.001 * freq, 3) + 0.002 * (x * dx + y * dy) * freq;
  return -75 * Math.abs(Math.sin(Math.PI * phase));
}
export function dunesDensity(n: VoxelNoise, x: number, y: number, z: number, freq: number, P: DunesParams = DEFAULT_DUNES_PARAMS): number {
  // 标准 SDF 约定：z - h（z<h → d<0 → 实体，z>h → d>0 → 空气）
  return z - dunesHeight(n, x, y, freq, P);
}

/* ----- 3. VoxelExample_Cave（体 SDF，原版） ----- */

export interface CaveColumn {
  top: number;
  bot: number;
  tube: number;
  global: number;
}

export function caveColumn(n: VoxelNoise, x: number, y: number, freq: number): CaveColumn {
  return {
    top: n.fbm2(x, y, 0.005 * freq, 3) * 150,
    bot: n.fbm2(x + 391, y - 71, 0.008 * freq, 3) * 150,
    tube: 400 - Math.hypot(x, y),
    global: n.iq2(x, y, 0.005 * freq, 15) * 200 + 150,
  };
}

export function caveDensity(z: number, c: CaveColumn): number {
  const band = smoothUnion(c.top - z, z - c.bot, 25) + 50;
  return smoothIntersection(z - c.global, smoothUnion(c.tube, band, 100), 15);
}

/* ----- 4. VoxelExample_Ravines（体 SDF，原版） ----- */
export function ravinesDensity(n: VoxelNoise, x: number, y: number, z: number, freq: number): number {
  const f = 0.02 * freq;
  const p = n.perlin3(x * f, y * f, z * f, n.pOffset(0));
  const top = smoothIntersection(z, 5 * p, 5);
  return smoothUnion(z + 50, top, 5);
}

/* ----- 5. VG_Example_Erosion（高度场 → 薄壳 SDF） -----
 * 原公式：
 *   q = fbm2d(X, Y, 0.001·f, 3)               (val + ∂/∂x + ∂/∂y)
 *   w = smoothstep(-0.5, 0, q[0])
 *   e = erosionNoise(X, Y, 0.02·f, 5)         (5x5 murmur 流向核)
 *   h = 500·(q[0] + 0.008·e·w)
 * 包成 SDF：d = z - h；Z 范围 ≈ [-150, 700]。
 */
export function erosionHeight(n: VoxelNoise, x: number, y: number, freq: number, seed: number): number {
  const q = n.fbm2d(x, y, 0.001 * freq, 3);
  const w = smoothstep01(-0.5, 0, q[0]);
  const e = erosionNoise(n, x, y, 0.02 * freq, 5, seed);
  return 500 * (q[0] + 0.008 * e * w);
}
export function erosionDensity(n: VoxelNoise, x: number, y: number, z: number, freq: number, seed: number): number {
  // 标准 SDF 约定：z - h
  return z - erosionHeight(n, x, y, freq, seed);
}

/* ----- 6. VG_Example_MultiIndex（高度场 → 薄壳 SDF） -----
 * 原公式：h = 300·fbm2(X, Y, 0.002·f, 7)   (oct=7，含 FBM FractalBounding)
 * 最简单的体素化 FBM；用 7 个 octave 形成 8 阶分形。
 * 包成 SDF：d = z - h；Z 范围 ≈ [-400, 400]。
 */
export function multiHeight(n: VoxelNoise, x: number, y: number, freq: number): number {
  return 300 * n.fbm2(x, y, 0.002 * freq, 7);
}
export function multiDensity(n: VoxelNoise, x: number, y: number, z: number, freq: number): number {
  // 标准 SDF 约定：z - h
  return z - multiHeight(n, x, y, freq);
}

/* ----- 7. VoxelExample_IQNoise（高度场 → 薄壳 SDF） -----
 * 原公式：h = 500·iq2(X, Y, 0.001·f, 15)   (15 octave IQ 域旋转)
 * 高频 IQ 噪声主导——棱角山脉（与 VoxelExample_Cliffs 不同的是无台地过渡）。
 * 包成 SDF：d = z - h；Z 范围 ≈ [-600, 600]。
 */
export function iqHeight(n: VoxelNoise, x: number, y: number, freq: number): number {
  return 500 * n.iq2(x, y, 0.001 * freq, 15);
}
export function iqDensity(n: VoxelNoise, x: number, y: number, z: number, freq: number): number {
  // 标准 SDF 约定：z - h
  return z - iqHeight(n, x, y, freq);
}

/* =====================================================================
 * C. 混合算法（Hybrid 1~6）
 *    把 A 类的 1~7 算子按 B 类的区域掩码加权混合，形成新的 SDF 公式。
 *    每种混合都返回单一 density，可在同一条 Marching Tetrahedra 管线里采样。
 *    设计原则：两个算子在各自「优势区域」主导，区域边界用 smoothUnion/SInter
 *    平滑过渡，避免硬边。所有混合共享同一份 5 区域掩码。
 * ===================================================================== */

/* ----- Hybrid 1: Dunes-on-Cliffs（沙丘骑在台地上） -----
 * cliffsHeight 提供主体高度（台地），dunesHeight 在 cliffMask 之外的区域叠加
 * 沙丘。SInter(dC, dD, 30) 让台地边缘到沙丘的过渡变缓（k=30 单位）。
 *
 * 关键：SDF = z - h（实体 z < h）。SInter = max 语义 = 两边都实才实。
 * 注意：cliffsHeight 是 3D 自指型（依赖 query z），dunesHeight 是 2D 高度场。
 */
export function dunesOnCliffsDensity(
  n: VoxelNoise,
  x: number, y: number, z: number,
  freq: number,
  region: RegionParams,
  dunes: DunesParams
): number {
  const hC = cliffsHeight(n, x, y, z, freq);
  const hD = dunesHeight(n, x, y, freq, dunes);
  const dC = z - hC;
  const dD = z - hD;
  return smoothIntersection(dC, dD, 30);
}

/* ----- Hybrid 2: Cliffs+IQ（台地顶面被 IQ 噪声锯齿化） -----
 * cliffsHeight 给出台地主体，iqHeight 提供高分辨率细节（500·iq2）。
 * max(dC, dI)：要求两者都为实体（Z 在两者之下）才算实体——台地的空气区不
 * 会因为 IQ 噪声的高点而多出一块「空中浮岛」。
 * 注意：cliffsHeight 依赖 query z，传入真实 z 保持 3D 自指结构。
 */
export function cliffsPlusIQDensity(
  n: VoxelNoise,
  x: number, y: number, z: number,
  freq: number
): number {
  const hC = cliffsHeight(n, x, y, z, freq);
  const hI = iqHeight(n, x, y, freq);
  return Math.max(z - hC, z - hI);
}

/* ----- Hybrid 3: Ravine+Erosion（峡谷与侵蚀在同一噪声上双雕） -----
 * multiHeight 给基线，ravine 在高地形上挖（~100 单位），erosion 在其上加细沟。
 * 最终 SDF：先把 multi 高度减去 ravine 切深，再减去 erosion 削峰。
 */
export function ravinePlusErosionDensity(
  n: VoxelNoise,
  x: number, y: number, z: number,
  freq: number,
  seed: number
): number {
  const hM = multiHeight(n, x, y, freq);
  // Ravine：在 |perlin(X·0.008·f, Y·0.008·f)| 的高值处下切
  const ravN = 1 - Math.abs(n.perlin2(x * 0.008 * freq, y * 0.008 * freq) as number);
  const ravCarve = Math.pow(smoothstep01(0.68, 0.94, ravN), 2) * 100;
  const hAfterRav = hM - ravCarve;
  // Erosion：在 fbm2 高频处微削
  const eN = n.fbm2(x * 0.016 * freq, y * 0.016 * freq, 1, 5);
  const hFinal = hAfterRav - 20 * (eN * 0.5 + 0.5);
  // 标准 SDF 约定：z - h
  return z - hFinal;
}

/* ----- Hybrid 4: Erosion+Multi（侵蚀噪声与多频 FBM 相加） -----
 * multiHeight + erosionHeight 共同构成表面。SUnion 让二者高度不同时平滑过渡。
 */
export function erosionPlusMultiDensity(
  n: VoxelNoise,
  x: number, y: number, z: number,
  freq: number,
  seed: number
): number {
  const hM = multiHeight(n, x, y, freq);
  const hE = erosionHeight(n, x, y, freq, seed);
  return smoothUnion(z - hM, z - hE, 40);
}

/* ----- Hybrid 5: IQ+Ravine（IQ 山脊 + 峡谷切割） -----
 * iqHeight 主导山脊，ravine 切出深谷。max 让山脊只在 IQ 噪声高的区域出现。
 */
export function iqPlusRavineDensity(
  n: VoxelNoise,
  x: number, y: number, z: number,
  freq: number
): number {
  const hI = iqHeight(n, x, y, freq);
  const ravN = 1 - Math.abs(n.perlin2(x * 0.008 * freq, y * 0.008 * freq) as number);
  const ravCarve = Math.pow(smoothstep01(0.68, 0.94, ravN), 2) * 200;
  const hFinal = Math.max(hI - ravCarve, -200);
  // 标准 SDF 约定：z - h
  return z - hFinal;
}

/* ----- Hybrid 6: 区域驱动混合（5 区域 × 5 算子 = 全域合成） -----
 * 这是 TerrainLab model.ts sampleSurface 的 SDF 化重写——
 * 不再用 1 个 height 公式 + 区域 mask 替换，而把每个区域的算子按区域掩码
 * 加权 SUnion，形成单一 density 公式。这样 CaveLab 的 marching tetrahedra
 * 一次性采样完整地形（含悬空面与底面下挖）。
 *
 *   hA (avg) = cliffsHeight              // 区域 A 主体：台地
 *   hB (dune) = dunesHeight              // 区域 B 沙丘
 *   hC (rav)  = multiHeight - ravCarve   // 区域 C 峡谷
 *   hD (ero)  = erosionHeight            // 区域 D 侵蚀
 *   hE (iq)   = iqHeight                 // 区域 E IQ 山脊
 *
 * 每个区域的 density：d_i = z - h_i  （z < h → d < 0 → 实体；z > h → d > 0 → 空气）
 * 最终 density：SUnion(SUnion(SUnion(dA, dB, k=20), SUnion(dC, dD, k=20), k=20), dE, k=20)
 * 其中 k=20 让区域边界 20 单位宽的过渡带，避免硬边锯齿。
 */
export function regionDrivenDensity(
  n: VoxelNoise,
  x: number, y: number, z: number,
  freq: number,
  seed: number,
  region: RegionParams = DEFAULT_REGION_PARAMS,
  dunes: DunesParams = DEFAULT_DUNES_PARAMS
): number {
  const r = regionMasks(n, x, y, region);
  // 主体高度（背景）：多频 FBM 避免单一算子大区主导
  const hBack = multiHeight(n, x, y, freq) * 0.35;
  // 各区域算子的「增强高度」（只在区域掩码 > 0 时才有意义）
  // 注意：cliffsHeight 依赖 query z（3D 自指型），传入 z 保持原算法
  const hCliff = cliffsHeight(n, x, y, z, freq);
  const hDune = dunesHeight(n, x, y, freq, dunes);
  const hEro = erosionHeight(n, x, y, freq, seed);
  const hIq = iqHeight(n, x, y, freq);
  // 峡谷切深（直接作用在背景上，与区域无关）
  const ravN = 1 - Math.abs(n.perlin2(x * 0.008 * freq, y * 0.008 * freq) as number);
  const ravCarve = Math.pow(smoothstep01(0.68, 0.94, ravN), 2) * 120;
  const hBackRav = hBack - ravCarve;

  // 区域密度：算子贡献 = mask·(z - h)，背景永远存在
  const dBack = z - hBackRav;
  const dCliff = smoothUnion(dBack, z - hCliff, 20) * (1 - r.cliffMask) + (z - hCliff) * r.cliffMask;
  const dDune = smoothUnion(dBack, z - hDune, 15) * (1 - r.duneMask) + (z - hDune) * r.duneMask;
  const dEro = smoothUnion(dBack, z - hEro, 25) * (1 - r.eroMask) + (z - hEro) * r.eroMask;
  const dIq = smoothUnion(dBack, z - hIq, 30) * (1 - r.iqMask) + (z - hIq) * r.iqMask;
  // 4 算子 SUnion
  const dA = smoothUnion(dCliff, dDune, 25);
  const dB = smoothUnion(dEro, dIq, 25);
  return smoothUnion(dA, dB, 25);
}

/* =====================================================================
 * 模式元数据（每个模式的 Z 采样范围、标题、公式注释）
 * ===================================================================== */

export type ExampleMode =
  | "cliffs"
  | "dunes"
  | "cave"
  | "ravines"
  | "erosion"
  | "multi"
  | "iq"
  | "dunes_on_cliffs"
  | "cliffs_plus_iq"
  | "ravine_plus_erosion"
  | "erosion_plus_multi"
  | "iq_plus_ravine"
  | "region_driven";

export interface ModeSpec {
  id: ExampleMode;
  /** 序号 1~13（与 mountain_terrain_demo (2).html 的编号延续：1~7 原始 + 8~13 混合） */
  n: number;
  /** UI 短标题 */
  short: string;
  /** 完整标题（用于菜单） */
  title: string;
  /** Z 采样范围（体素单位） */
  zRange: [number, number];
  /** 公式注释（多行） */
  formula: string;
  /** 是否需要 seed（Erosion 系需要） */
  needsSeed?: boolean;
  /** 是否使用 DunesParams（风向量） */
  needsDunes?: boolean;
  /** Cave/Ravines 是体 SDF；其它可视为薄壳（height 公式 - Z） */
  isVolumetric: boolean;
}

export const MODE_SPECS: ModeSpec[] = [
  {
    id: "cliffs", n: 1, short: "Cliffs", title: "1 · VoxelExample_Cliffs（台地悬崖）",
    zRange: [-15, 90], isVolumetric: false,
    formula:
      `sides = Perlin2(X·0.1·f, Y·0.1·f, off=1)\np     = clamp((Z/50 + 0.2·sides)·10, 0, 1)  ← 显式依赖 Z\ntop   = IQ2(X, Y, 0.01·f, 15)·25\nh     = p·(50 + top)                (h 依赖 Z：3D 自指型 SDF)\nvalue = Z - h  (Z<h 为实体)\n· sides > 0.5: p≡1，h≡50+top，平台顶面 z=50+top\n· sides < 0:   p=z/5+2sides 线性，0→1 在 z∈[-10sides, 50-10sides]\n  形成 z=0 与 z=50+top 两个等值面 + 中间实体（=崖体）\n· 0<sides<0.5: 过渡区，p 在 z=50(0.5-sides) 处封 1，全程 solid\nmarching 找到 2 个零交叉 = 阶梯顶面 + 阶梯侧面（=崖壁）`,
  },
  {
    id: "dunes", n: 2, short: "Dunes", title: "2 · VG_Example_Dunes（沙丘）",
    zRange: [-180, 40], isVolumetric: false, needsDunes: true,
    formula:
      `phase = FBM2(X, Y, 0.001·f, 3) + 0.002·(X·dx + Y·dy)·f\nh     = -75·|sin(π·phase)|\nvalue = Z - h  (薄壳 SDF，Z<h 为实体)\n风向 (dx, dy) 决定沙丘脊线方向`,
  },
  {
    id: "cave", n: 3, short: "Cave", title: "3 · VoxelExample_Cave（洞穴）",
    zRange: [-320, 520], isVolumetric: true,
    formula:
      `top    = FBM2(X, Y, 0.005·f, 3)·150\nbot    = FBM2(X+391, Y-71, 0.008·f, 3)·150\ntube   = 400 - |XY|\nband   = SUnion(top-Z, Z-bot, 25) + 50\nglobal = IQ2(X, Y, 0.005·f, 15)·200 + 150\nvalue  = SInter(Z-global, SUnion(tube, band, 100), 15)\n体内 d>0 = 空气（洞穴空腔），d<0 = 实体（岩石）`,
  },
  {
    id: "ravines", n: 4, short: "Ravines", title: "4 · VoxelExample_Ravines（峡谷）",
    zRange: [-120, 80], isVolumetric: true,
    formula:
      `f    = 0.02·f\np    = Perlin3(X·f, Y·f, Z·f, oct=1)\ntop  = SInter(Z, 5·p, 5)\nvalue = SUnion(Z+50, top, 5)\n体内 d>0 = 空气（峡谷开口），d<0 = 实体（岩壁）`,
  },
  {
    id: "erosion", n: 5, short: "Erosion", title: "5 · VG_Example_Erosion（侵蚀）",
    zRange: [-180, 700], isVolumetric: false, needsSeed: true,
    formula:
      `q = FBM2D(X, Y, 0.001·f, 3)            (val + ∇)\nw = smoothstep(-0.5, 0, q[0])\ne = ErosionNoise(X, Y, 0.02·f, 5)        (5×5 流向核)\nh = 500·(q[0] + 0.008·e·w)\nvalue = Z - h  (薄壳 SDF，Z<h 为实体)`,
  },
  {
    id: "multi", n: 6, short: "Multi", title: "6 · VG_Example_MultiIndex（多频 FBM）",
    zRange: [-400, 400], isVolumetric: false,
    formula:
      `h = 300·FBM2(X, Y, 0.002·f, 7)        (7 oct FBM)\nvalue = Z - h  (薄壳 SDF，Z<h 为实体)`,
  },
  {
    id: "iq", n: 7, short: "IQ", title: "7 · VoxelExample_IQNoise（IQ 域旋转）",
    zRange: [-650, 650], isVolumetric: false,
    formula:
      `h = 500·IQ2(X, Y, 0.001·f, 15)        (15 oct, 40° 域旋转)\nvalue = Z - h  (薄壳 SDF，Z<h 为实体)`,
  },
  {
    id: "dunes_on_cliffs", n: 8, short: "Dunes∩Cliffs", title: "8 · Hybrid · Dunes-on-Cliffs（台地+沙丘）",
    zRange: [-180, 130], isVolumetric: false, needsDunes: true,
    formula:
      `dC = Z - cliffsHeight(X, Y)\ndD = Z - dunesHeight(X, Y)\nvalue = SInter(dC, dD, 30)\n台地 + 沙丘 SInter：只在两者都实的地方为实，\n边界 k=30 平滑过渡`,
  },
  {
    id: "cliffs_plus_iq", n: 9, short: "Cliffs∪IQ", title: "9 · Hybrid · Cliffs+IQ（台地+IQ 锯齿）",
    zRange: [-650, 650], isVolumetric: false,
    formula:
      `dC = Z - cliffsHeight(X, Y)\ndI = Z - iqHeight(X, Y)\nvalue = max(dC, dI)  (Intersection)\n台地主体 + IQ 噪声山脊交集\n= 两者都实才算实，IQ 高点不会成为空中浮岛`,
  },
  {
    id: "ravine_plus_erosion", n: 10, short: "Rav∩Ero", title: "10 · Hybrid · Ravine+Erosion（峡谷+侵蚀）",
    zRange: [-400, 400], isVolumetric: false, needsSeed: true,
    formula:
      `hM = multiHeight(X, Y)                 (Multi 基线)\nrav = pow(smoothstep(0.68, 0.94, |perlin|), 2)·100\nh   = hM - rav - 20·fbm2(X·0.016·f, Y·0.016·f, 5)\nvalue = Z - h  (薄壳 SDF，Z<h 为实体)`,
  },
  {
    id: "erosion_plus_multi", n: 11, short: "Ero∪Multi", title: "11 · Hybrid · Erosion+Multi（侵蚀+多频）",
    zRange: [-400, 700], isVolumetric: false, needsSeed: true,
    formula:
      `hM = multiHeight(X, Y)\nhE = erosionHeight(X, Y, seed)\nvalue = SUnion(Z - hM, Z - hE, 40)\n两高度场 SUnion：选较高者，k=40 平滑过渡`,
  },
  {
    id: "iq_plus_ravine", n: 12, short: "IQ∩Ravine", title: "12 · Hybrid · IQ+Ravine（IQ 山脊+峡谷）",
    zRange: [-650, 650], isVolumetric: false,
    formula:
      `hI = iqHeight(X, Y)\nrav = pow(smoothstep(0.68, 0.94, |perlin|), 2)·200\nh   = max(hI - rav, -200)\nvalue = Z - h  (薄壳 SDF，Z<h 为实体)\nIQ 主导山脊，ravine 在高值处下切`,
  },
  {
    id: "region_driven", n: 13, short: "RegionDriven", title: "13 · Hybrid · RegionDriven（5 区域合成）",
    zRange: [-650, 700], isVolumetric: false, needsSeed: true, needsDunes: true,
    formula:
      `5 个 fbm2 smoothstep 区域掩码 × 5 算子：\n  dune / cliff / rav / erosion / iq\n每个算子按对应掩码加权 SUnion 到背景上\n  (k=15~30 平滑过渡)\nTerrainLab model.ts 区域合成逻辑的 SDF 化重写`,
  },
];

export const MODE_BY_ID: Record<ExampleMode, ModeSpec> = Object.fromEntries(
  MODE_SPECS.map((s) => [s.id, s])
) as Record<ExampleMode, ModeSpec>;

/* =====================================================================
 * 统一入口：mode + (x, y, z) → density
 *   - 体示例（Cave/Ravines）：调用原体公式
 *   - 高度场示例：返回 h - Z（薄壳 SDF）
 *   - 混合示例：按各自混合公式
 * ===================================================================== */
export function exampleDensity(
  mode: ExampleMode,
  n: VoxelNoise,
  x: number, y: number, z: number,
  freq: number,
  opts: {
    seed?: number;
    dunes?: DunesParams;
    region?: RegionParams;
  } = {}
): number {
  switch (mode) {
    case "cliffs":            return cliffsDensity(n, x, y, z, freq);
    case "dunes":             return dunesDensity(n, x, y, z, freq, opts.dunes);
    case "cave":              return caveDensity(z, caveColumn(n, x, y, freq));
    case "ravines":           return ravinesDensity(n, x, y, z, freq);
    case "erosion":           return erosionDensity(n, x, y, z, freq, opts.seed ?? 0);
    case "multi":             return multiDensity(n, x, y, z, freq);
    case "iq":                return iqDensity(n, x, y, z, freq);
    case "dunes_on_cliffs":   return dunesOnCliffsDensity(n, x, y, z, freq, opts.region ?? DEFAULT_REGION_PARAMS, opts.dunes ?? DEFAULT_DUNES_PARAMS);
    case "cliffs_plus_iq":    return cliffsPlusIQDensity(n, x, y, z, freq);
    case "ravine_plus_erosion": return ravinePlusErosionDensity(n, x, y, z, freq, opts.seed ?? 0);
    case "erosion_plus_multi": return erosionPlusMultiDensity(n, x, y, z, freq, opts.seed ?? 0);
    case "iq_plus_ravine":    return iqPlusRavineDensity(n, x, y, z, freq);
    case "region_driven":     return regionDrivenDensity(n, x, y, z, freq, opts.seed ?? 0, opts.region, opts.dunes);
  }
}
