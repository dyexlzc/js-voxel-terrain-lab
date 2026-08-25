import { clamp } from "./noise";

export interface TerrainParams {
  worldSizeX: number;
  worldSizeY: number;
  voxelSize: number;
  tileSize: number;
  sampleMode: "auto" | "manual";
  sampleXMin: number;
  sampleXMax: number;
  sampleYMin: number;
  sampleYMax: number;
  fitCamera: boolean;
  showGrid: boolean;
  /** "auto" = 密度锁定，按 targetDensity 推算；数字 = 固定分辨率 */
  resolution: number | "auto";
  /** Auto 模式目标：每顶点覆盖多少米（4–500） */
  targetDensity: number;
  seed: number;
  verticalScale: number;
  freqScale: number;
  maxMountain: number;
  belts: number;
  beltWidth: number;
  warp: number;
  mountainErosion: number;
  riverStrength: number;
  riverWidth: number;
  regionScale: number;
  regionThreshold: number;
  sDune: number;
  sCliff: number;
  sRavine: number;
  sErosion: number;
  sIQ: number;
  sCave: number;
  /** 超级区块边长（米），决定山脉/平原/海盆的宏观尺度 */
  supercellSize: number;
  /** 超级区块混合半径（0-1），越大区块间过渡越柔和，边界越模糊 */
  supercellBlend: number;
  /** 主山峰相对 maxMountain 的高度倍率（>1 可突破上限） */
  peakHeightMult: number;
  /** 次级山峰密度：每个高山区块内生成多少个次级山峰 */
  secondaryPeakCount: number;
  /** 次级山峰高度上限（相对主峰高度的比例 0-1） */
  secondaryPeakMax: number;
  /** 主峰影响半径（相对区块尺寸的比例），决定山脚坡度 */
  peakRadiusMult: number;
  /** 平原区块出现概率（0-1） */
  plainsBlockProb: number;
  /** 水域区块出现概率（0-1） */
  marineBlockProb: number;
  /** 水域区块的海盆深度（相对 maxMountain 的比例） */
  oceanDepthMult: number;
  /** 平原区块的海拔起伏（相对 maxMountain 的比例） */
  plainsReliefMult: number;
}

export const RES_AUTO_MIN = 128;
export const RES_MAX = 1536;

export const DEFAULT_PARAMS: TerrainParams = {
  worldSizeX: 6000,
  worldSizeY: 6000,
  voxelSize: 1,
  tileSize: 3000,
  sampleMode: "auto",
  sampleXMin: -3000,
  sampleXMax: 3000,
  sampleYMin: -3000,
  sampleYMax: 3000,
  fitCamera: false,
  showGrid: false,
  resolution: "auto",
  targetDensity: 24,
  seed: 42,
  verticalScale: 1,
  freqScale: 1,
  maxMountain: 720,
  belts: 2.2,
  beltWidth: 0.56,
  warp: 1.25,
  mountainErosion: 0.95,
  riverStrength: 0.95,
  riverWidth: 1,
  regionScale: 0.0006,
  regionThreshold: 0.35,
  sDune: 1,
  sCliff: 1,
  sRavine: 1,
  sErosion: 1,
  sIQ: 1,
  sCave: 0.55,
  supercellSize: 2400,
  supercellBlend: 0.45,
  peakHeightMult: 1.15,
  secondaryPeakCount: 6,
  secondaryPeakMax: 0.55,
  peakRadiusMult: 0.72,
  plainsBlockProb: 0.32,
  marineBlockProb: 0.18,
  oceanDepthMult: 0.55,
  plainsReliefMult: 0.025,
};

