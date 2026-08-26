import { TerrainModel } from "./src/terrain/model";
import { DEFAULT_PARAMS, clampParams, type TerrainParams } from "./src/terrain/params";

/* 多 seed 鲁棒性扫描：最大相邻高差（检测断崖 bug）+ 大湖出现情况 */
let worstSeed = 0, worstX = 0, worstY = 0, worstD = 0, wj = 0, wi = 0;
for (const seed of [1, 7, 42, 1337, 99999]) {
  const Ps = clampParams({ ...DEFAULT_PARAMS, seed });
  const ms = new TerrainModel(Ps);
  const Ms = ms.M;
  const Ns = 160;
  const spans = Ps.sampleXMax - Ps.sampleXMin;
  let md = 0, oc = 0, hi = 0, lk = 0, lkMin = 0;
  for (let i = 0; i < Ns; i++) {
    let prevS = ms.sampleSurface(Ps.sampleXMin, Ps.sampleYMin + spans * (i / (Ns - 1)));
    let prev = prevS.h;
    if (prev < 0) oc++;
    if (prev > Ms * 0.8) hi++;
    if (prevS.lakeMask > 0.4 && prev < 0) { lk++; if (prev < lkMin) lkMin = prev; }
    for (let j = 1; j < Ns; j++) {
      const s = ms.sampleSurface(Ps.sampleXMin + spans * (j / (Ns - 1)), Ps.sampleYMin + spans * (i / (Ns - 1)));
      const h = s.h;
      const d = Math.abs(h - prev);
      if (d > md) { md = d; wj = j; wi = i; }
      if (h < 0) oc++;
      if (h > Ms * 0.8) hi++;
      if (s.lakeMask > 0.4 && h < 0) { lk++; if (h < lkMin) lkMin = h; }
      prev = h;
    }
  }
  const tt = Ns * Ns;
  console.log(
    `seed ${String(seed).padStart(5)} | maxΔh(38m步长) ${md.toFixed(1)}m | ocean ${(oc / tt * 100).toFixed(0)}% | >0.8M ${(hi / tt * 100).toFixed(1)}% | lake ${(lk / tt * 100).toFixed(1)}% | 湖深 ${lk ? (-lkMin).toFixed(0) : 0}m`
  );
  if (md > worstD) {
    worstD = md; worstSeed = seed;
    worstX = Ps.sampleXMin + spans * (wj / (Ns - 1));
    worstY = Ps.sampleYMin + spans * (wi / (Ns - 1));
  }
}

/* 最陡处的细剖面 */
console.log(`\n-- worst cliff: seed ${worstSeed} at (${worstX.toFixed(0)}, ${worstY.toFixed(0)})`);
{
  const Ps = clampParams({ ...DEFAULT_PARAMS, seed: worstSeed });
  const ms = new TerrainModel(Ps);
  for (let s = -6; s <= 6; s++) {
    const sx = worstX + s * 38 * 0.2;
    const sm = ms.sampleSurface(sx, worstY);
    const r = sm.regions;
    console.log(
      "x", sx.toFixed(0), "h", sm.h.toFixed(1), "mm", sm.mountainMask.toFixed(2),
      "pm", sm.plateauMask.toFixed(2), "clim", sm.climateErosion.toFixed(2),
      "river", sm.riverMask.toFixed(2),
      "dune", r.duneMask.toFixed(2), "cliff", r.cliffMask.toFixed(2),
      "rav", r.ravMask.toFixed(2), "ero", r.eroMask.toFixed(2), "iq", r.iqMask.toFixed(2)
    );
  }
}

const P = clampParams({ ...DEFAULT_PARAMS });
const model = new TerrainModel(P);
const M = model.M;
const N = 240;
const span = P.sampleXMax - P.sampleXMin;
const step = span / (N - 1);
const grid = new Float64Array(N * N);
const pmGrid = new Float64Array(N * N);
const lkGrid = new Float64Array(N * N);
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const sx = P.sampleXMin + span * (i / (N - 1));
    const sy = P.sampleYMin + span * (j / (N - 1));
    const sm = model.sampleSurface(sx, sy);
    grid[i * N + j] = sm.h;
    pmGrid[i * N + j] = sm.plateauMask;
    lkGrid[i * N + j] = sm.lakeMask;
  }
}

