import { VoxelNoise } from "./src/terrain/voxelNoise";
import { cliffsDensity } from "./src/terrain/voxelExamples";

const n = new VoxelNoise(1337);
const freq = 1;

// HTML cliffsSurfaceHeight：从高往下找第一个（最高）零交叉
function htmlSurface(x: number, y: number): number {
  const zMin = -120, zMax = 220, steps = 48;
  let zPrev = zMax, dPrev = cliffsDensity(n, x, y, zMax, freq);
  for (let s = 1; s <= steps; s++) {
    const z = zMax - ((zMax - zMin) * s) / steps;
    const d = cliffsDensity(n, x, y, z, freq);
    if ((dPrev >= 0 && d <= 0) || (dPrev <= 0 && d >= 0)) {
      let lo = Math.min(zPrev, z), hi = Math.max(zPrev, z), dlo = dPrev;
      for (let i = 0; i < 20; i++) {
        const m = (lo + hi) * 0.5, dm = cliffsDensity(n, x, y, m, freq);
        if ((dlo >= 0 && dm >= 0) || (dlo <= 0 && dm <= 0)) { lo = m; dlo = dm; } else hi = m;
      }
      return (lo + hi) * 0.5;
    }
    zPrev = z; dPrev = d;
  }
  return zMin;
}

// 沿 y=0 一条线，看 surface 高度随 x 的变化（判断是否有崖壁/台阶）
console.log("=== 沿 y=0 线，x 从 -150 到 150，HTML surface 高度 ===");
const xs: number[] = [];
const hs: number[] = [];
for (let i = 0; i <= 30; i++) {
  const x = -150 + (300 * i) / 30;
  const h = htmlSurface(x, 0);
  xs.push(x);
  hs.push(h);
  // sides 和 top
  const sides = n.perlin2(x * 0.1 * freq, 0, n.pOffset(1)) as number;
  const top = n.iq2(x, 0, 0.01 * freq, 15) * 25;
  console.log(`x=${x.toFixed(0).padStart(4)} sides=${sides.toFixed(2).padStart(6)} top=${top.toFixed(1).padStart(6)} H=${h.toFixed(1)}`);
}

// 相邻高度差（判断崖壁陡峭度）
let maxJump = 0, jumpX = 0;
for (let i = 1; i < hs.length; i++) {
  const dj = Math.abs(hs[i] - hs[i - 1]);
  if (dj > maxJump) { maxJump = dj; jumpX = xs[i]; }
}
const dx = xs[1] - xs[0];
console.log(`\n采样步长 dx=${dx} | 最大相邻高差=${maxJump.toFixed(1)} @x=${jumpX.toFixed(0)}`);

// 检查 top 与 H 的关系
console.log("\n=== 检查 H 是否 ≈ 50 + top ===");
let maxErr = 0;
for (let i = 0; i < xs.length; i++) {
  const top = n.iq2(xs[i], 0, 0.01 * freq, 15) * 25;
  const err = Math.abs(hs[i] - (50 + top));
  maxErr = Math.max(maxErr, err);
}
console.log("max |H - (50+top)| =", maxErr.toFixed(2));