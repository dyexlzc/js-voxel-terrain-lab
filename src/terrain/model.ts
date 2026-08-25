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

    // Domain warp
    const warpAmp = 90 * P.warp;
    const w1 = N.fbm2(u * 0.0021 + 13.7, v * 0.0021 + 71.3, 3) * warpAmp;
    const w2 = N.fbm2(u * 0.0021 - 31.7, v * 0.0021 + 17.9, 3) * warpAmp;
    const uu = u + w1;
    const vv = v + w2;

    // 大陆基底 + 山脉合成（Belt × Ridge × FBM）
    const baseN = N.fbm2(uu * 0.00105, vv * 0.00105, 5);
    const base = baseN * M * 0.24;
    const continentMask = smoothstep(0.44, 0.64, baseN * 0.5 + 0.5);

    const beltFreq = 0.0012 * P.belts;
    const bn1 = 1 - Math.abs(N.perlin2(uu * beltFreq, vv * beltFreq));
    const bn2 = 1 - Math.abs(N.perlin2(uu * beltFreq * 2.17 + 100, vv * beltFreq * 2.17 - 50));
    const beltN = Math.max(bn1, bn2 * 0.7);
    const belt = Math.pow(smoothstep(1 - clamp(P.beltWidth, 0.08, 0.95), 1, beltN), 1.55);
    const mountainMask = belt * continentMask;

    const eroBase = clamp(P.mountainErosion * 0.9, 0, 1);
    const sharp = N.ridged2(uu * 0.0082, vv * 0.0082, 6);
    const blunt = N.fbm2(uu * 0.0055, vv * 0.0055, 4) * 0.5 + 0.5;
    let ridge = sharp;
    const peakBlend = clamp(eroBase * 1.25, 0, 1) * smoothstep(0.18, 0.78, sharp);
    ridge = ridge * (1 - peakBlend) + blunt * peakBlend;
    ridge = Math.pow(clamp(ridge, 0, 1), 2.2 - 1.65 * clamp(eroBase, 0, 1));
    let mountainH = M * mountainMask * ridge;
    const roundedMountain = M * mountainMask * blunt * 0.78;
    const highMask = smoothstep(0.4, 0.92, mountainH / M);
    const roundBlend = clamp(eroBase * highMask * 0.85, 0, 1);
    mountainH = mountainH * (1 - roundBlend) + roundedMountain * roundBlend;

    let h = base + mountainH;
    const landMask = smoothstep(0.5, Math.max(6, M * 0.02), h);

    // 河流
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

    // 有机生物群系区域
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

    // --- IQNoise 山脉 ---
    if (regions.iqMask > 0.01) {
      const iq = N.ridged2(u * 0.004, v * 0.004, 7);
      const iqH = iq * M * 0.4 + M * 0.05;
      const im = clamp(regions.iqMask, 0, 1) * landMask;
      h = h * (1 - im) + iqH * im;
    }

    // 平原（无区域主导时的默认）
    const regionMax = Math.max(regions.duneMask, regions.cliffMask, regions.ravMask, regions.eroMask, regions.iqMask);
    const plainsW = clamp(1 - regionMax, 0, 1) * landMask * (1 - smoothstep(0.05, 0.22, mountainMask));
    if (plainsW > 0.01) {
      const plainH =
        N.fbm2(u * 0.008, v * 0.008, 4) * M * 0.03 + N.perlin1((u * 0.7 + v * 0.3) * 0.012) * M * 0.012 + M * 0.03;
      h = h * (1 - plainsW) + plainH * plainsW;
    }

    // 海洋下压
    if (h < sea && continentMask < 0.3) {
      h = Math.min(h, sea - M * 0.02);
    }

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
