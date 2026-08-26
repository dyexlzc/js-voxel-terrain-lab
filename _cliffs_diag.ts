import { VoxelNoise } from "./src/terrain/voxelNoise";
import { cliffsHeight, cliffsDensity } from "./src/terrain/voxelExamples";

const n = new VoxelNoise(1337);
const freq = 1;

function zeroCrossings(x: number, y: number): number[] {
  const zs: number[] = [];
  const z0 = -120, z1 = 220, steps = 340;
  let prevZ = z0;
  let prevD = cliffsDensity(n, x, y, z0, freq);
  for (let s = 1; s <= steps; s++) {
    const z = z0 + ((z1 - z0) * s) / steps;
    const d = cliffsDensity(n, x, y, z, freq);
    if ((prevD >= 0 && d <= 0) || (prevD <= 0 && d >= 0)) {
      // bisect
      let lo = Math.min(prevZ, z), hi = Math.max(prevZ, z), dlo = prevD;
      for (let i = 0; i < 24; i++) {
        const m = (lo + hi) * 0.5, dm = cliffsDensity(n, x, y, m, freq);
        if ((dlo >= 0 && dm >= 0) || (dlo <= 0 && dm <= 0)) { lo = m; dlo = dm; } else hi = m;
      }
      zs.push((lo + hi) * 0.5);
    }
    prevZ = z; prevD = d;
  }
  return zs;
}

// 模拟 HTML cliffsSurfaceHeight：从高往下找第一个符号变化（正->负）
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

// 采样一批点，统计零交叉数量
console.log("=== cliffs density 在 z 方向的零交叉（marching 会全部提取）===");
let maxZC = 0, minZC = 99, single = 0, multi = 0;
const samples: [number, number, number[], number][] = [];
for (let i = 0; i < 12; i++) {
  const x = -180 + i * 32;
  for (let j = 0; j < 8; j++) {
    const y = -140 + j * 40;
    const zc = zeroCrossings(x, y);
    const h = htmlSurface(x, y);
    maxZC = Math.max(maxZC, zc.length);
    minZC = Math.min(minZC, zc.length);
    if (zc.length <= 1) single++; else multi++;
    samples.push([x, y, zc, h]);
  }
}
console.log(`零交叉数量: min=${minZC} max=${maxZC} | 单交叉=${single} 多交叉=${multi}`);

console.log("\n=== 若干采样点详情 ===");
for (const [x, y, zc, h] of samples.slice(0, 12)) {
  console.log(`(${x},${y}) 零交叉=[${zc.map((z) => z.toFixed(1)).join(", ")}]  HTML表面=${h.toFixed(1)}`);
}

console.log("\n=== 多交叉点的 density 剖面 (x,y) 固定，扫 z ===");
// 找一个多交叉的点
const mp = samples.find((s) => s[2].length > 1);
if (mp) {
  const [x, y] = mp;
  const sides = (n.perlin2(x * 0.1 * freq, y * 0.1 * freq, n.pOffset(1)) as number);
  const top = n.iq2(x, y, 0.01 * freq, 15) * 25;
  console.log(`x=${x} y=${y} sides=${sides.toFixed(3)} top=${top.toFixed(1)}`);
  for (let z = -10; z <= 90; z += 5) {
    const p = Math.max(0, Math.min(1, (z / 50 + 0.2 * sides) * 10));
    const d = z - (50 * p + top * p);
    console.log(`  z=${z.toFixed(1)} p=${p.toFixed(3)} d=${d.toFixed(1)}`);
  }
}