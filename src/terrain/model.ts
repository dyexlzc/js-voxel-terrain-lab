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

export class TerrainModel {
  p: TerrainParams;
  noise: NoiseLib;
  sea = 0;
  k: number;
  M: number;
  /** worley2 输出缓冲（避免每采样点分配对象） */
  private wout = new Float32Array(2);

  constructor(params: TerrainParams) {
    this.p = params;
    this.noise = new NoiseLib(params.seed);
    this.k = params.freqScale / 6.0;
    this.M = params.maxMountain * params.verticalScale;
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

    // 区域尺寸（u 空间）：massifRegion 米 → Rk 个 u 单位
    const Rk = Math.max(2, P.massifRegion * k);

    // Domain warp（低频整体扭曲，扭曲量随区域尺寸缩放）
    const warpAmp = Rk * 0.33 * P.warp;
    const wf = 0.65 / Rk;
    const w1 = N.fbm2(u * wf + 13.7, v * wf + 71.3, 3) * warpAmp;
    const w2 = N.fbm2(u * wf - 31.7, v * wf + 17.9, 3) * warpAmp;
    const uu = u + w1;
    const vv = v + w2;

    // === 1. 大陆场：陆块与海洋的整体分布 ===
    // 3 个八度：限制高频陡度，保证海岸过渡带足够宽（山脉沿坡脚入海而非垂直塌陷）
    const contFreq = 1 / (Rk * 3.0);
    const contN = N.fbm2(uu * contFreq + 3.1, vv * contFreq - 7.7, 3);
    const continent = smoothstep(-0.22, 0.16, contN);

    // === 2. 主山脉区域场（Worley F1：每个区域一个主峰） ===
    const mfx = uu / Rk;
    const mfy = vv / Rk;
    N.worley2(mfx, mfy, this.wout);
    const f1 = this.wout[0];
    const ampHash = this.wout[1];

    // 每区域峰值振幅：massifDensity 控制有多少区域真正隆起（其余成为成片平原）；
    // 幂次整形让多数山脉停留在中低高度，仅个别区域的最高峰接近 Max Mountain
    const dTh = 1 - clamp(P.massifDensity, 0.05, 1);
    const ampS = smoothstep(dTh, dTh + 0.55, ampHash);
    const peakAmp = 0.06 + 0.94 * Math.pow(ampS, 1.35);

    // 主峰包络（核心区）+ 次级山脉环带 + 山麓丘陵环带，层层外扩、相互交叠。
    // 包络宽度决定峰体坡度：过窄会产生钉状尖峰（>75°），此处保证最高峰侧翼 ≈55°
    const peakEnv = 1 - smoothstep(0.12, 0.68, f1);
    const subEnv = smoothstep(0.38, 0.58, f1) * (1 - smoothstep(0.66, 0.98, f1));
    const footEnv = smoothstep(0.5, 0.78, f1) * (1 - smoothstep(0.85, 1.18, f1));

    // === 3. 山体细节 ===
    const eroBase = clamp(P.mountainErosion * 0.9, 0, 1);
    // 主山脉内部脊线（沿主峰延伸的山脊与多个峰顶）
    const mainSharp = N.ridged2(uu * (1.9 / Rk) + 5.3, vv * (1.9 / Rk) - 8.1, 3);
    const mainBlunt = N.fbm2(uu * (1.1 / Rk), vv * (1.1 / Rk), 3) * 0.5 + 0.5;
    const mainRidge = mainSharp * (1 - eroBase * 0.7) + mainBlunt * (eroBase * 0.7);
    // 次级山脉脊线（主峰周边的低矮山岭）
    const subRidge = N.ridged2(uu * (2.8 / Rk) - 12.9, vv * (2.8 / Rk) + 4.7, 4);
    // 山麓缓丘纹理
    const footN = N.fbm2(uu * (5.5 / Rk) + 21.3, vv * (5.5 / Rk) + 33.9, 3) * 0.5 + 0.5;

    // === 4. 高度分层合成 ===
    // 山脉需要坚实的陆块（沿海大陆边缘形成半岛/岛链）；门控区间足够宽，
    // 避免大陆边缘出现近垂直的山体塌陷
    const mGate = smoothstep(0.3, 0.95, continent);
    const H_main = M * peakAmp * Math.pow(peakEnv, 1.15) * (0.55 + 0.45 * mainRidge) * mGate;
    const H_sub = M * 0.34 * Math.pow(peakAmp, 1.2) * subEnv * subRidge * mGate;
    const H_foot = M * 0.085 * (0.12 + 0.88 * ampS) * footEnv * footN * smoothstep(0.15, 0.7, continent);

    // 平原基底：平缓起伏，山脉从中拔地而起
    const plainN = N.fbm2(u * 0.0035 + 41.7, v * 0.0035 - 17.3, 3);
    const plainDetail = N.fbm2(u * 0.016, v * 0.016, 2);
    const H_plain = M * (0.038 + 0.026 * plainN + 0.009 * plainDetail);

    // 海洋：大陆架 → 深海盆地（成片深水区）
    const deepN = N.fbm2(uu * (0.85 / Rk) + 77.7, vv * (0.85 / Rk) - 55.5, 3);
    const deepPow = Math.pow(smoothstep(0.05, 0.4, deepN), 1.25);
    const H_ocean = sea - M * (0.022 + 0.018 * (deepN * 0.5 + 0.5) + 0.21 * deepPow);

    let h = H_ocean * (1 - continent) + (H_plain + H_main + H_sub + H_foot) * continent;

    // 软性高度上限：仅压缩极罕见尖峰，日常峰顶分布远低于 M
    const softCeil = M * 0.94;
    if (h > softCeil) h = softCeil + (h - softCeil) * 0.22;

    const landMask = smoothstep(0.5, Math.max(6, M * 0.02), h);
    const mountainMask = clamp(peakEnv * peakAmp + subEnv * peakAmp * subRidge * 0.5, 0, 1);

    // 河流：沿平原与山谷走向入海，避开高山核心
    let riverMask = 0;
    if (P.riverStrength > 0) {
      const riverWarp = N.fbm2(u * 0.004 + 90, v * 0.004 - 70, 2) * 70 * P.warp;
      const rn = 1 - Math.abs(N.perlin2((uu + riverWarp) * 0.0046, (vv - riverWarp) * 0.0046));
      const widthMod = 0.72 + 0.55 * N.perlin1((u + v) * 0.004);
      const threshold = clamp(0.978 - 0.022 * clamp(P.riverWidth, 0, 3) * widthMod, 0.88, 0.995);
      // 过渡带加宽：让河床到岸壁呈 V 形河谷渐变，而非深槽直上直下
      riverMask = clamp(
        smoothstep(threshold, threshold + 0.09, rn) *
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

    // === 5. 有机生物群系区域（VoxelExample 地形）与主结构自然融合 ===
    const regions = this.regionMasks(u, v);
    // 山体影响度：区域地形据此避让/依附主山脉
    const mountainInfl = clamp((H_main + H_sub) / (M * 0.22), 0, 1);

    // --- Dunes 沙丘：仅出现在低平的荒漠平原 ---
    if (regions.duneMask > 0.01) {
      const dx = 1;
      const dz = 0.3;
      const wl = Math.hypot(dx, dz);
      const ddx = dx / wl;
      const ddz = dz / wl;
      const phase = N.fbm2(u * 0.003, v * 0.003, 3) * 2 + (u * ddx + v * ddz) * 0.008;
      const duneWave = Math.abs(Math.sin(Math.PI * phase));
      const ripple = Math.abs(Math.sin((u * ddx + v * ddz) * 0.05 + N.perlin1(u * 0.02) * 3)) * M * 0.012;
      const duneH = M * 0.045 + M * 0.075 * (1 - duneWave) + ripple;
      const dm =
        clamp(regions.duneMask, 0, 1) * landMask * (1 - mountainInfl) * (1 - smoothstep(M * 0.09, M * 0.16, h));
      h = h * (1 - dm) + duneH * dm;
    }

    // --- Cliffs 悬崖：从当地地形拔起的阶梯台地（避开高山核心） ---
    if (regions.cliffMask > 0.01) {
      const cliffBase = N.fbm2(uu * (2.2 / Rk), vv * (2.2 / Rk), 3);
      // 台阶量化：floor 会在台阶边界产生 0 宽度的垂直跳变（方块感），
      // 改用 smoothstep 软量化——保留台地/陡崖的阶梯形态，但坡肩连续
      const stepCount = 5;
      const lvl = clamp(cliffBase * 0.5 + 0.5, 0, 1) * stepCount;
      const fl = Math.floor(lvl);
      const fr = lvl - fl;
      const stepped = (fl + smoothstep(0.32, 0.68, fr)) / stepCount;
      const topDetail = N.ridged2(u * 0.015, v * 0.015, 4) * M * 0.045;
      const cliffH = Math.min(h, M * 0.16) + stepped * M * 0.2 + topDetail + M * 0.03;
      const cm =
        clamp(regions.cliffMask, 0, 1) *
        landMask *
        (1 - mountainInfl * 0.75) *
        smoothstep(M * 0.015, M * 0.05, h);
      h = h * (1 - cm) + cliffH * cm;
    }

    // --- Ravines 峡谷：相对下切（切入任意地形形成峡谷而非替换） ---
    if (regions.ravMask > 0.01) {
      const ravN = 1 - Math.abs(N.perlin2(u * 0.008, v * 0.008));
      const ravCarve = Math.pow(smoothstep(0.68, 0.94, ravN), 2) * M * 0.2;
      const rm = clamp(regions.ravMask, 0, 1) * landMask;
      // 下切深度随地势增高而加深，谷底不低于海面下浅层（可积水成河道）
      const depthScale = clamp((h - sea) / (M * 0.3), 0.12, 1);
      h = Math.max(h - ravCarve * depthScale * rm, Math.min(h, sea - M * 0.012));
    }

    // --- Erosion 侵蚀：相对削峰 + 细沟（高原处风化更明显） ---
    if (regions.eroMask > 0.01) {
      const eN = N.fbm2(uu * (1.6 / Rk), vv * (1.6 / Rk), 3);
      const eroDetail = N.fbm2(u * 0.015, v * 0.015, 5);
      const em = clamp(regions.eroMask, 0, 1) * landMask;
      h =
        h -
        em * h * 0.16 * (eN * 0.5 + 0.5) +
        em * M * 0.028 * eroDetail * clamp(h / (M * 0.3), 0.2, 1);
    }

    // --- IQNoise 山脉：独立于主峰体系的中低山岭，出现在开阔地带 ---
    if (regions.iqMask > 0.01) {
      const iq = N.ridged2(u * 0.004, v * 0.004, 7);
      const iqH = iq * M * 0.34 * (0.35 + 0.65 * peakAmp) + M * 0.03;
      const im = clamp(regions.iqMask, 0, 1) * landMask * (1 - mountainInfl * 0.85);
      h = h * (1 - im) + Math.max(h * 0.5, iqH) * im;
    }

    const regionMax = Math.max(regions.duneMask, regions.cliffMask, regions.ravMask, regions.eroMask, regions.iqMask);

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
