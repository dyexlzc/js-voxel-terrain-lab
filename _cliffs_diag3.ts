import { VoxelNoise } from "./src/terrain/voxelNoise";

const n = new VoxelNoise(1337);

console.log("=== perlin2 输出范围测试 ===");
let mn = 1e9, mx = -1e9;
const offs = [n.pOffset(0), n.pOffset(1), n.pOffset(2)];
for (let i = 0; i < 200; i++) {
  const x = -200 + i * 2;
  for (let j = 0; j < 20; j++) {
    const y = -200 + j * 20;
    const v = n.perlin2(x * 0.1, y * 0.1, n.pOffset(1)) as number;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
}
console.log(`perlin2(x*0.1, y*0.1, pOffset(1)): min=${mn.toFixed(4)} max=${mx.toFixed(4)}`);
console.log(`pOffset(0..2) = ${offs.join(", ")}`);

// iq2 对比（top 用）
let mn2 = 1e9, mx2 = -1e9;
for (let i = 0; i < 100; i++) {
  const x = -200 + i * 4;
  const v = n.iq2(x, 0, 0.01, 15);
  if (v < mn2) mn2 = v;
  if (v > mx2) mx2 = v;
}
console.log(`iq2(x,0,0.01,15) * 25: min=${(mn2*25).toFixed(1)} max=${(mx2*25).toFixed(1)}`);

// fbm2 对比
let mn3 = 1e9, mx3 = -1e9;
for (let i = 0; i < 100; i++) {
  const x = -200 + i * 4;
  const v = n.fbm2(x, 0, 0.005, 3);
  if (v < mn3) mn3 = v;
  if (v > mx3) mx3 = v;
}
console.log(`fbm2(x,0,0.005,3): min=${mn3.toFixed(4)} max=${mx3.toFixed(4)}`);

// 直接 perlin2 在几个精确坐标
console.log("\n=== perlin2 精确抽样 ===");
for (const x of [-15, -10, -5, 0, 5, 10, 15]) {
  const v = n.perlin2(x, 0, n.pOffset(1)) as number;
  const v0 = n.perlin2(x, 0, n.pOffset(0)) as number;
  console.log(`x=${x} pOffset(1) -> ${v.toFixed(4)} | pOffset(0) -> ${v0.toFixed(4)}`);
}