/* 1. 高度分布 */
const sorted = Float64Array.from(grid).sort();
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
console.log("M =", M);
console.log("min/max =", sorted[0].toFixed(1), "/", sorted[sorted.length - 1].toFixed(1));
console.log("p50/p75/p90/p99 =", [0.5, 0.75, 0.9, 0.99].map((p) => q(p).toFixed(1)).join(" / "));

/* 2. 覆盖比例 */
let ocean = 0, plains = 0, hills = 0, mts = 0;
for (const h of grid) {
  if (h < 0) ocean++;
  else if (h < M * 0.08) plains++;
  else if (h < M * 0.25) hills++;
  else mts++;
}
const t = N * N;
console.log(
  "ocean%", (ocean / t * 100).toFixed(1),
  "plains%", (plains / t * 100).toFixed(1),
  "hills%", (hills / t * 100).toFixed(1),
  "mountain%", (mts / t * 100).toFixed(1)
);

/* 3. 局部极大值（峰顶高度层级） */
const peaks: number[] = [];
for (let i = 2; i < N - 2; i++)
  for (let j = 2; j < N - 2; j++) {
    const h = grid[i * N + j];
    if (h < M * 0.25) continue;
    let isMax = true;
    for (let di = -2; di <= 2 && isMax; di++)
      for (let dj = -2; dj <= 2; dj++) {
        if (di === 0 && dj === 0) continue;
        if (grid[(i + di) * N + j + dj] >= h) { isMax = false; break; }
      }
    if (isMax) peaks.push(h);
  }
peaks.sort((a, b) => b - a);
const top = peaks.slice(0, 18).map((x) => Math.round(x));
console.log("peak heights (desc, m):", top.join(","));
console.log("peaks>0.8M:", peaks.filter((x) => x > M * 0.8).length, "| peaks in [0.3M,0.8M]:", peaks.filter((x) => x > M * 0.3 && x <= M * 0.8).length);

/* 4. 成片平原：最大连通块（4 邻接）占平原比例 */
const seen = new Uint8Array(N * N);
let bestPlain = 0;
const isPlain = (i: number, j: number) => grid[i * N + j] >= 1 && grid[i * N + j] < M * 0.08;
for (let i = 0; i < N; i++)
  for (let j = 0; j < N; j++) {
    const idx = i * N + j;
    if (seen[idx] || !isPlain(i, j)) continue;
    let size = 0;
    const stack = [idx];
    seen[idx] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const ci = Math.floor(c / N), cj = c % N;
      const nb = [[ci - 1, cj], [ci + 1, cj], [ci, cj - 1], [ci, cj + 1]];
      for (const [ni, nj] of nb) {
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const nidx = ni * N + nj;
        if (!seen[nidx] && isPlain(ni, nj)) { seen[nidx] = 1; stack.push(nidx); }
      }
    }
    bestPlain = Math.max(bestPlain, size);
  }
console.log("largest contiguous plain:", (bestPlain * step * step / 1e6).toFixed(2), "km² | of all plains:", (bestPlain / Math.max(1, plains) * 100).toFixed(1) + "%");

/* 5. 深水 */
let deep = 0;
for (const h of grid) if (h < -M * 0.1) deep++;
console.log("deep water(<-0.1M)%:", (deep / t * 100).toFixed(1), "| deepest:", sorted[0].toFixed(1));

/* 5.5 高原：覆盖率 + 内部平坦度（高原核心区相邻高差应远小于全图均值） */
let platCnt = 0, platSlopeSum = 0, platSlopeN = 0, platMax = 0, platMin = 1e9;
for (let i = 0; i < N; i++)
  for (let j = 0; j < N; j++) {
    const pmv = pmGrid[i * N + j];
    if (pmv > 0.55) {
      platCnt++;
      if (grid[i * N + j] > platMax) platMax = grid[i * N + j];
      if (grid[i * N + j] < platMin) platMin = grid[i * N + j];
      if (j < N - 1 && pmGrid[i * N + j + 1] > 0.55) {
        platSlopeSum += Math.abs(grid[i * N + j] - grid[i * N + j + 1]);
        platSlopeN++;
      }
    }
  }
