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
  resolution: number;
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
}

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
  resolution: 256,
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
    resolution: clamp(Math.round(raw.resolution), 64, 768),
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
  };
}
