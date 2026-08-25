import { NoiseLib, clamp, smoothstep } from "./noise";
import type { TerrainParams } from "./params";

export interface RegionMasks {
  duneMask: number;
  cliffMask: number;
  ravMask: number;
  eroMask: number;
  iqMask: number;
}

export interface SurfaceSample {
  h: number;
  riverMask: number;
  regions: RegionMasks;
  regionMax: number;
  landMask: number;
  mountainMask: number;
}

type BlockType = "alpine" | "hilly" | "plains" | "marine";

interface Peak {
  /** 山峰相对区块中心的偏移（米） */
  ox: number;
  oy: number;
  /** 山峰的绝对高度加成（米），在基底之上 */
  height: number;
  /** 影响半径（米） */
  radius: number;
  /** 形状指数，0=平缓圆锥，越大越尖 */
  sharpness: number;
}

interface Supercell {
  bx: number;
  by: number;
  type: BlockType;
  /** 区块中心的世界坐标 */
  cx: number;
  cy: number;
  /** 区块基底海拔（米） */
  baseElev: number;
  /** 主峰列表（0-2 个） */
  mainPeaks: Peak[];
  /** 次级山峰列表 */
  subPeaks: Peak[];
  /** 区块内的整体抬升/下压倾向（海盆用） */
  bias: number;
}

/** 双三次核：用于区块间的柔和权重混合 */
function bicubicKernel(t: number): number {
  const x = Math.abs(t);
  if (x <= 1) return 1.5 * x * x * x - 2.5 * x * x + 1;
  if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
  return 0;
}

/** 径向山峰衰减函数（圆锥 + 指数软化）：d=0 时=1，d>=radius 时=0 */
function peakFalloff(d: number, radius: number, sharpness: number): number {
  if (d >= radius) return 0;
  const t = 1 - d / radius;
  // 基础圆锥形状，用 sharpness 控制峰值集中度
  const s = 1 + sharpness * 2;
  const core = Math.pow(t, s);
  // 边缘平滑过渡（避免山脚硬切）
  const skirt = smoothstep(radius, radius * 0.25, d);
  return core * 0.78 + skirt * 0.22;
}