/** 与原实现 readParams 一致的安全钳制 */
export function clampParams(raw: TerrainParams): TerrainParams {
  const worldSizeX = clamp(raw.worldSizeX, 100, 500000);
  const worldSizeY = clamp(raw.worldSizeY, 100, 500000);
  const voxelSize = clamp(raw.voxelSize, 0.05, 100);
  const tileSize = clamp(raw.tileSize, 100, Math.max(worldSizeX, worldSizeY));
  let { sampleXMin, sampleXMax, sampleYMin, sampleYMax } = raw;
  if (raw.sampleMode === "auto") {
    sampleXMin = -worldSizeX / (2 * voxelSize);
    sampleXMax = worldSizeX / (2 * voxelSize);
    sampleYMin = -worldSizeY / (2 * voxelSize);
    sampleYMax = worldSizeY / (2 * voxelSize);
  } else {
    if (sampleXMax - sampleXMin < 1) {
      sampleXMin = -3000;
      sampleXMax = 3000;
    }
    if (sampleYMax - sampleYMin < 1) {
      sampleYMin = -3000;
      sampleYMax = 3000;
    }
  }
  return {
    worldSizeX,
    worldSizeY,
    voxelSize,
    tileSize,
    sampleMode: raw.sampleMode,
    sampleXMin,
    sampleXMax,
    sampleYMin,
    sampleYMax,
    fitCamera: raw.fitCamera,
    showGrid: raw.showGrid,
    resolution: raw.resolution === "auto" ? "auto" : clamp(Math.round(raw.resolution), 64, RES_MAX),
    targetDensity: clamp(Math.round(raw.targetDensity), 4, 500),
    seed: Math.round(raw.seed),
    verticalScale: clamp(raw.verticalScale, 0.05, 10),
    freqScale: clamp(raw.freqScale, 0.02, 20),
    maxMountain: clamp(raw.maxMountain, 1, 100000),
    belts: clamp(raw.belts, 0.1, 12),
    beltWidth: clamp(raw.beltWidth, 0.08, 0.95),
    warp: clamp(raw.warp, 0, 6),
    mountainErosion: clamp(raw.mountainErosion, 0, 1.5),
    riverStrength: clamp(raw.riverStrength, 0, 3),
    riverWidth: clamp(raw.riverWidth, 0, 3),
    regionScale: clamp(raw.regionScale, 0.00005, 0.01),
    regionThreshold: clamp(raw.regionThreshold, 0.05, 0.6),
    sDune: clamp(raw.sDune, 0, 3),
    sCliff: clamp(raw.sCliff, 0, 3),
    sRavine: clamp(raw.sRavine, 0, 3),
    sErosion: clamp(raw.sErosion, 0, 3),
    sIQ: clamp(raw.sIQ, 0, 3),
    sCave: clamp(raw.sCave, 0, 3),
    supercellSize: clamp(raw.supercellSize, 200, 50000),
    supercellBlend: clamp(raw.supercellBlend, 0.05, 1),
    peakHeightMult: clamp(raw.peakHeightMult, 0.2, 3),
    secondaryPeakCount: clamp(Math.round(raw.secondaryPeakCount), 0, 30),
    secondaryPeakMax: clamp(raw.secondaryPeakMax, 0.05, 0.95),
    peakRadiusMult: clamp(raw.peakRadiusMult, 0.1, 2),
    plainsBlockProb: clamp(raw.plainsBlockProb, 0, 0.9),
    marineBlockProb: clamp(raw.marineBlockProb, 0, 0.8),
    oceanDepthMult: clamp(raw.oceanDepthMult, 0.05, 2),
    plainsReliefMult: clamp(raw.plainsReliefMult, 0, 0.2),
  };
}

/** 解析生效分辨率：Auto 按目标 m/vertex 推算并封顶 1536² */
export function effectiveResolution(p: TerrainParams): number {
  if (p.resolution === "auto") {
    const span = Math.max(p.sampleXMax - p.sampleXMin, p.sampleYMax - p.sampleYMin);
    return clamp(Math.round(span / p.targetDensity), RES_AUTO_MIN, RES_MAX);
  }
  return clamp(Math.round(p.resolution), 64, RES_MAX);
}
