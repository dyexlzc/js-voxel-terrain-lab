import { NoiseLib, clamp, smoothstep, spline, softQuant } from "./noise";
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
  /** 高原化程度（0~1，软量化台阶后的有效混合权重） */
  plateauMask: number;
  /** 气候侵蚀度（0~1）：低=高山带，中=高原带，高=平原带 */
  climateErosion: number;
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

    // === 1.5 气候侵蚀场（Minecraft 1.18 noise-router 的 erosion 参数等价物） ===
    // 大尺度低频场，独立于山脉区域，决定「这个气候带允许长多高的山」：
    //   climEro ≈ 0    → 未侵蚀：山体可达全高、棱角分明（尖峭山峰带）
    //   climEro ≈ 0.45 → 中等侵蚀：山体被削平 → 高原 / 台地带
    //   climEro ≈ 0.9  → 强侵蚀：起伏被压缩 → 成片平原带
    //
    // 频率 0.4/Rk（周期 ≈ 2.5× 区域尺寸）：一个气候带覆盖数个山脉区域，
    // 使「某片区域全是高山、另一片全是平原/高原」成为常态（真实世界的大地理分区）。
    // FBM(3 oct) 输出约 [-0.55, 0.55]，×1.6 + 0.5 后钳制到 [0,1]。
    // 注意：气候场只做「温和起伏调节」——平原化/高原化的重活分别由
    // 下游 pf 压缩与 pm 台地化完成，避免三重门控相乘把高峰概率压没。
    // UE5 移植：一个 3-octave Perlin FBM + 同样的重标定即可，无隐藏状态。
    const climEro = clamp(N.fbm2(uu * (0.4 / Rk) - 88.8, vv * (0.4 / Rk) + 44.4, 3) * 1.6 + 0.5, 0, 1);

    // 侵蚀 → 起伏系数 spline（Minecraft overworld offset spline 的思路）：
    // 中等侵蚀(0.5)仍保留 78% 起伏（高原由 pm 台地化负责削平），
    // 强侵蚀(≥0.72)降到 45% 以下（配合 pf 压缩形成平原）。
    // UE5 移植时保持控制点数值即可复现分布。
    const relief = spline(climEro, [0, 0.3, 0.5, 0.72, 1], [1, 0.92, 0.78, 0.45, 0.18]);

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
    // 气候削减后的有效峰振幅（构造抗蚀性模型）：
    //   peakAmpEff = peakAmp × (1 - (1-relief) × (1-ampS) × 0.75)
    // 高振幅地块（ampS→1，构造活跃）基本免疫气候侵蚀 → 全高山脉在任何气候带
    // 都能拔地而起（高原带内成为桌山，平原带内成为孤立残丘 inselberg）；
    // 弱地块（ampS→0）被强侵蚀气候压制 → 高侵蚀带退化为成片平原。
    // 这样「大陆门控 × 峰振幅 × 气候」三重条件不再相乘压垮高峰概率。
    const peakAmpEff = peakAmp * (1 - (1 - relief) * (1 - ampS) * 0.75);

    // 主峰包络（核心区）+ 次级山脉环带 + 山麓丘陵环带，层层外扩、相互交叠。
    // 包络宽度决定峰体坡度：过窄会产生钉状尖峰（>75°），此处保证最高峰侧翼 ≈55°
    const peakEnv = 1 - smoothstep(0.12, 0.68, f1);
    const subEnv = smoothstep(0.38, 0.58, f1) * (1 - smoothstep(0.66, 0.98, f1));
    const footEnv = smoothstep(0.5, 0.78, f1) * (1 - smoothstep(0.85, 1.18, f1));

    // === 3. 山体细节 ===
    const eroBase = clamp(P.mountainErosion * 0.9, 0, 1);
    // PV 折叠峰谷噪声（Minecraft peaks & valleys）：在山体内部产生环状山脊与
    // 围谷。频率 1.25/Rk（周期 ≈ 0.8× 区域尺寸）——环的尺度与次级山脉匹配。
    const pv = N.peaksValleys2(uu * (1.25 / Rk) + 5.3, vv * (1.25 / Rk) - 8.1, 3); // [-1,1]
    const pvCrest = smoothstep(-0.45, 0.5, pv); // 0=谷底 1=脊顶（较宽的过渡=缓坡）
    // 主山脉内部脊线（沿主峰延伸的山脊与多个峰顶）
    const mainSharp = N.ridged2(uu * (1.9 / Rk) + 5.3, vv * (1.9 / Rk) - 8.1, 3);
    const mainBlunt = N.fbm2(uu * (1.1 / Rk), vv * (1.1 / Rk), 3) * 0.5 + 0.5;
    const mainRidge = mainSharp * (1 - eroBase * 0.7) + mainBlunt * (eroBase * 0.7);
    // 围谷切割：PV 谷地从山体质量中切出内部谷地 → 主峰周边出现被山脊
    // 环绕的洼地与多个次级峰顶（mountain rings）。权重随离主峰核的距离
    // 增大（f1→0.5 后才完全生效），保证主峰核心仍是该区域最高点
    const valleyCut = 1 - (1 - pvCrest) * 0.58 * smoothstep(0.12, 0.5, f1);
    // 次级山脉脊线（主峰周边的低矮山岭）
    const subRidge = N.ridged2(uu * (2.8 / Rk) - 12.9, vv * (2.8 / Rk) + 4.7, 4);
    // 山麓缓丘纹理
    const footN = N.fbm2(uu * (5.5 / Rk) + 21.3, vv * (5.5 / Rk) + 33.9, 3) * 0.5 + 0.5;

    // === 4. 高度分层合成 ===
    // 山脉需要坚实的陆块（沿海大陆边缘形成半岛/岛链）；门控区间足够宽，
    // 避免大陆边缘出现近垂直的山体塌陷
    const mGate = smoothstep(0.3, 0.95, continent);
    // 主山体：Worley 主峰包络 × 区域振幅 × 气候起伏 × 脊线 × PV 围谷切割
    const H_main = M * peakAmpEff * Math.pow(peakEnv, 1.15) * (0.55 + 0.45 * mainRidge) * valleyCut * mGate;
    // 尖峭度 jaggedness（Minecraft jaggedness 参数）：高频窄幅脊线，仅在
    // 低侵蚀气候 + 主峰包络核心处叠加，形成阿尔卑斯式刃脊/角峰。
    // 幅度 M×0.045 且被 mountainErosion 钝化——不会破坏 25m 步长的平滑度预算
    const jag = N.ridged2(uu * (5.5 / Rk) + 61.2, vv * (5.5 / Rk) - 47.8, 3);
    const H_jag =
      M * 0.045 * jag * jag * Math.pow(peakEnv, 1.6) * peakAmpEff * (1 - climEro * 0.75) * (1 - eroBase * 0.55) * mGate;
    const H_sub = M * 0.34 * Math.pow(peakAmpEff, 1.2) * subEnv * subRidge * mGate;
    const H_foot = M * 0.085 * (0.12 + 0.88 * ampS) * footEnv * footN * smoothstep(0.15, 0.7, continent);

    // 平原基底：平缓起伏，山脉从中拔地而起
    const plainN = N.fbm2(u * 0.0035 + 41.7, v * 0.0035 - 17.3, 3);
    const plainDetail = N.fbm2(u * 0.016, v * 0.016, 2);
    const H_plain = M * (0.038 + 0.026 * plainN + 0.009 * plainDetail);

    // 海洋：大陆架 → 深海盆地（成片深水区）
    const deepN = N.fbm2(uu * (0.85 / Rk) + 77.7, vv * (0.85 / Rk) - 55.5, 3);
    const deepPow = Math.pow(smoothstep(0.05, 0.4, deepN), 1.25);
    const H_ocean = sea - M * (0.022 + 0.018 * (deepN * 0.5 + 0.5) + 0.21 * deepPow);

    let h = H_ocean * (1 - continent) + (H_plain + H_main + H_jag + H_sub + H_foot) * continent;

    // === 4.5 平原化（Minecraft：高侵蚀气候 → 成片平原） ===
    // 强侵蚀带内地形起伏向「平原基底 + 缓起伏」连续压缩（按 pf 比例插值，
    // 处处连续、无台阶）。平原基底自带 1.8%M 的低频缓起伏，避免玻璃般死平。
    // 压缩上限 0.9：保留 10% 原始起伏，使河床/残余丘陵仍可辨认
    const pf = smoothstep(0.58, 0.8, climEro) * smoothstep(0.3, 0.6, continent) * P.plainStrength;
    if (pf > 0.001) {
      const flatBase = M * 0.045 + M * 0.018 * (N.fbm2(u * 0.0022 + 201.5, v * 0.0022 + 307.9, 2) * 0.5 + 0.5);
      h = flatBase + (h - flatBase) * (1 - 0.9 * pf);
    }

    // === 4.6 高原（Minecraft：中等侵蚀气候 → 山体削平为台地） ===
    // 高原带 = climEro ∈ [0.36, 0.64] 的窄核心带（核心 [0.45,0.55]）。
    // 刻意收窄：高原是「特色地貌」而非默认地貌——带外的山体保持自由生长，
    // 避免大面积山体被集体削平导致整张图失去主峰。
    // 高原面高度 E 随低频噪声变化（不同高原不同高），内部拉平到 E，
    // 边缘经 softQuant 4 级软量化形成同心台地（桌山/黄土高原式阶梯边坡）。
    // 门控：需要是陆地（continent）且现状略高于海面（不抬升浅海）
    const pmBand = smoothstep(0.36, 0.45, climEro) * (1 - smoothstep(0.55, 0.64, climEro));
    const pm = pmBand * P.plateauStrength * smoothstep(0.32, 0.6, continent) * smoothstep(-M * 0.01, M * 0.035, h);
    if (pm > 0.01) {
      // 高原面高程：基底 0.05M + plateauLift × (0.55~1.05) 区域随机
      const plVar = N.fbm2(uu * (0.7 / Rk) + 177.7, vv * (0.7 / Rk) + 233.1, 2) * 0.5 + 0.5;
      const E = M * (0.05 + P.plateauLift * (0.55 + 0.5 * plVar));
      // 高原面微起伏（±0.6%M）：风蚀残丘感，避免完全水平
      const plDetail = M * 0.006 * N.fbm2(u * 0.01 + 5.5, v * 0.01 - 7.7, 2);
      // 台阶化混合权重：4 级台地边缘，肩部连续
      const pmStep = softQuant(pm, 4);
      h = h * (1 - pmStep) + (E + plDetail) * pmStep;
    }

    // 软性高度上限：仅压缩极罕见尖峰，日常峰顶分布远低于 M
    const softCeil = M * 0.94;
    if (h > softCeil) h = softCeil + (h - softCeil) * 0.22;

    const landMask = smoothstep(0.5, Math.max(6, M * 0.02), h);
    const mountainMask = clamp(peakEnv * peakAmpEff + subEnv * peakAmpEff * subRidge * 0.5, 0, 1);

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
      // 软量化台阶（见 noise.ts softQuant）：保留台地/陡崖的阶梯形态，坡肩连续
      const stepped = softQuant(clamp(cliffBase * 0.5 + 0.5, 0, 1), 5);
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

    return { h, riverMask, regions, regionMax, landMask, mountainMask, plateauMask: pm, climateErosion: climEro };
  }

  getHeight(sx: number, sy: number) {
    return this.sampleSurface(sx, sy).h;
  }

  getDensity(sx: number, sy: number, y: number, cachedH: number | null = null) {
    const h = cachedH === null ? this.getHeight(sx, sy) : cachedH;
    return h - y;
  }
}