/** 将 (bx,by,seed) 混合成 32 位确定性哈希 → 用作 RNG 种子 */
function hashCell(bx: number, by: number, seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (bx | 0), 2654435761);
  h = Math.imul(h ^ (by | 0), 1597334677);
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 小型确定性 PRNG（mulberry32），从哈希种子生成序列 */
function makeRng(state: number) {
  let s = state >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TerrainModel {
  p: TerrainParams;
  noise: NoiseLib;
  sea = 0;
  k: number;
  M: number;
  private cellSize: number;
  private cellCache: Map<string, Supercell>;

  constructor(params: TerrainParams) {
    this.p = params;
    this.noise = new NoiseLib(params.seed);
    this.k = params.freqScale / 6.0;
    this.M = Math.max(1, params.maxMountain * params.verticalScale);
    this.cellSize = Math.max(200, params.supercellSize);
    this.cellCache = new Map();
  }

  /** 获取指定区块坐标的属性（缓存） */
  private getSupercell(bx: number, by: number): Supercell {
    const key = bx + "," + by;
    const cached = this.cellCache.get(key);
    if (cached) return cached;
    const cell = this.buildSupercell(bx, by);
    if (this.cellCache.size > 512) {
      // 简单 LRU：溢出时清空一半旧缓存
      const keys = Array.from(this.cellCache.keys()).slice(0, 256);
      for (const k of keys) this.cellCache.delete(k);
    }
    this.cellCache.set(key, cell);
    return cell;
  }

  private buildSupercell(bx: number, by: number): Supercell {
    const P = this.p;
    const M = this.M;
    const size = this.cellSize;
    const cx = (bx + 0.5) * size;
    const cy = (by + 0.5) * size;

    const rng = makeRng(hashCell(bx, by, P.seed));
    const r1 = rng(); // 用于区块类型判定
    const r2 = rng();

    // ---- 区块类型判定 ----
    // 用低频噪声让同类型区块成簇出现，避免棋盘格
    const clusterN = this.noise.fbm2(bx * 0.27 + 911, by * 0.27 - 413, 3);
    const clusterT = clusterN * 0.5 + 0.5; // [0,1]
    // marine 概率、plains 概率：根据 clusterT 调制，让同类型成片
    const marineP = clamp(P.marineBlockProb * (0.5 + clusterT), 0, 0.85);
    const plainsP = clamp(P.plainsBlockProb * (1.0 - Math.abs(clusterT - 0.5) * 1.2), 0, 0.85);

    let type: BlockType;
    const accum = r1;
    if (accum < marineP * 0.5 + clusterT * marineP * 0.5) {
      type = "marine";
    } else if (accum < marineP + plainsP * 0.7) {
      type = "plains";
    } else if (accum < marineP + plainsP + 0.18) {
      type = "hilly";
    } else {
      type = "alpine";
    }

    // ---- 基底海拔 & bias ----
    let baseElev = 0;
    let bias = 0;
    switch (type) {
      case "marine": {
        // 海盆：中心更低，边缘有大陆架抬升
        const basinDepth = -M * P.oceanDepthMult * (0.55 + rng() * 0.9);
        baseElev = basinDepth;
        bias = basinDepth * 0.8;
        break;
      }
      case "plains": {
        // 平原：略高于海面，起伏极小
        baseElev = M * 0.02 + rng() * M * P.plainsReliefMult;
        bias = 0;
        break;
      }
      case "hilly": {
        baseElev = M * 0.06 + rng() * M * 0.1;
        bias = M * 0.04;
        break;
      }
      case "alpine": {
        baseElev = M * 0.1 + rng() * M * 0.15;
        bias = M * 0.08;
        break;
      }
    }

    // ---- 生成山峰 ----
    const mainPeaks: Peak[] = [];
    const subPeaks: Peak[] = [];
    const mainRadius = size * P.peakRadiusMult;

    if (type === "alpine") {
      // 1-2 个主峰
      const mainCount = rng() < 0.55 ? 1 : 2;
      for (let i = 0; i < mainCount; i++) {
        const mainH = M * P.peakHeightMult * (0.78 + rng() * 0.44); // 主峰：0.78M~1.22M × mult
        const ox = (rng() - 0.5) * size * 0.6;
        const oy = (rng() - 0.5) * size * 0.6;
        mainPeaks.push({
          ox,
          oy,
          height: mainH,
          radius: mainRadius * (0.75 + rng() * 0.45),
          sharpness: 0.4 + rng() * 0.8,
        });
      }
      // 次级山峰
      const subCount = P.secondaryPeakCount;
      for (let i = 0; i < subCount; i++) {
        // 倾向于分布在主峰周围的环形区域
        let sx: number, sy: number;
        if (mainPeaks.length > 0 && rng() < 0.65) {
          const anchor = mainPeaks[Math.floor(rng() * mainPeaks.length)];
          const ang = rng() * Math.PI * 2;
          const ringR = mainRadius * (0.3 + rng() * 0.55);
          sx = anchor.ox + Math.cos(ang) * ringR;
          sy = anchor.oy + Math.sin(ang) * ringR;
        } else {
          sx = (rng() - 0.5) * size * 0.9;
          sy = (rng() - 0.5) * size * 0.9;
        }
        // 高度为主峰最高值的 0.1 ~ secondaryPeakMax 比例
        const mainHRef = mainPeaks.length ? Math.max(...mainPeaks.map((p) => p.height)) : M;
        const subH = mainHRef * (0.1 + rng() * (P.secondaryPeakMax - 0.08));
        subPeaks.push({
          ox: sx,
          oy: sy,
          height: subH,
          radius: size * (0.15 + rng() * 0.25),
          sharpness: 0.1 + rng() * 0.5,
        });
      }
    } else if (type === "hilly") {
      // 丘陵区：无主峰，只有矮峰
      const subCount = Math.max(2, Math.floor(P.secondaryPeakCount * 0.6));
      for (let i = 0; i < subCount; i++) {
        const sx = (rng() - 0.5) * size * 0.85;
        const sy = (rng() - 0.5) * size * 0.85;
        const subH = M * (0.08 + rng() * P.secondaryPeakMax * 0.7);
        subPeaks.push({
          ox: sx,
          oy: sy,
          height: subH,
          radius: size * (0.18 + rng() * 0.22),
          sharpness: 0.05 + rng() * 0.3,
        });
      }
    } else if (type === "plains") {
      // 平原：0-2 个零星孤丘
      if (rng() < 0.45) {
        const cx2 = (rng() - 0.5) * size * 0.7;
        const cy2 = (rng() - 0.5) * size * 0.7;
        subPeaks.push({
          ox: cx2,
          oy: cy2,
          height: M * (0.04 + rng() * 0.08),
          radius: size * (0.1 + rng() * 0.12),
          sharpness: 0.02 + rng() * 0.15,
        });
      }
    } else if (type === "marine") {
      // 海洋：偶尔生成海底山（海山），顶部是负偏
      if (rng() < 0.35) {
        const cx2 = (rng() - 0.5) * size * 0.7;
        const cy2 = (rng() - 0.5) * size * 0.7;
        subPeaks.push({
          ox: cx2,
          oy: cy2,
          height: M * (0.15 + rng() * 0.35), // 海山高度，从海盆向上抬升
          radius: size * (0.2 + rng() * 0.25),
          sharpness: 0.15 + rng() * 0.35,
        });
      }
    }

    return { bx, by, type, cx, cy, baseElev, mainPeaks, subPeaks, bias };
  }

  /** 对某个采样点，累加单个区块的高度贡献 + 权重 */
  private evalCell(
    sx: number,
    sy: number,
    bx: number,
    by: number,
    fx: number,
    fy: number
  ): { elev: number; weight: number; mountainness: number } {
    const cell = this.getSupercell(bx, by);
    const size = this.cellSize;

    // 相对区块中心的距离
    const dx = sx - cell.cx;
    const dy = sy - cell.cy;

    // 1) 基底海拔 + bias（根据距中心距离做柔和的"碗"形调制，marine 用）
    let elev = cell.baseElev;
    const distC = Math.hypot(dx, dy);
    if (cell.type === "marine") {
      // 海盆在区块中心最低，边缘抬升成大陆架
      const bowl = smoothstep(size * 0.9, size * 0.1, distC);
      elev = cell.baseElev * (0.25 + bowl * 0.75) + this.M * 0.05 * (1 - bowl);
    } else if (cell.type === "plains") {
      // 平原内部保持平缓
      const flatness = smoothstep(size * 0.6, size * 0.05, distC);
      elev = cell.baseElev * (0.7 + flatness * 0.3);
    }

    // 2) 山峰贡献（主峰 + 次峰）
    let mountainness = 0;
    for (const pk of cell.mainPeaks) {
      const d = Math.hypot(dx - pk.ox, dy - pk.oy);
      const f = peakFalloff(d, pk.radius, pk.sharpness);
      elev += pk.height * f;
      mountainness = Math.max(mountainness, f);
    }
    for (const pk of cell.subPeaks) {
      const d = Math.hypot(dx - pk.ox, dy - pk.oy);
      const f = peakFalloff(d, pk.radius, pk.sharpness);
      elev += pk.height * f;
      mountainness = Math.max(mountainness, f * 0.6);
    }

    // 3) 区块权重：双三次核 × supercellBlend 过渡控制
    const br = 1.0 + this.p.supercellBlend * 1.0; // 核半径 1~2
    const wx = bicubicKernel(fx * br);
    const wy = bicubicKernel(fy * br);
    const weight = wx * wy;

    return { elev, weight, mountainness };
  }

  /** 计算超级区块系统对该采样点的宏观高度 + 山形掩码 */
  private supercellHeight(sx: number, sy: number): { h: number; mountainness: number; isMarine: number } {
    const size = this.cellSize;
    const bx = Math.floor(sx / size);
    const by = Math.floor(sy / size);

    let sumH = 0;
    let sumW = 0;
    let maxMount = 0;
    let marineAccum = 0;

    // 3×3 邻接区块的加权混合
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nbx = bx + dx;
        const nby = by + dy;
        // 采样点在当前邻居区块坐标系的归一化位置（区块中心 = 0，边界 = ±0.5）
        const cellCx = (nbx + 0.5) * size;
        const cellCy = (nby + 0.5) * size;
        const fx = (sx - cellCx) / size; // 范围约 [-0.5, 0.5]，跨区时更大
        const fy = (sy - cellCy) / size;
        const r = this.evalCell(sx, sy, nbx, nby, fx, fy);
        if (r.weight <= 0) continue;
        sumH += r.elev * r.weight;
        sumW += r.weight;
        maxMount = Math.max(maxMount, r.mountainness * r.weight);
        // 判断区块类型是否 marine，用于后续深海判定
        const cell = this.getSupercell(nbx, nby);
        if (cell.type === "marine") marineAccum += r.weight;
      }
    }

    const h = sumW > 1e-6 ? sumH / sumW : 0;
    const mountainness = sumW > 1e-6 ? maxMount / sumW : 0;
    const isMarine = sumW > 1e-6 ? clamp(marineAccum / sumW, 0, 1) : 0;
    return { h, mountainness, isMarine };
  }

  /** 低频连续噪声 → 跨多个 Tile 的有机区域掩码 */
  regionMasks(u: number, v: number): RegionMasks {
    const rs = this.p.regionScale;
    const th = this.p.regionThreshold;
    const N = this.noise;

    const duneN = N.fbm2(u * rs + 10.7, v * rs + 42.3, 3);
    const cliffN = N.fbm2(u * rs + 137.5, v * rs + 258.9, 3);
    const ravN = N.fbm2(u * rs + 391.2, v * rs + 487.6, 3);
    const eroN = N.fbm2(u * rs + 523.8, v * rs + 614.1, 3);
    const iqN = N.fbm2(u * rs + 789.3, v * rs + 856.7, 3);

    return {
      duneMask: smoothstep(th, th + 0.2, duneN) * this.p.sDune,
      cliffMask: smoothstep(th, th + 0.2, cliffN) * this.p.sCliff,
      ravMask: smoothstep(th, th + 0.2, ravN) * this.p.sRavine,
      eroMask: smoothstep(th, th + 0.2, eroN) * this.p.sErosion,
      iqMask: smoothstep(th, th + 0.2, iqN) * this.p.sIQ,
    };
  }

  sampleSurface(sx: number, sy: number): SurfaceSample {
    const P = this.p;
    const N = this.noise;
    const M = Math.max(1, this.M);
    const k = this.k;
    const sea = this.sea;
    const u = sx * k;
    const v = sy * k;

    // Domain warp（保留）
    const warpAmp = 90 * P.warp;
    const w1 = N.fbm2(u * 0.0021 + 13.7, v * 0.0021 + 71.3, 3) * warpAmp;
    const w2 = N.fbm2(u * 0.0021 - 31.7, v * 0.0021 + 17.9, 3) * warpAmp;
    const uu = u + w1;
    const vv = v + w2;

    // ===== 新的宏观骨架：超级区块系统 =====
    const sc = this.supercellHeight(sx, sy);
    // 宏观基底 + 山脉骨架（主峰鹤立鸡群、次峰环绕、大块平原/海盆）
    let h = sc.h;
    // 从 supercell 推导出的"山区掩码"（用于后续细节叠加控制）
    let mountainMask = clamp(sc.mountainness, 0, 1);
    // 大陆/海洋掩码（marine 区块占主导时视为海洋区）
    const continentFromSC = 1 - smoothstep(0.35, 0.75, sc.isMarine);

    // ===== 原有细节层：作为骨架上的"纹理"，不再决定宏观形状 =====
    // 低频大陆基底（用来给非山区的陆地一个轻微抬升，与 supercell 叠加但权重低）
    const baseN = N.fbm2(uu * 0.00105, vv * 0.00105, 5);
    const lowBase = baseN * M * 0.06;
    // 与 supercell 推导出的 continent 掩码对齐
    const continentMask = smoothstep(0.35, 0.65, continentFromSC * 0.5 + baseN * 0.25 + 0.25);
    h += lowBase * (1 - mountainMask * 0.7);

    // Belt & Ridge（现在只作为山脉表面的"微褶皱"，不再拔高大范围高度）
    const beltFreq = 0.0012 * P.belts;
    const bn1 = 1 - Math.abs(N.perlin2(uu * beltFreq, vv * beltFreq));
    const bn2 = 1 - Math.abs(N.perlin2(uu * beltFreq * 2.17 + 100, vv * beltFreq * 2.17 - 50));
    const beltN = Math.max(bn1, bn2 * 0.7);
    const belt = Math.pow(smoothstep(1 - clamp(P.beltWidth, 0.08, 0.95), 1, beltN), 1.55);
    // 用 supercell 的 mountainness 门控：只在已经有山峰的地方叠加 belt 纹理
    mountainMask = Math.max(mountainMask, belt * continentMask * 0.35);
    mountainMask = clamp(mountainMask, 0, 1);

    const eroBase = clamp(P.mountainErosion * 0.9, 0, 1);
    const sharp = N.ridged2(uu * 0.0082, vv * 0.0082, 6);
    const blunt = N.fbm2(uu * 0.0055, vv * 0.0055, 4) * 0.5 + 0.5;
    let ridge = sharp;
    const peakBlend = clamp(eroBase * 1.25, 0, 1) * smoothstep(0.18, 0.78, sharp);
    ridge = ridge * (1 - peakBlend) + blunt * peakBlend;
    ridge = Math.pow(clamp(ridge, 0, 1), 2.2 - 1.65 * clamp(eroBase, 0, 1));
    // ! 关键改动：ridged 现在只是给山峰叠加表面纹理，高度上限是 M*0.12 而不是 M
    // 这样主峰的绝对高度由 supercell 决定，ridged 只是增加山脊质感
    let detailMountainH = M * 0.12 * mountainMask * ridge;
    const roundedMountain = M * 0.1 * mountainMask * blunt * 0.78;
    const highMask = smoothstep(0.4, 0.92, mountainMask);
    const roundBlend = clamp(eroBase * highMask * 0.85, 0, 1);
    detailMountainH = detailMountainH * (1 - roundBlend) + roundedMountain * roundBlend;
    h += detailMountainH;

    // landMask：supercell 高度 > sea 或非 marine 区块
    const landMask = smoothstep(sea - 1, sea + M * 0.02, h) * continentMask +
      smoothstep(sea, sea + 5, h) * (1 - continentMask) * 0.3;

    // ===== 河流（保留逻辑，用 mountainMask 限制河流不出现在最高峰） =====
    let riverMask = 0;
    if (P.riverStrength > 0) {
      const riverWarp = N.fbm2(u * 0.004 + 90, v * 0.004 - 70, 2) * 70 * P.warp;
      const rn = 1 - Math.abs(N.perlin2((uu + riverWarp) * 0.0046, (vv - riverWarp) * 0.0046));
      const widthMod = 0.72 + 0.55 * N.perlin1((u + v) * 0.004);
      const threshold = clamp(0.978 - 0.022 * clamp(P.riverWidth, 0, 3) * widthMod, 0.88, 0.995);
      riverMask = clamp(
        smoothstep(threshold, threshold + 0.02, rn) *
          clamp(P.riverStrength, 0, 3) *
          landMask *
          (1 - smoothstep(0.55, 0.85, mountainMask)),
        0,
        1
      );
      if (riverMask > 0.001) {
        const depth = M * 0.045 + 4;
        const bed = Math.max(sea - 2.5, h - depth);
        h = h * (1 - riverMask) + bed * riverMask;
      }
    }

    // ===== 有机生物群系区域（保留，叠加纹理） =====
    const regions = this.regionMasks(u, v);

    // --- Dunes 沙丘 ---
    if (regions.duneMask > 0.01) {
      const dx = 1;
      const dz = 0.3;
      const wl = Math.hypot(dx, dz);
      const ddx = dx / wl;
      const ddz = dz / wl;
      const phase = N.fbm2(u * 0.003, v * 0.003, 3) * 2 + (u * ddx + v * ddz) * 0.008;
      const duneWave = Math.abs(Math.sin(Math.PI * phase));
      const ripple = Math.abs(Math.sin((u * ddx + v * ddz) * 0.05 + N.perlin1(u * 0.02) * 3)) * M * 0.012;
      const duneH = M * 0.06 + M * 0.1 * (1 - duneWave) + ripple;
      const dm = clamp(regions.duneMask, 0, 1) * landMask;
      h = h * (1 - dm) + duneH * dm;
    }

    // --- Cliffs 悬崖 ---
    if (regions.cliffMask > 0.01) {
      const cliffBase = N.fbm2(uu * 0.005, vv * 0.005, 3);
      const stepCount = 5;
      const stepped = Math.floor(clamp(cliffBase * 0.5 + 0.5, 0, 1) * stepCount) / stepCount;
      const topDetail = N.ridged2(u * 0.015, v * 0.015, 4) * M * 0.05;
      const cliffH = stepped * M * 0.3 + topDetail + M * 0.04;
      const cm = clamp(regions.cliffMask, 0, 1) * landMask;
      h = h * (1 - cm) + cliffH * cm;
    }

    // --- Ravines 峡谷 ---
    if (regions.ravMask > 0.01) {
      const ravBase = N.fbm2(uu * 0.004, vv * 0.004, 4) * M * 0.12 + M * 0.08;
      const ravN = 1 - Math.abs(N.perlin2(u * 0.008, v * 0.008));
      const ravCarve = Math.pow(smoothstep(0.7, 0.95, ravN), 2) * M * 0.22;
      const ravH = ravBase - ravCarve;
      const rm = clamp(regions.ravMask, 0, 1) * landMask;
      h = h * (1 - rm) + ravH * rm;
    }

    // --- Erosion 侵蚀 ---
    if (regions.eroMask > 0.01) {
      const eN = N.fbm2(uu * 0.003, vv * 0.003, 3);
      const valleyMask = smoothstep(-0.5, 0, eN);
      const eroDetail = N.fbm2(u * 0.015, v * 0.015, 5);
      const eroH = M * 0.12 * (eN * 0.5 + 0.5) + M * 0.02 * eroDetail * valleyMask + M * 0.02;
      const em = clamp(regions.eroMask, 0, 1) * landMask;
      h = h * (1 - em) + eroH * em;
    }

    // --- IQNoise 山脉（同样改为纹理叠加） ---
    if (regions.iqMask > 0.01) {
      const iq = N.ridged2(u * 0.004, v * 0.004, 7);
      const iqH = iq * M * 0.2 + M * 0.05;
      const im = clamp(regions.iqMask, 0, 1) * landMask;
      h = h * (1 - im) + (h + iqH * 0.6) * im * 0.4 + iqH * im * 0.6 * (1 - mountainMask);
    }

    // ===== 平原（现在由 supercell 的 plains 区块主导，这里只做最后的微调） =====
    const regionMax = Math.max(regions.duneMask, regions.cliffMask, regions.ravMask, regions.eroMask, regions.iqMask);
    // 平原条件放宽：supercell 提示非山 + 非 marine → 应用平原微起伏
    const plainsSC = smoothstep(0.22, 0.02, mountainMask) * smoothstep(0.5, 0.1, sc.isMarine);
    const plainsW = clamp((1 - regionMax) * 0.6 + plainsSC * 0.8, 0, 1) * landMask;
    if (plainsW > 0.01) {
      const plainH =
        N.fbm2(u * 0.008, v * 0.008, 4) * M * P.plainsReliefMult +
        N.perlin1((u * 0.7 + v * 0.3) * 0.012) * M * 0.01 +
        Math.max(0, h) * 0.35 +
        M * 0.02;
      h = h * (1 - plainsW) + plainH * plainsW;
    }

    // ===== 海洋下压 & 深海 =====
    if (sc.isMarine > 0.35 || h < sea) {
      // marine 区块 → 深海更明显
      const marineW = smoothstep(0.2, 0.7, sc.isMarine);
      const depthTarget = -M * P.oceanDepthMult * (0.5 + 0.5 * continentFromSC);
      const oceanN = N.fbm2(u * 0.0015 + 55, v * 0.0015 - 33, 4);
      // 海底有微小起伏
      const seafloorH = depthTarget * (0.6 + 0.4 * (oceanN * 0.5 + 0.5)) + oceanN * M * 0.02;
      const w = marineW * 0.85 + (1 - smoothstep(sea - 1, sea + 1, h)) * 0.35;
      h = h * (1 - w) + seafloorH * w;
    }

    // 防反尖刺钳制（理论上不需要，但保险）
    h = clamp(h, -M * P.oceanDepthMult * 2, M * P.peakHeightMult * 1.6);

    return { h, riverMask, regions, regionMax, landMask, mountainMask };
  }

  getHeight(sx: number, sy: number) {
    return this.sampleSurface(sx, sy).h;
  }

  getDensity(sx: number, sy: number, y: number, cachedH: number | null = null) {
    const h = cachedH === null ? this.getHeight(sx, sy) : cachedH;
    return h - y;
  }
}
