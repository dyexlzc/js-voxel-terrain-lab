import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VoxelNoise } from "../terrain/voxelNoise";
import {
  exampleDensity,
  caveColumn,
  caveDensity,
  MODE_BY_ID,
  MODE_SPECS,
  type ExampleMode,
  type DunesParams,
  type RegionParams,
} from "../terrain/voxelExamples";
import { clamp } from "../terrain/voxelExamples";
import { marchTetrahedra, sampleVolume, type VolumeBounds } from "../terrain/marching";

/* ---------------- 参数 ----------------
 * CaveLab V2 · GPT：
 *   1) 采用 ChatGPT 修复的 Cliffs 算法（p 显式依赖 query Z 的 3D 自指型密度）。
 *   2) 大幅扩展沙盘采样上限，支持「更远范围」的地形渲染：
 *        · N（体分辨率） 24 ~ 160
 *        · half（XY 半尺寸，体素） 100 ~ 4000
 *        · voxel（米/体素） 1 ~ 40
 *        · freq（频率缩放） 0.2 ~ 10
 */

interface CaveParams {
  mode: ExampleMode;
  seed: number;
  /** 频率缩放（乘到示例公式的固定频率上） */
  freq: number;
  /** 体分辨率：每轴采样数（N³ 个体素） */
  N: number;
  /** XY 采样半尺寸（体素单位，盒为 [-half, half]²） */
  half: number;
  /** 每体素米数（仅显示缩放，不参与密度计算） */
  voxel: number;
  wireframe: boolean;
  /** Dunes 风向量（X 方向） */
  windX: number;
  /** Dunes 风向量（Y 方向） */
  windY: number;
  /** 区域尺度（Hybrid 13 用） */
  regionScale: number;
  /** 区域门槛 */
  regionThreshold: number;
}

const DEFAULTS: CaveParams = {
  mode: "cliffs",
  seed: 1337,
  freq: 1,
  N: 72,
  half: 250,
  voxel: 5,
  wireframe: false,
  windX: 1,
  windY: 0,
  regionScale: 0.0006,
  regionThreshold: 0.35,
};

/** 按模式查 Z 范围（见 MODE_BY_ID[id].zRange） */
function zRange(mode: ExampleMode): [number, number] {
  return MODE_BY_ID[mode].zRange;
}

/* ---------------- 小型 UI 构件（与 TerrainLab 同风格） ---------------- */

function Group({ n, title, children, note }: { n: string; title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="mb-3.5 rounded-lg border border-line bg-card p-3.5">
      <h3 className="mb-2.5 flex items-center gap-2 font-display text-[13px] font-semibold tracking-wide text-paper">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-amber/15 font-mono text-[10px] font-bold text-amber">
          {n}
        </span>
        {title}
      </h3>
      {note && (
        <p className="mb-2.5 border-l-2 border-amber/70 bg-ink/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-mute">
          {note}
        </p>
      )}
      {children}
    </section>
  );
}

function Slider({
  label, value, min, max, step, decimals, onChange,
}: { label: string; value: number; min: number; max: number; step: number; decimals: number; onChange: (v: number) => void }) {
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="text-[11px] text-mute">{label}</span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-amber">{value.toFixed(decimals)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer accent-amber" />
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-[12.5px] text-paper/90 select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-amber" />
      {label}
    </label>
  );
}

/* ---------------- 主组件 ---------------- */

interface Status { text: string; ms: number; error: boolean }