console.log(
  "plateau(pm>0.55)%:", (platCnt / t * 100).toFixed(1),
  "| plateau flatness mean|dh| =", platSlopeN ? (platSlopeSum / platSlopeN).toFixed(2) : "n/a", "m",
  "| plateau h range:", platCnt ? `${platMin.toFixed(0)}~${platMax.toFixed(0)}m` : "n/a"
);

/* 5.7 大湖：湖面覆盖率 + 最大连通湖面（km²）+ 湖深 + 岛屿 */
{
  const isLake = (i: number, j: number) => lkGrid[i * N + j] > 0.4 && grid[i * N + j] < 0;
  const seenL = new Uint8Array(N * N);
  const lakes: { size: number; minH: number }[] = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const idx = i * N + j;
      if (seenL[idx] || !isLake(i, j)) continue;
      let size = 0, minH = 0;
      const stack = [idx];
      seenL[idx] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        size++;
        const ci = Math.floor(c / N), cj = c % N;
        if (grid[c] < minH) minH = grid[c];
        const nb = [[ci - 1, cj], [ci + 1, cj], [ci, cj - 1], [ci, cj + 1]];
        for (const [ni, nj] of nb) {
          if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
          const nidx = ni * N + nj;
          if (!seenL[nidx] && isLake(ni, nj)) { seenL[nidx] = 1; stack.push(nidx); }
        }
      }
      lakes.push({ size, minH });
    }
  lakes.sort((a, b) => b.size - a.size);
  const cellKm2 = step * step / 1e6;
  console.log("lakes>0:", lakes.length, "| largest:", (lakes[0]?.size ?? 0) * cellKm2 < 0.01 ? "n/a" : [
    (lakes[0].size * cellKm2).toFixed(2) + "km²",
    "深 " + (-lakes[0].minH).toFixed(0) + "m",
  ].join(" "));
  for (let li = 0; li < Math.min(3, lakes.length); li++) {
    const L = lakes[li];
    console.log(
      `  lake#${li + 1}: ${(L.size * cellKm2).toFixed(2)} km² | 湖深 ${(-L.minH).toFixed(0)}m | 横跨 ≈ ${Math.sqrt(L.size) * step < 100 ? "<100m" : (Math.sqrt(L.size) * step / 100).toFixed(1) + " 百米"}`
    );
  }
  const lakeTotal = lakes.reduce((s, l) => s + l.size, 0);
  console.log("lake coverage%:", (lakeTotal / t * 100).toFixed(1));
}

/* 6. 平滑度：相邻采样点最大高差 */
let maxDelta = 0, sumDelta = 0, mi = 0, mj = 0;
for (let i = 0; i < N; i++)
  for (let j = 0; j < N - 1; j++) {
    const d = Math.abs(grid[i * N + j] - grid[i * N + j + 1]);
    if (d > maxDelta) { maxDelta = d; mi = i; mj = j; }
    sumDelta += d;
  }
console.log("step", step.toFixed(0), "m | max adjacent |dh| =", maxDelta.toFixed(1), "m | mean =", (sumDelta / (N * (N - 1))).toFixed(2), "m");

/* 7. 定位最大陡坎：细采样剖面 + 特征掩码 */
const cx = P.sampleXMin + span * (mi / (N - 1));
const cy = P.sampleYMin + span * (mj / (N - 1));
console.log("\n-- steep delta at grid(", mi, ",", mj, ") world(", cx.toFixed(0), ",", cy.toFixed(0), ")");
for (let s = -6; s <= 6; s++) {
  const sy = cy + s * step * 0.25;
  const sm = model.sampleSurface(cx, sy);
  const r = sm.regions;
  console.log(
    "y", sy.toFixed(0),
    "h", sm.h.toFixed(1),
    "mm", sm.mountainMask.toFixed(2),
    "pm", sm.plateauMask.toFixed(2),
    "clim", sm.climateErosion.toFixed(2),
    "river", sm.riverMask.toFixed(2),
    "dune", r.duneMask.toFixed(2),
    "cliff", r.cliffMask.toFixed(2),
    "rav", r.ravMask.toFixed(2),
    "ero", r.eroMask.toFixed(2),
    "iq", r.iqMask.toFixed(2)
  );
}
