/**
 * Marching Tetrahedra 等值面提取（VoxelPlugin Cave Mesh 流水线的第 3 段）。
 *
 * 流水线：
 *   3D Density 场（体素坐标 X/Y 水平、Z 高度）
 *     → 有限体素盒内规则采样 D[ix,iy,iz]
 *     → 提取 density = 0 等值面（每 cube 拆 6 四面体）
 *     → 边上线性插值求交点 t = d0/(d0-d1)
 *     → 梯度法线（有限差分，比几何法线更平滑、更贴 SDF 语义）
 *     → 仅在输出阶段做 Voxel→Three 坐标转换 (X, Z, -Y)
 *
 * 为什么不用 HeightField：一个 (X,Y) 列可能包含多个零交叉
 * （山体表面 / 洞穴顶 / 洞穴底），只有 3D 等值面能表达悬空面与空腔。
 *
 * 本版本支持 13 个密度模式（见 ExampleMode）：
 *   1~7  VoxelExample 原始示例（Cave/Ravines 走列缓存，其余逐点评估）
 *   8~13 Hybrid（区域 + 多算子混合）
 *
 * UE5 移植：对应 VoxelPlugin 的 MarchingCubes 管线。四面体法无需 256 项
 * LUT（原型阶段更不易出错）；移植 C++ 时可换标准 Marching Cubes LUT，
 * 密度场与插值公式完全不变。四面体分解绕体对角线 0-6 切 6 刀，
 * 与 Marching Cubes 顶点位置在 cube 面上逐边一致（共边网格无缝）。
 */

import {
  caveColumn,
  caveDensity,
  exampleDensity,
  type CaveColumn,
  type ExampleMode,
  type DunesParams,
  type RegionParams,
} from "./voxelExamples";
import type { VoxelNoise } from "./voxelNoise";

/** 体素盒边界（体素坐标：X/Y 水平，Z 高度） */
export interface VolumeBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** 规则采样网格：vals[id]，id = (k·N + j)·N + i（i→X, j→Y, k→Z） */
export interface VolumeGrid {
  N: number;
  bounds: VolumeBounds;
  vals: Float32Array;
}

export function gridId(N: number, i: number, j: number, k: number): number {
  return (k * N + j) * N + i;
}

/* ---------- 立方体 → 6 四面体分解（绕体对角线 0-6） ---------- */
// 立方体角点偏移（dx,dy,dz），索引 = dx | dy<<1 | dz<<2
const CUBE = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
// 6 个四面体共享对角线 0-6；元素为 CUBE 角点索引
const TETRAS = [
  [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6],
  [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6],
];
// 四面体 6 条边（四面体局部顶点对）；4 交点（2in/2out）的环序在下方按
// inside/outside 配对现场推导，不依赖此排列
const TET_EDGES = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];

export interface MarchResult {
  /** Three.js 坐标（已从 Voxel (X,Y,Z) 转换为 (X, Z, -Y)） */
  positions: Float32Array;
  /** 梯度法线（归一化，指向空气侧，同坐标系） */
  normals: Float32Array;
  indices: Uint32Array;
  triangles: number;
  vertices: number;
}

/** sampleVolume 可选参数（Hybrid 模式用到） */
export interface SampleOptions {
  seed?: number;
  dunes?: DunesParams;
  region?: RegionParams;
}

/**
 * 体采样（仅 cave 走列缓存，其余逐体素评估）。
 *
 * 列缓存原理：caveColumn 的 top/bot/tube/global 只依赖 (X,Y)——
 * 先按 N² 列一次算齐，随后每个体素的密度只需 3 次 CSG 运算，
 * 噪声求值次数从 N³ 降到 N²（N=64 时约 64 倍加速）。
 *
 * 其它模式（高度场/混合）每体素调用 exampleDensity，无列缓存加速。
 * 注意：高度场示例的 density = h(X,Y) - Z 沿 Z 是线性的，
 * 有限差分梯度能精确反映 h 的 ∇，所以仍可生成正确法线。
 */