export default function CaveLabV2() {
  const [params, setParams] = useState<CaveParams>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const crossRef = useRef<HTMLCanvasElement>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const genTokenRef = useRef(0);

  const set = <K extends keyof CaveParams>(k: K, v: CaveParams[K]) => setParams((p) => ({ ...p, [k]: v }));

  const spec = MODE_BY_ID[params.mode];
  const dunes: DunesParams = { windX: params.windX, windY: params.windY };
  const region: RegionParams = {
    regionScale: params.regionScale,
    regionThreshold: params.regionThreshold,
    sDune: 1, sCliff: 1, sRavine: 1, sErosion: 1, sIQ: 1,
  };

  /* ---------- 密度剖面（X-Z 切片，Y=0） ---------- */
  const buildCrossSection = (P: CaveParams, noise: VoxelNoise) => {
    const canvas = crossRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const [z0, z1] = zRange(P.mode);
    const img = ctx.createImageData(W, H);
    // 高度场示例可缓存 h(x, 0)；体示例逐 (x, z) 重算
    const isHeightField = !spec.isVolumetric;
    const nx = 256;
    const heights = isHeightField ? new Float32Array(nx) : null;
    let colAt: ((x: number) => ReturnType<typeof caveColumn>) | null = null;
    if (heights) {
      for (let i = 0; i < nx; i++) {
        const x = -P.half + (2 * P.half * i) / (nx - 1);
        let lo = z0, hi = z1, dLo = exampleDensity(P.mode, noise, x, 0, lo, P.freq, { seed: P.seed, dunes, region });
        for (let it = 0; it < 22; it++) {
          const m = (lo + hi) * 0.5;
          const dM = exampleDensity(P.mode, noise, x, 0, m, P.freq, { seed: P.seed, dunes, region });
          if ((dLo >= 0 && dM >= 0) || (dLo <= 0 && dM <= 0)) { lo = m; dLo = dM; }
          else hi = m;
        }
        heights[i] = (lo + hi) * 0.5;
      }
    } else {
      const cols: ReturnType<typeof caveColumn>[] = [];
      for (let i = 0; i < nx; i++) {
        const x = -P.half + (2 * P.half * i) / (nx - 1);
        cols.push(P.mode === "cave" ? caveColumn(noise, x, 0, P.freq) : null as unknown as ReturnType<typeof caveColumn>);
      }
      colAt = (x: number) => {
        const t = ((x + P.half) / (2 * P.half)) * (nx - 1);
        const i = clamp(Math.round(t), 0, nx - 1);
        return cols[i];
      };
    }
    for (let py = 0; py < H; py++) {
      const z = z1 - ((z1 - z0) * py) / (H - 1);
      for (let px = 0; px < W; px++) {
        const x = -P.half + (2 * P.half * px) / (W - 1);
        let d: number;
        if (heights) {
          const t = ((x + P.half) / (2 * P.half)) * (nx - 1);
          const i = clamp(Math.round(t), 0, nx - 1);
          d = z - heights[i];
        } else {
          d = caveDensity(z, colAt!(x)!);
        }
        let r: number, g: number, b: number;
        const shade = clamp(0.35 + 0.65 * (Math.abs(d) / 150), 0, 1);
        if (d < 0) {
          r = 128 * shade + 20;
          g = 104 * shade + 14;
          b = 84 * shade + 10;
        } else {
          r = 46 * shade + 8;
          g = 58 * shade + 12;
          b = 76 * shade + 18;
        }
        if (Math.abs(d) < 3) {
          r = 232; g = 210; b = 150;
        }
        const o = (py * W + px) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  /* ---------- 体渲染生成 ---------- */
  const generate = () => {
    const scene = sceneRef.current;
    if (!rendererRef.current || !scene) return;
    const token = ++genTokenRef.current;
    const tokenObj = { cancelled: false };
    setBusy(true);
    setProgress(0);
    window.setTimeout(async () => {
      try {
        const t0 = performance.now();
        const P = paramsRef.current;
        const noise = new VoxelNoise(P.seed);
        const [z0, z1] = zRange(P.mode);
        const bounds: VolumeBounds = { x0: -P.half, x1: P.half, y0: -P.half, y1: P.half, z0, z1 };

        buildCrossSection(P, noise);

        const grid = await sampleVolume(
          noise, P.mode, bounds, P.N, P.freq, tokenObj, (p) => setProgress(p),
          { seed: P.seed, dunes, region }
        );
        if (tokenObj.cancelled || !grid) return;

        const res = marchTetrahedra(grid);
        if (token !== genTokenRef.current) return;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(res.positions, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(res.normals, 3));
        const colors = new Float32Array(res.positions.length);
        for (let i = 0; i < res.vertices; i++) {
          const zVox = res.positions[i * 3 + 1];
          const t = clamp((zVox - z0) / (z1 - z0 || 1), 0, 1);
          const c = heightColor(t);
          colors[i * 3]     = Math.min(1, srgbToLinear(c[0] / 255) * 1.15);
          colors[i * 3 + 1] = Math.min(1, srgbToLinear(c[1] / 255) * 1.15);
          colors[i * 3 + 2] = Math.min(1, srgbToLinear(c[2] / 255) * 1.15);
        }
        geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        geo.setIndex(new THREE.BufferAttribute(res.indices, 1));

        if (meshRef.current) {
          meshRef.current.geometry.dispose();
          (meshRef.current.material as THREE.Material).dispose();
          scene.remove(meshRef.current);
        }
        const mat = new THREE.MeshStandardMaterial({
          roughness: 0.78,
          metalness: 0,
          vertexColors: true,
          side: THREE.DoubleSide,
          wireframe: P.wireframe,
          flatShading: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const s = P.voxel;
        mesh.scale.set(s, s, s);
        mesh.position.set(0, 0, 0);
        meshRef.current = mesh;
        scene.add(mesh);

        // 相机适配（V2：near/far/雾随跨度自适应，远距渲染避免 Z-fighting 与被雾吞没）
        const camera = cameraRef.current!;
        const controls = controlsRef.current!;
        const spanX = 2 * P.half * s;
        const spanZ = (z1 - z0) * s;
        const big = Math.max(spanX, spanZ);
        camera.position.set(spanX * 0.5, Math.max(300, spanZ * 0.5), spanX * 0.62);
        camera.near = Math.max(0.1, big * 0.001);
        camera.far = big * 12 + 100000;
        camera.updateProjectionMatrix();
        if (scene.fog) (scene.fog as THREE.FogExp2).density = 0.15 / big;
        controls.target.set(0, ((z0 + z1) / 2) * s * 0.4, 0);
        controls.minDistance = Math.max(40, spanX * 0.06);
        controls.maxDistance = Math.max(spanX * 5, big * 8);
        controls.update();

        const ms = Math.round(performance.now() - t0);
        setStatus({
          error: false,
          ms,
          text:
            `Mode ${spec.n}: ${spec.short} | Seed: ${P.seed} | Freq: ${P.freq.toFixed(2)} | ${spec.isVolumetric ? "3D SDF" : "Thin-shell SDF"}\n` +
            `Volume: ${P.N}³ = ${(P.N ** 3).toLocaleString()} samples | Box: ${2 * P.half}×${2 * P.half}×${z1 - z0} voxel\n` +
            `Extent: ${(2 * P.half * s).toLocaleString()}×${(2 * P.half * s).toLocaleString()} m (voxel ${s}m) | 间距 ${((2 * P.half * s) / P.N).toFixed(1)}m/voxel\n` +
            `Mesh: ${res.vertices.toLocaleString()} verts | ${res.triangles.toLocaleString()} tris\n` +
            `耗时 ${ms}ms | Cliffs(p 依赖 Z · GPT) | 梯度法线（有限差分）`,
        });
      } catch (e) {
        setStatus({ error: true, ms: 0, text: "Error: " + (e instanceof Error ? e.message : String(e)) });
      } finally {
        if (token === genTokenRef.current) {
          setBusy(false);
          setProgress(null);
        }
      }
    }, 30);
  };

  /* ---------- Three.js 初始化 ---------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a313a);
    scene.fog = new THREE.FogExp2(0x4a5a6a, 0.00006);
    const camera = new THREE.PerspectiveCamera(55, wrap.clientWidth / Math.max(1, wrap.clientHeight), 0.1, 30000);
    camera.position.set(900, 700, 1100);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.49;

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.8);
    sun.position.set(-900, 1600, 700);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x88a8d8, 1.0);
    fill.position.set(800, 600, -400);
    scene.add(fill);
    scene.add(new THREE.HemisphereLight(0xc8d8e8, 0x4a3a30, 1.4));
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;

    const resize = () => {
      const w = wrap.clientWidth;
      const h = Math.max(1, wrap.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    let raf = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (meshRef.current) {
        meshRef.current.geometry.dispose();
        (meshRef.current.material as THREE.Material).dispose();
      }
      renderer.dispose();
    };
  }, []);

  /* ---------- 参数变化 → 重新生成 ---------- */
  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  /* 线框即时切换（不重采样） */
  useEffect(() => {
    if (meshRef.current) (meshRef.current.material as THREE.MeshStandardMaterial).wireframe = params.wireframe;
  }, [params.wireframe]);

  const randomSeed = () => {
    const s = Math.floor(Math.random() * 999999);
    paramsRef.current = { ...paramsRef.current, seed: s };
    setParams((p) => ({ ...p, seed: s }));
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-ink text-paper">
      {/* 顶栏 */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-panel px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-amber font-mono text-[13px] font-bold text-ink">
            CV2
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-display text-[16px] font-bold leading-tight tracking-wide">
              Voxel Cave Lab V2 <span className="text-amber">·</span>{" "}
              <span className="text-[13px] font-semibold text-mute">GPT · 远距渲染</span>
            </h1>
            <p className="truncate text-[11px] text-mute">
              ChatGPT 修复的 Cliffs（p 依赖 Z） + 扩展采样上限（N≤160 · half≤4000 · voxel≤40）
            </p>
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <span className="rounded-md border border-line bg-card px-2.5 py-1 font-mono text-[10px] text-mute">
            MODE <b className="text-[11px] text-amber tabular-nums">{spec.n}·{spec.short}</b>
          </span>
          <span className="rounded-md border border-line bg-card px-2.5 py-1 font-mono text-[10px] text-mute">
            SEED <b className="text-[11px] text-amber tabular-nums">{params.seed}</b>
          </span>
          <span className="rounded-md border border-line bg-card px-2.5 py-1 font-mono text-[10px] text-mute">
            VOL <b className="text-[11px] text-amber tabular-nums">{params.N}³</b>
          </span>
          <span
            className={`ml-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] ${
              busy ? "border-warn/50 text-warn" : "border-line text-mute"
            }`}
          >
            <i className={`h-1.5 w-1.5 rounded-full ${busy ? "animate-pulse bg-warn" : "bg-ok"}`} />
            {busy ? "MARCHING…" : "READY"}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        {/* 控制面板 */}
        <aside className="lab-scroll w-[380px] shrink-0 overflow-y-auto border-r border-line bg-panel px-4 py-4">
          <Group
            n="1"
            title="体积示例（VoxelPlugin Density · 1~7 + Hybrid 8~13）"
            note="13 个体密度算法。Cliffs 用 ChatGPT 修复版：p = clamp((Z/50+0.2·sides)·10, 0, 1) 显式依赖查询 Z（3D 自指型），marching 同时找到 z=0 与 z=50+top 两个零交叉，形成台地顶面 + 崖壁。sides 噪声偏移用 n.pOffset(1)，与 mountain_terrain_demo (3).html 逐位一致。"
          >
            <label className="mb-1 block text-[11px] text-mute">Mode</label>
            <select
              value={params.mode}
              onChange={(e) => set("mode", e.target.value as ExampleMode)}
              className="mb-2.5 w-full rounded-md border border-edge bg-ink px-2.5 py-1.5 font-mono text-[12px] text-paper outline-none focus:border-amber"
            >
              <optgroup label="── VoxelExample 原版 1~7 ──">
                {MODE_SPECS.filter((s) => s.n <= 7).map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </optgroup>
              <optgroup label="── Hybrid 8~13（TerrainLab 改写） ──">
                {MODE_SPECS.filter((s) => s.n > 7).map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </optgroup>
            </select>
            <pre className="rounded-md border border-line bg-ink px-2.5 py-2 font-mono text-[10px] leading-relaxed text-warn whitespace-pre-wrap">
              {spec.formula}
            </pre>
          </Group>

          <Group
            n="2"
            title="采样体积（V2 · 扩展上限）"
            note="V2 版大幅提高采样上限以支持远距地形：half 到 4000 体素（配 voxel=40 达 320km 跨度）、N 到 160、voxel 到 40m、freq 到 10。注意 N³ 与噪声求值次数随 N 立方增长，N≥128 时生成显著变慢、内存上升。"
          >
            <Slider label="体分辨率 N（每轴）" value={params.N} min={24} max={160} step={4} decimals={0} onChange={(v) => set("N", v)} />
            <Slider label="XY 半尺寸 (voxel)" value={params.half} min={100} max={4000} step={25} decimals={0} onChange={(v) => set("half", v)} />
            <Slider label="频率缩放 Freq" value={params.freq} min={0.2} max={10} step={0.05} decimals={2} onChange={(v) => set("freq", v)} />
            <div className="mb-2 rounded-md border border-line bg-ink px-2.5 py-1.5 font-mono text-[10.5px] text-mute">
              Z 范围（{spec.short}）：{zRange(params.mode)[0]} … {zRange(params.mode)[1]} voxel
              {" "}<span className="text-mute/60">· {spec.isVolumetric ? "体 SDF" : "薄壳 h-Z"}</span>
            </div>
            <Slider label="体素尺寸 (m/voxel，仅显示)" value={params.voxel} min={1} max={40} step={0.5} decimals={1} onChange={(v) => set("voxel", v)} />
            <div className="rounded-md border border-line bg-ink/60 px-2.5 py-1.5 font-mono text-[10px] text-mute">
              物理跨度 = 2×half×voxel = {" "}
              <b className="text-amber">{(2 * params.half * params.voxel).toLocaleString()} m</b>
            </div>
          </Group>

          {spec.needsDunes && (
            <Group
              n="2.5"
              title="Dunes 风向量（2 / 8 / 13 模式用）"
              note="沙丘脊线近似垂直于风向 (dx, dy)。Hybrid 8/13 内部用 dunesHeight 算子。"
            >
              <Slider label="Wind X" value={params.windX} min={-1} max={1} step={0.05} decimals={2} onChange={(v) => set("windX", v)} />
              <Slider label="Wind Y" value={params.windY} min={-1} max={1} step={0.05} decimals={2} onChange={(v) => set("windY", v)} />
            </Group>
          )}

          {params.mode === "region_driven" && (
            <Group
              n="2.6"
              title="区域参数（Hybrid 13 用）"
              note="5 个 fbm2 低频连续噪声场 smoothstep 出来的区域掩码。regionScale 决定区域颗粒大小，regionThreshold 控制区域覆盖比例。"
            >
              <Slider label="区域尺度 Region Scale" value={params.regionScale} min={0.0001} max={0.005} step={0.0001} decimals={4} onChange={(v) => set("regionScale", v)} />
              <Slider label="区域门槛 Region Threshold" value={params.regionThreshold} min={0.1} max={0.55} step={0.01} decimals={2} onChange={(v) => set("regionThreshold", v)} />
            </Group>
          )}

          <Group n="3" title="渲染">
            <Check label="线框模式（Wireframe）" checked={params.wireframe} onChange={(v) => set("wireframe", v)} />
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => generate()}
                disabled={busy}
                className="flex-1 rounded-md bg-amber px-3 py-1.5 font-mono text-[11px] font-bold tracking-wider text-ink transition-colors hover:bg-amber/85 disabled:opacity-40"
              >
                REGENERATE
              </button>
              <button
                onClick={randomSeed}
                disabled={busy}
                className="flex-1 rounded-md border border-amber/60 px-3 py-1.5 font-mono text-[11px] font-bold tracking-wider text-amber transition-colors hover:bg-amber/10 disabled:opacity-40"
              >
                RANDOM SEED
              </button>
            </div>
          </Group>

          <Group n="4" title="噪声对齐（VoxelFastNoise 复刻）">
            <pre className="rounded-md border border-line bg-ink px-2.5 py-2 font-mono text-[10px] leading-relaxed text-mute whitespace-pre-wrap">
              {`· MT19937 + uniform 拒绝采样
· buildPerm 保留 256-j 历史 bug
· 12 梯度 LUT · Quintic + 解析导数
· FBM FractalBounding 归一化
· IQNoise：40° 旋转域 + 导数加权
· Erosion：5×5 流向核（murmur32）
同 Seed 下与 VoxelPlugin 逐位一致`}
            </pre>
          </Group>

          <section className="mb-3.5">
            <pre
              className={`min-h-[110px] rounded-md border px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap ${
                status?.error ? "border-coral/60 bg-ink text-coral" : "border-line bg-ink text-warn"
              }`}
            >
              {busy && progress !== null
                ? `Sampling… ${Math.round(progress * 100)}%`
                : status
                  ? status.text
                  : "等待首次生成…"}
            </pre>
          </section>
        </aside>

        {/* 视图区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={wrapRef} className="relative min-h-0 flex-1 bg-[#95aab9]">
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
            <div className="pointer-events-none absolute top-3 left-3 z-10 rounded bg-black/55 px-2.5 py-1 font-mono text-[11px] tracking-wider text-white">
              3D ISOSURFACE — DENSITY = 0 (MARCHING TETRAHEDRA) · {spec.short} · V2
            </div>
            <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded bg-black/45 px-2.5 py-1 font-mono text-[10px] text-white/85">
              拖拽旋转 · 滚轮缩放 · 右键平移 · 法线 = ∇density（有限差分）
            </div>
            {busy && (
              <div className="absolute top-3 right-3 z-10 animate-pulse rounded bg-black/55 px-2.5 py-1 font-mono text-[11px] text-warn tabular-nums">
                SAMPLING VOLUME… {progress !== null ? `${Math.round(progress * 100)}%` : ""}
              </div>
            )}
          </div>

          <div className="flex h-[236px] shrink-0 flex-col border-t-2 border-edge bg-[#0b0f14] px-3 pt-2 pb-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-wider text-mute">
                密度剖面 · X-Z 切片（Y=0）· 金色线 = density 0 等值线
              </span>
              <span className="font-mono text-[10px] text-mute/70">暖色=实体( d&lt;0 ) · 冷色=空气( d&gt;0 )</span>
            </div>
            <canvas
              ref={crossRef}
              width={1024}
              height={190}
              className="min-h-0 w-full flex-1 rounded-sm border border-line bg-ink"
              style={{ imageRendering: "pixelated" }}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * 高度着色 ramp（体素 Z 归一化 t → RGB）。
 * 深绿(植被)→橄榄→沙土→灰岩→雪线。
 * 所有 RGB 数值按 sRGB 写出，写入 BufferAttribute 前必须 srgbToLinear。
 */
function heightColor(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.00, [34, 63, 44]],
    [0.18, [69, 104, 73]],
    [0.38, [124, 128, 79]],
    [0.56, [160, 130, 91]],
    [0.72, [126, 112, 104]],
    [0.86, [198, 201, 196]],
    [1.00, [250, 250, 250]],
  ];
  let i = 0;
  while (i < stops.length - 1 && t > stops[i + 1][0]) i++;
  const a = stops[i];
  const b = stops[Math.min(i + 1, stops.length - 1)];
  const u = (t - a[0]) / (b[0] - a[0] || 1);
  return [
    a[1][0] + (b[1][0] - a[1][0]) * u,
    a[1][1] + (b[1][1] - a[1][1]) * u,
    a[1][2] + (b[1][2] - a[1][2]) * u,
  ];
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}