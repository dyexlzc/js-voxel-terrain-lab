/** 种子化 Perlin 噪声库（移植自 VoxelFree Terrain Lab） */
export class NoiseLib {
  p: Uint8Array;

  constructor(seed = 1337) {
    this.p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let s = seed >>> 0;
    const rng = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (256 - i));
      const t = perm[i];
      perm[i] = perm[i + j];
      perm[i + j] = t;
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  fade(t: number) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  lerp(t: number, a: number, b: number) {
    return a + t * (b - a);
  }

  grad2(h: number, x: number, y: number) {
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1 ? -u : u) + (h & 2 ? -2 * v : 2 * v));
  }

  perlin2(x: number, y: number) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const X = fx & 255;
    const Y = fy & 255;
    x -= fx;
    y -= fy;
    const u = this.fade(x);
    const v = this.fade(y);
    const A = this.p[X] + Y;
    const B = this.p[X + 1] + Y;
    return (
      this.lerp(
        v,
        this.lerp(u, this.grad2(this.p[A], x, y), this.grad2(this.p[B], x - 1, y)),
        this.lerp(u, this.grad2(this.p[A + 1], x, y - 1), this.grad2(this.p[B + 1], x - 1, y - 1))
      ) / 1.6
    );
  }

  grad3(h: number, x: number, y: number, z: number) {
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  }

  perlin3(x: number, y: number, z: number) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const X = fx & 255;
    const Y = fy & 255;
    const Z = fz & 255;
    x -= fx;
    y -= fy;
    z -= fz;
    const u = this.fade(x);
    const v = this.fade(y);
    const w = this.fade(z);
    const A = this.p[X] + Y;
    const AA = this.p[A] + Z;
    const AB = this.p[A + 1] + Z;
    const B = this.p[X + 1] + Y;
    const BA = this.p[B] + Z;
    const BB = this.p[B + 1] + Z;
    return (
      this.lerp(
        w,
        this.lerp(
          v,
          this.lerp(u, this.grad3(this.p[AA], x, y, z), this.grad3(this.p[BA], x - 1, y, z)),
          this.lerp(u, this.grad3(this.p[AB], x, y - 1, z), this.grad3(this.p[BB], x - 1, y - 1, z))
        ),
        this.lerp(
          v,
          this.lerp(u, this.grad3(this.p[AA + 1], x, y, z - 1), this.grad3(this.p[BA + 1], x - 1, y, z - 1)),
          this.lerp(u, this.grad3(this.p[AB + 1], x, y - 1, z - 1), this.grad3(this.p[BB + 1], x - 1, y - 1, z - 1))
        )
      ) / 1.6
    );
  }

  fbm2(x: number, y: number, oct: number) {
    let v = 0;
    let a = 1;
    let f = 1;
    let m = 0;
    for (let i = 0; i < oct; i++) {
      v += this.perlin2(x * f, y * f) * a;
      m += a;
      a *= 0.5;
      f *= 2;
    }
    return v / m;
  }

  ridged2(x: number, y: number, oct: number) {
    let v = 0;
    let a = 1;
    let f = 1;
    let w = 1;
    let m = 0;
    for (let i = 0; i < oct; i++) {
      let n = 1 - Math.abs(this.perlin2(x * f, y * f));
      n *= n;
      v += n * w * a;
      w = Math.min(1, Math.max(0, n * 2));
      m += a;
      a *= 0.5;
      f *= 2;
    }
    return v / m;
  }

  perlin1(x: number) {
    const fx = Math.floor(x);
    const X = fx & 255;
    x -= fx;
    const g0 = this.p[X] & 1 ? x : -x;
    const g1 = this.p[X + 1] & 1 ? x - 1 : -(x - 1);
    return this.lerp(this.fade(x), g0, g1) * 2;
  }
}

export function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

export function smoothstep(e0: number, e1: number, x: number) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