export async function sampleVolume(
  noise: VoxelNoise,
  mode: ExampleMode,
  bounds: VolumeBounds,
  N: number,
  freq: number,
  token: { cancelled: boolean },
  onProgress: (p: number) => void,
  opts: SampleOptions = {}
): Promise<VolumeGrid | null> {
  const vals = new Float32Array(N * N * N);
  const cols = mode === "cave" ? new Float64Array(N * N * 4) : null;
  const { x0, x1, y0, y1, z0, z1 } = bounds;

  if (cols) {
    for (let j = 0; j < N; j++) {
      const y = y0 + ((y1 - y0) * j) / (N - 1);
      for (let i = 0; i < N; i++) {
        const x = x0 + ((x1 - x0) * i) / (N - 1);
        const c: CaveColumn = caveColumn(noise, x, y, freq);
        const ci = (j * N + i) * 4;
        cols[ci] = c.top;
        cols[ci + 1] = c.bot;
        cols[ci + 2] = c.tube;
        cols[ci + 3] = c.global;
      }
    }
  }

  const col: CaveColumn = { top: 0, bot: 0, tube: 0, global: 0 };
  for (let k = 0; k < N; k++) {
    if (token.cancelled) return null;
    if (k > 0 && k % 8 === 0) {
      onProgress(k / N);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    const z = z0 + ((z1 - z0) * k) / (N - 1);
    for (let j = 0; j < N; j++) {
      const y = y0 + ((y1 - y0) * j) / (N - 1);
      for (let i = 0; i < N; i++) {
        const x = x0 + ((x1 - x0) * i) / (N - 1);
        if (cols) {
          const ci = (j * N + i) * 4;
          col.top = cols[ci];
          col.bot = cols[ci + 1];
          col.tube = cols[ci + 2];
          col.global = cols[ci + 3];
          vals[gridId(N, i, j, k)] = caveDensity(z, col);
        } else {
          vals[gridId(N, i, j, k)] = exampleDensity(mode, noise, x, y, z, freq, opts);
        }
      }
    }
  }
  return { N, bounds, vals };
}

/** 网格梯度（中心差分，边界单侧）。梯度指向密度增大方向 = 实体→空气 = 表面外法线 */
function gridGradients(g: VolumeGrid): [Float32Array, Float32Array, Float32Array] {
  const { N, vals } = g;
  const gx = new Float32Array(N * N * N);
  const gy = new Float32Array(N * N * N);
  const gz = new Float32Array(N * N * N);
  const { x0, x1, y0, y1, z0, z1 } = g.bounds;
  const dx = (x1 - x0) / (N - 1);
  const dy = (y1 - y0) / (N - 1);
  const dz = (z1 - z0) / (N - 1);
  for (let k = 0; k < N; k++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const id = gridId(N, i, j, k);
        gx[id] =
          i === 0
            ? (vals[gridId(N, 1, j, k)] - vals[id]) / dx
            : i === N - 1
              ? (vals[id] - vals[gridId(N, N - 2, j, k)]) / dx
              : (vals[gridId(N, i + 1, j, k)] - vals[gridId(N, i - 1, j, k)]) / (2 * dx);
        gy[id] =
          j === 0
            ? (vals[gridId(N, i, 1, k)] - vals[id]) / dy
            : j === N - 1
              ? (vals[id] - vals[gridId(N, i, N - 2, k)]) / dy
              : (vals[gridId(N, i, j + 1, k)] - vals[gridId(N, i, j - 1, k)]) / (2 * dy);
        gz[id] =
          k === 0
            ? (vals[gridId(N, i, j, 1)] - vals[id]) / dz
            : k === N - 1
              ? (vals[id] - vals[gridId(N, i, j, N - 2)]) / dz
              : (vals[gridId(N, i, j, k + 1)] - vals[gridId(N, i, j, k - 1)]) / (2 * dz);
      }
  return [gx, gy, gz];
}

/**
 * Marching Tetrahedra：提取 density=0 等值面，输出 BufferGeometry 数据。
 *
 * 每 cube 拆 6 四面体；四面体按 4 角点 inside(d<0)/outside(d≥0) 分case：
 *   0/4 inside → 无三角形；1/3 inside → 1 三角形；2 inside → 2 三角形（quad 拆分）。
 * 交点插值：t = d0/(d0-d1)，P = P0 + t·(P1-P0)；法线同 t 插值后归一化。
 * 绕向修正：几何法线与梯度法线点积 < 0 时翻转顶点序（正面统一朝空气侧）。
 *
 * 坐标转换只在输出处发生：Voxel(X,Y,Z) → Three(X, Z, -Y)。
 * 该映射是纯旋转（det=+1），位置与法线用同一变换。
 */
export function marchTetrahedra(g: VolumeGrid): MarchResult {
  const { N, vals, bounds } = g;
  const [gx, gy, gz] = gridGradients(g);
  const { x0, x1, y0, y1, z0, z1 } = bounds;
  const sx = (x1 - x0) / (N - 1);
  const sy = (y1 - y0) / (N - 1);
  const sz = (z1 - z0) / (N - 1);

  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  let vc = 0;

  // cube 8 角点 scratch（避免每 cell 分配对象）
  const cx = new Float64Array(8);
  const cy = new Float64Array(8);
  const cz = new Float64Array(8);
  const cd = new Float64Array(8);
  const cgx = new Float64Array(8);
  const cgy = new Float64Array(8);
  const cgz = new Float64Array(8);
  // 四面体 scratch
  const td = new Float64Array(4);
  const hitE: number[] = [];

  /** 边 (a,b) 交点：插值位置与梯度，按 Three 坐标写入 pos/nor */
  const pushCrossing = (ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    da: number, db: number, ga: number[], gb: number[]) => {
    const d = da - db;
    const t = Math.abs(d) < 1e-12 ? 0.5 : Math.max(0, Math.min(1, da / d));
    // Voxel (X,Y,Z) → Three (X, Z, -Y)
    pos.push(ax + (bx - ax) * t, az + (bz - az) * t, -(ay + (by - ay) * t));
    let nx = ga[0] + (gb[0] - ga[0]) * t;
    let ny = ga[1] + (gb[1] - ga[1]) * t;
    let nz = ga[2] + (gb[2] - ga[2]) * t;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    nor.push(nx, nz, -ny);
  };

  /** 判定三角形绕向是否需翻转：几何法线与梯度法线（指向空气）点积 < 0 时翻转 */
  const triNeedsFlip = (i0: number, i1: number, i2: number): boolean => {
    // 几何法线（Three 坐标下叉积）
    const ax = pos[i1 * 3] - pos[i0 * 3];
    const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
    const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
    const bx = pos[i2 * 3] - pos[i0 * 3];
    const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
    const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
    const crx = ay * bz - az * by;
    const cry = az * bx - ax * bz;
    const crz = ax * by - ay * bx;
    // 平均梯度法线（指向空气）
    const gnx = nor[i0 * 3] + nor[i1 * 3] + nor[i2 * 3];
    const gny = nor[i0 * 3 + 1] + nor[i1 * 3 + 1] + nor[i2 * 3 + 1];
    const gnz = nor[i0 * 3 + 2] + nor[i1 * 3 + 2] + nor[i2 * 3 + 2];
    return crx * gnx + cry * gny + crz * gnz < 0;
  };

  /** 按给定翻转位输出三角形（同一 quad 的两个三角形必须共用同一位，保证流形） */
  const emitTri = (i0: number, i1: number, i2: number, flip: boolean) => {
    if (flip) idx.push(i0, i2, i1);
    else idx.push(i0, i1, i2);
  };

  for (let k = 0; k < N - 1; k++) {
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        // 收集 cube 8 角点
        for (let c = 0; c < 8; c++) {
          const id = gridId(N, i + CUBE[c][0], j + CUBE[c][1], k + CUBE[c][2]);
          cx[c] = x0 + sx * (i + CUBE[c][0]);
          cy[c] = y0 + sy * (j + CUBE[c][1]);
          cz[c] = z0 + sz * (k + CUBE[c][2]);
          cd[c] = vals[id];
          cgx[c] = gx[id];
          cgy[c] = gy[id];
          cgz[c] = gz[id];
        }
        // 6 四面体
        for (let t = 0; t < 6; t++) {
          const tet = TETRAS[t];
          for (let q = 0; q < 4; q++) td[q] = cd[tet[q]];
          // 找跨越边（一端 d<0 一端 d≥0）
          hitE.length = 0;
          for (let e = 0; e < 6; e++) {
            const a = TET_EDGES[e][0];
            const b = TET_EDGES[e][1];
            if ((td[a] < 0 && td[b] >= 0) || (td[a] >= 0 && td[b] < 0)) hitE.push(e);
          }
          if (hitE.length < 3 || hitE.length > 4) continue;
          const base = vc;
          if (hitE.length === 3) {
            // 1/3 inside → 单三角形
            for (const e of hitE) {
              const a = tet[TET_EDGES[e][0]];
              const b = tet[TET_EDGES[e][1]];
              pushCrossing(cx[a], cy[a], cz[a], cx[b], cy[b], cz[b], cd[a], cd[b],
                [cgx[a], cgy[a], cgz[a]], [cgx[b], cgy[b], cgz[b]]);
            }
            emitTri(base, base + 1, base + 2, triNeedsFlip(base, base + 1, base + 2));
            vc += 3;
          } else {
            // 4 交点 = 2 inside + 2 outside。设 inside={a,b}、outside={c,d}，
            // 四个交点沿「共享 tetra 面」相邻关系构成环：(a,c)→(b,c)→(b,d)→(a,d)。
            // 必须按环序入栈再沿对角 q0-q2 拆两个三角形——
            // 乱序拆分会产生对折（bowtie）面。
            const io: number[][] = []; // [inside 局部角点, outside 局部角点]
            for (const e of hitE) {
              const u = TET_EDGES[e][0];
              const v = TET_EDGES[e][1];
              io.push(td[u] < 0 ? [u, v] : [v, u]);
            }
            const ia = io[0][0];
            const oc = io[0][1];
            let od = -1; // a 的另一个 outside（a,d 边）
            let ib = -1; // c 的另一个 inside（b,c 边）
            for (let q = 1; q < 4; q++) {
              if (io[q][0] === ia) od = io[q][1];
              else if (io[q][1] === oc) ib = io[q][0];
            }
            const ring = [
              [ia, oc],
              [ib, oc],
              [ib, od],
              [ia, od],
            ];
            for (const rv of ring) {
              // 局部角点 → cube 角点（cx/cy/cz/cd/cg* 均按 cube 角点索引）
              const u = tet[rv[0]];
              const v = tet[rv[1]];
              pushCrossing(cx[u], cy[u], cz[u], cx[v], cy[v], cz[v], cd[u], cd[v],
                [cgx[u], cgy[u], cgz[u]], [cgx[v], cgy[v], cgz[v]]);
            }
            // 两三角形共用同一翻转位：独立判定会让 quad 两半绕向相反（非流形）
            const flip = triNeedsFlip(base, base + 1, base + 2);
            emitTri(base, base + 1, base + 2, flip);
            emitTri(base, base + 2, base + 3, flip);
            vc += 4;
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    indices: new Uint32Array(idx),
    triangles: idx.length / 3,
    vertices: vc,
  };
}
