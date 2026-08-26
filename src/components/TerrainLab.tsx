import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TerrainModel } from "../terrain/model";
import { clamp } from "../terrain/noise";
import { DEFAULT_PARAMS, clampParams, effectiveResolution, type TerrainParams } from "../terrain/params";

const RES_FIXED = [128, 256, 384, 512, 768, 1024, 1536];

/* ---------------- 小型 UI 构件 ---------------- */

function Group({
  n,
  title,
  children,
  note,
  badge,
}: {
  n: string;
  title: string;
  children: ReactNode;
  note?: string;
  badge?: string;
}) {
  return (
    <section
      className={`mb-3.5 rounded-lg border bg-card p-3.5 ${
        badge ? "border-amber/50 shadow-[0_0_0_1px_rgba(255,180,84,0.12),0_6px_24px_-12px_rgba(255,180,84,0.35)]" : "border-line"
      }`}
    >
      <h3 className="mb-2.5 flex items-center gap-2 font-display text-[13px] font-semibold tracking-wide text-paper">
        <span
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-sm font-mono text-[10px] font-bold ${
            badge ? "bg-amber text-ink" : "bg-amber/15 text-amber"
          }`}
        >
          {n}
        </span>
        {title}
        {badge && (
          <span className="ml-auto rounded-sm bg-amber/15 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-widest text-amber">
            {badge}
          </span>
        )}
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
  label,
  value,
  min,
  max,
  step,
  decimals,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="text-[11px] text-mute">{label}</span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-amber">{value.toFixed(decimals)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer accent-amber"
      />
    </div>
  );
}

function Num({
  label,
  value,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] text-mute">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className="w-full rounded-md border border-edge bg-ink px-2.5 py-1.5 font-mono text-[12px] text-paper outline-none transition-colors focus:border-amber disabled:opacity-40"
      />
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-[12.5px] text-paper/90 select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-amber"
      />
      {label}
    </label>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5 rounded-md border border-line bg-card px-2.5 py-1 font-mono text-[10px] text-mute">
      {label}
      <b className="text-[11px] text-amber tabular-nums">{value}</b>
    </span>
  );
}

/* ---------------- 主组件 ---------------- */

interface StatusInfo {
  text: string;
  ms: number;
  error: boolean;
}

interface CoverageItem {
  label: string;
  color: string;
  pct: number;
}

export default function TerrainLab() {
  const [params, setParams] = useState<TerrainParams>(DEFAULT_PARAMS);
  const [auto, setAuto] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [coverage, setCoverage] = useState<CoverageItem[]>([]);
  const [progress, setProgress] = useState<number | null>(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const surfaceWrapRef = useRef<HTMLDivElement>(null);
  const threeCanvasRef = useRef<HTMLCanvasElement>(null);
  const crossRef = useRef<HTMLCanvasElement>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const waterMeshRef = useRef<THREE.Mesh | null>(null);
  const gridRef = useRef<THREE.LineSegments | null>(null);
  const genTokenRef = useRef(0);

  const set = <K extends keyof TerrainParams>(key: K, value: TerrainParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const autoMode = params.sampleMode === "auto";

  /* 实时生效分辨率与密度（随参数即时联动） */
  const effRes = effectiveResolution(clampParams(params));
  const mPerVertex = Math.max(params.worldSizeX, params.worldSizeY) / effRes;
  const isAutoRes = params.resolution === "auto";

  /* ---------- 构建函数 ---------- */

  const buildSurface = async (
    P: TerrainParams,
    model: TerrainModel,
    token: number,
    onProgress: (p: number) => void
  ): Promise<boolean> => {
    const scene = sceneRef.current;
    if (!scene) return false;
    const sizeX = P.worldSizeX;
    const sizeY = P.worldSizeY;
    const res = effectiveResolution(P);
    const M = Math.max(1, model.M);

    const geo = new THREE.PlaneGeometry(sizeX, sizeY, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position.array as Float32Array;
    const colors = new Float32Array(pos.length);
    const spanX = P.sampleXMax - P.sampleXMin;
    const spanY = P.sampleYMax - P.sampleYMin;

    const counts: Record<string, number> = { dune: 0, cliff: 0, ravine: 0, erosion: 0, iq: 0, plains: 0, ocean: 0 };

    /* 分块：每 chunk 行让出一帧，避免高分辨率卡死主线程 */
    const chunk = Math.max(8, Math.round(res / 48));

    for (let i = 0; i < res; i++) {
      if (i > 0 && i % chunk === 0) {
        if (token !== genTokenRef.current) {
          geo.dispose();
          return false;
        }
        onProgress(i / res);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      for (let j = 0; j < res; j++) {
        const idx = i * res + j;
        const lx = pos[idx * 3];
        const lz = pos[idx * 3 + 2];
        const nx = lx / sizeX + 0.5;
        const ny = lz / sizeY + 0.5;
        const sx = P.sampleXMin + spanX * nx;
        const sy = P.sampleYMin + spanY * ny;
        const s = model.sampleSurface(sx, sy);
        const h = s.h;
        pos[idx * 3 + 1] = h;

        /* 区域覆盖统计 */
        if (s.landMask < 0.35) {
          counts.ocean++;
        } else if (s.regionMax > 0.08) {
          const r = s.regions;
          let best = "plains";
          let bv = 0;
          const entries: [string, number][] = [
            ["dune", r.duneMask],
            ["cliff", r.cliffMask],
            ["ravine", r.ravMask],
            ["erosion", r.eroMask],
            ["iq", r.iqMask],
          ];
          for (const [kk, mm] of entries) {
            if (mm > bv) {
              bv = mm;
              best = kk;
            }
          }
          counts[best]++;
        } else {
          counts.plains++;
        }

        /* 高度着色 + 区域染色 */
        let r: number, g: number, b: number;
        const sandH = Math.max(2, M * 0.02);
        const grassH = Math.max(12, M * 0.14);
        const forestH = Math.max(35, M * 0.34);
        const rockH = Math.max(80, M * 0.64);
        const rm = clamp(s.riverMask, 0, 1);

        if (rm > 0.35) {
          r = 0.13; g = 0.33; b = 0.52;
          if (h < 0) { r = 0.1; g = 0.25; b = 0.45; }
        } else if (h < 0) { r = 0.3; g = 0.28; b = 0.23; }
        else if (h < sandH) { r = 0.8; g = 0.72; b = 0.5; }
        else if (h < grassH) { r = 0.27; g = 0.47; b = 0.18; }
        else if (h < forestH) { r = 0.17; g = 0.36; b = 0.12; }
        else if (h < rockH) { r = 0.47; g = 0.43; b = 0.38; }
        else { r = 0.95; g = 0.95; b = 0.98; }

        const reg = s.regions;
        const tintStrength = 0.35;
        if (reg.duneMask > 0.15) { const t = clamp(reg.duneMask, 0, 1) * tintStrength; r = r * (1 - t) + 0.85 * t; g = g * (1 - t) + 0.75 * t; b = b * (1 - t) + 0.45 * t; }
        if (reg.cliffMask > 0.15) { const t = clamp(reg.cliffMask, 0, 1) * tintStrength; r = r * (1 - t) + 0.5 * t; g = g * (1 - t) + 0.42 * t; b = b * (1 - t) + 0.35 * t; }
        if (reg.ravMask > 0.15) { const t = clamp(reg.ravMask, 0, 1) * tintStrength; r = r * (1 - t) + 0.3 * t; g = g * (1 - t) + 0.45 * t; b = b * (1 - t) + 0.28 * t; }
        if (reg.eroMask > 0.15) { const t = clamp(reg.eroMask, 0, 1) * tintStrength; r = r * (1 - t) + 0.55 * t; g = g * (1 - t) + 0.48 * t; b = b * (1 - t) + 0.38 * t; }
        if (reg.iqMask > 0.15) { const t = clamp(reg.iqMask, 0, 1) * tintStrength; r = r * (1 - t) + 0.6 * t; g = g * (1 - t) + 0.62 * t; b = b * (1 - t) + 0.7 * t; }

        if (h > M * 0.55 && s.mountainMask > 0.2) {
          const snow = clamp((h - M * 0.55) / (M * 0.1), 0, 1);
          r = r * (1 - snow) + 0.95 * snow;
          g = g * (1 - snow) + 0.95 * snow;
          b = b * (1 - snow) + 0.98 * snow;
        }

        colors[idx * 3] = r;
        colors[idx * 3 + 1] = g;
        colors[idx * 3 + 2] = b;
      }
    }

    if (token !== genTokenRef.current) {
      geo.dispose();
      return false;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    if (terrainMeshRef.current) {
      terrainMeshRef.current.geometry.dispose();
      terrainMeshRef.current.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      terrainMeshRef.current = mesh;
    }

    const total = res * res;
    const pct = (n: number) => (n / total) * 100;
    setCoverage([
      { label: "沙丘区", color: "#c2a64a", pct: pct(counts.dune) },
      { label: "悬崖区", color: "#8a6f5c", pct: pct(counts.cliff) },
      { label: "峡谷区", color: "#5d7a52", pct: pct(counts.ravine) },
      { label: "侵蚀区", color: "#9a8266", pct: pct(counts.erosion) },
      { label: "IQ山脉", color: "#8fa3b8", pct: pct(counts.iq) },
      { label: "平原", color: "#4f7a3a", pct: pct(counts.plains) },
      { label: "海洋", color: "#1a6baa", pct: pct(counts.ocean) },
    ]);
    return true;
  };

  const buildCrossSection = (P: TerrainParams, model: TerrainModel) => {
    const canvas = crossRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const hC = canvas.height;
    const img = ctx.createImageData(w, hC);
    const M = Math.max(1, model.M);
    const minY = -Math.max(40, M * 0.3);
    const maxY = Math.max(160, M * 1.3);
    const syC = (P.sampleYMin + P.sampleYMax) * 0.5;
    const spanX = P.sampleXMax - P.sampleXMin;
    const sCache = new Float32Array(w);
    for (let px = 0; px < w; px++) sCache[px] = model.getHeight(P.sampleXMin + spanX * (px / w), syC);

    for (let px = 0; px < w; px++) {
      const cH = sCache[px];
      for (let py = 0; py < hC; py++) {
        const wy = maxY - (py / hC) * (maxY - minY);
        const d = cH - wy;
        const idx = (py * w + px) * 4;
        if (d > 0) {
          const depth = cH - wy;
          if (depth < 3) {
            if (cH < 0) { img.data[idx] = 85; img.data[idx + 1] = 75; img.data[idx + 2] = 60; }
            else if (cH < Math.max(2, M * 0.02)) { img.data[idx] = 195; img.data[idx + 1] = 178; img.data[idx + 2] = 128; }
            else if (cH < Math.max(35, M * 0.34)) { img.data[idx] = 60; img.data[idx + 1] = 115; img.data[idx + 2] = 35; }
            else { img.data[idx] = 115; img.data[idx + 1] = 105; img.data[idx + 2] = 95; }
          } else {
            const sh = clamp(1 - depth / (M * 0.55 + 1), 0.16, 1);
            img.data[idx] = 68 * sh;
            img.data[idx + 1] = 62 * sh;
            img.data[idx + 2] = 56 * sh;
          }
          img.data[idx + 3] = 255;
        } else {
          if (wy < model.sea) {
            const t = clamp(-wy / Math.max(30, M * 0.12), 0, 1);
            img.data[idx] = 12 + 18 * (1 - t);
            img.data[idx + 1] = 52 + 60 * (1 - t);
            img.data[idx + 2] = 110 + 90 * (1 - t);
            img.data[idx + 3] = 255;
          } else {
            img.data[idx] = 135; img.data[idx + 1] = 206; img.data[idx + 2] = 235; img.data[idx + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  const buildTileGrid = (P: TerrainParams, model: TerrainModel) => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (gridRef.current) {
      scene.remove(gridRef.current);
      gridRef.current.geometry.dispose();
      (gridRef.current.material as THREE.Material).dispose();
      gridRef.current = null;
    }
    if (!P.showGrid) return;
    const sizeX = P.worldSizeX;
    const sizeY = P.worldSizeY;
    const tile = Math.max(1, P.tileSize);
    const divX = Math.max(1, Math.round(sizeX / tile));
    const divY = Math.max(1, Math.round(sizeY / tile));
    const vertices: number[] = [];
    for (let i = 0; i <= divX; i++) {
      const x = -sizeX / 2 + i * tile;
      vertices.push(x, 0, -sizeY / 2, x, 0, sizeY / 2);
    }
    for (let j = 0; j <= divY; j++) {
      const z = -sizeY / 2 + j * tile;
      vertices.push(-sizeX / 2, 0, z, sizeX / 2, 0, z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthTest: false });
    const grid = new THREE.LineSegments(geometry, material);
    grid.renderOrder = 999;
    grid.position.y = Math.max(3, model.M * 0.03);
    scene.add(grid);
    gridRef.current = grid;
  };

  const updateCameraForSize = (P: TerrainParams, model: TerrainModel) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const scene = sceneRef.current;
    if (!camera || !controls || !scene) return;
    const s = Math.max(P.worldSizeX, P.worldSizeY);
    camera.near = Math.max(1, s * 0.001);
    camera.far = s * 15 + 50000;
    camera.updateProjectionMatrix();
    if (scene.fog) (scene.fog as THREE.FogExp2).density = 1.2 / s;
    const water = waterMeshRef.current;
    if (water) {
      water.scale.set(P.worldSizeX * 3, 1, P.worldSizeY * 3);
      water.position.set(0, model.sea, 0);
    }
    if (P.fitCamera) {
      camera.position.set(0, s * 0.7, s * 0.5);
      controls.target.set(0, 0, 0);
    }
  };

  /* ---------- 生成入口 ---------- */

  const generate = () => {
    if (!rendererRef.current || !sceneRef.current) return;
    const token = ++genTokenRef.current;
    setBusy(true);
    setProgress(0);
    window.setTimeout(async () => {
      try {
        const t0 = performance.now();
        const P = clampParams(paramsRef.current);
        const model = new TerrainModel(P);
        /* 剖面 / 网格 / 相机先行（同步、快），再异步铺地表 */
        buildCrossSection(P, model);
        buildTileGrid(P, model);
        updateCameraForSize(P, model);
        const ok = await buildSurface(P, model, token, (p) => setProgress(p));
        if (!ok) return; /* 已被更新的生成任务取代 */
        const ms = Math.round(performance.now() - t0);
        const tilesX = Math.max(1, Math.round(P.worldSizeX / P.tileSize));
        const tilesY = Math.max(1, Math.round(P.worldSizeY / P.tileSize));
        const res = effectiveResolution(P);
        const mpv = Math.max(P.worldSizeX, P.worldSizeY) / res;
        setStatus({
          error: false,
          ms,
          text:
            `World: ${P.worldSizeX}×${P.worldSizeY}m | Tiles: ${tilesX}×${tilesY}\n` +
            `Res: ${res}²${P.resolution === "auto" ? " (Auto)" : ""} | Detail: ${mpv.toFixed(1)} m/vertex\n` +
            `Voxel: ${P.voxelSize}m | Tile: ${P.tileSize}m\n` +
            `Sample X: [${Math.round(P.sampleXMin)}, ${Math.round(P.sampleXMax)}]\n` +
            `Sample Y: [${Math.round(P.sampleYMin)}, ${Math.round(P.sampleYMax)}]\n` +
            `Seed: ${P.seed} | Camera: ${P.fitCamera ? "Auto Fit" : "Fixed"} | 耗时 ${ms}ms`,
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

  const generateRef = useRef(generate);
  generateRef.current = generate;

  const randomSeed = () => {
    const s = Math.floor(Math.random() * 99999);
    setParams((p) => ({ ...p, seed: s }));
    paramsRef.current = { ...paramsRef.current, seed: s };
    generateRef.current();
  };

  /* ---------- Three.js 初始化 ---------- */

  useEffect(() => {
    const wrap = surfaceWrapRef.current;
    const canvas = threeCanvasRef.current;
    if (!wrap || !canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.FogExp2(0x87ceeb, 0.0003);
    const camera = new THREE.PerspectiveCamera(60, wrap.clientWidth / Math.max(1, wrap.clientHeight), 1, 500000);
    camera.position.set(4000, 5000, 6000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;

    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(1500, 2500, 1000);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x8899bb, 1.0));

    const waterGeo = new THREE.PlaneGeometry(1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(
      waterGeo,
      new THREE.MeshStandardMaterial({ color: 0x1a6baa, transparent: true, opacity: 0.72, roughness: 0.1, metalness: 0.4 })
    );
    water.receiveShadow = true;
    scene.add(water);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    waterMeshRef.current = water;

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
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    setReady(true);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    };
  }, []);

  /* ---------- 参数变化 → 防抖自动重生成 ---------- */

  useEffect(() => {
    if (!ready || !auto) return;
    const t = window.setTimeout(() => generateRef.current(), 320);
    return () => window.clearTimeout(t);
  }, [params, auto, ready]);

  /* ---------- 视图 ---------- */

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-ink font-body text-paper">
      {/* 头部 */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-panel px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-amber/30 bg-amber/15 text-amber">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 20 10 6l4 7 3-4 4 11H3z" />
              <path d="M2 20h20" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-display text-[16px] font-bold leading-tight tracking-wide">
              VoxelFree Terrain Lab <span className="text-amber">·</span>{" "}
              <span className="text-[13px] font-semibold text-mute">High-Res Organic Regions</span>
            </h1>
            <p className="truncate text-[11px] text-mute">
              大尺度细节恢复：Auto 密度锁定 + 最高 1536 分辨率 + 异步分块生成
            </p>
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <Chip label="SEED" value={String(params.seed)} />
          <Chip label="RES" value={`${effRes}²${isAutoRes ? "·A" : ""}`} />
          <Chip label="DENSITY" value={`${mPerVertex.toFixed(0)}m/v`} />
          <Chip
            label="GEN"
            value={
              busy && progress !== null
                ? `${Math.round(progress * 100)}%`
                : status && !status.error
                  ? `${status.ms}ms`
                  : "—"
            }
          />
          <span
            className={`ml-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] ${
              busy ? "border-warn/50 text-warn" : "border-line text-mute"
            }`}
          >
            <i className={`h-1.5 w-1.5 rounded-full ${busy ? "animate-pulse bg-warn" : "bg-ok"}`} />
            {busy ? "GENERATING" : "READY"}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        {/* 控制面板 */}
        <aside className="lab-scroll w-[392px] shrink-0 overflow-y-auto border-r border-line bg-panel px-4 py-4">
          <Group n="1" title="世界与相机">
            <div className="grid grid-cols-2 gap-2.5">
              <Num label="World Size X (m)" value={params.worldSizeX} step={1000} onChange={(v) => set("worldSizeX", v)} />
              <Num label="World Size Y (m)" value={params.worldSizeY} step={1000} onChange={(v) => set("worldSizeY", v)} />
              <Num label="Voxel Size (m)" value={params.voxelSize} step={0.1} onChange={(v) => set("voxelSize", v)} />
              <Num label="Tile Size (m)" value={params.tileSize} step={100} onChange={(v) => set("tileSize", v)} />
            </div>
            <div className="mt-1.5">
              <Check label="相机自动适配（默认固定）" checked={params.fitCamera} onChange={(v) => set("fitCamera", v)} />
              <Check label="显示 Tile 网格线" checked={params.showGrid} onChange={(v) => set("showGrid", v)} />
            </div>
          </Group>

          <Group n="2" title="采样窗口">
            <div className="mb-2.5">
              <label className="mb-1 block text-[11px] text-mute">Sample Mode</label>
              <select
                value={params.sampleMode}
                onChange={(e) => set("sampleMode", e.target.value as "auto" | "manual")}
                className="w-full rounded-md border border-edge bg-ink px-2.5 py-1.5 font-mono text-[12px] text-paper outline-none focus:border-amber"
              >
                <option value="auto">Auto：跟随 World / Voxel</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Num label="Sample X Min" value={params.sampleXMin} disabled={autoMode} onChange={(v) => set("sampleXMin", v)} />
              <Num label="Sample X Max" value={params.sampleXMax} disabled={autoMode} onChange={(v) => set("sampleXMax", v)} />
              <Num label="Sample Y Min" value={params.sampleYMin} disabled={autoMode} onChange={(v) => set("sampleYMin", v)} />
              <Num label="Sample Y Max" value={params.sampleYMax} disabled={autoMode} onChange={(v) => set("sampleYMax", v)} />
            </div>
          </Group>

          <Group n="3" title="渲染精度" badge="关键">
            <div className="mb-2.5">
              <label className="mb-1 block text-[11px] text-mute">Resolution</label>
              <select
                value={isAutoRes ? "auto" : String(params.resolution)}
                onChange={(e) =>
                  set("resolution", e.target.value === "auto" ? "auto" : parseInt(e.target.value, 10))
                }
                className="w-full rounded-md border border-edge bg-ink px-2.5 py-1.5 font-mono text-[12px] text-paper outline-none focus:border-amber"
              >
                <option value="auto">Auto（密度锁定，推荐）</option>
                {RES_FIXED.slice(0, -1).map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
                <option value={1536}>1536（极高，慢）</option>
              </select>
            </div>
            <div className="mb-2.5">
              <Num
                label="Auto 目标 m/vertex（越小越精细）"
                value={params.targetDensity}
                step={1}
                disabled={!isAutoRes}
                onChange={(v) => set("targetDensity", v)}
              />
            </div>

            {/* 实时密度面板 */}
            <div className="mb-2.5 rounded-md border border-line bg-ink px-3 py-2.5">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-mute">当前顶点间距</span>
                <span className="font-mono text-[15px] font-bold tabular-nums text-amber">
                  {mPerVertex.toFixed(1)} <span className="text-[10px] font-normal text-mute">m/vertex</span>
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between font-mono text-[10px] text-mute">
                <span>生效分辨率 <b className="text-paper">{effRes}²</b></span>
                <span>{(effRes * effRes).toLocaleString()} verts</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-edge/60">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    mPerVertex <= params.targetDensity * 1.15 ? "bg-ok" : mPerVertex <= params.targetDensity * 2.5 ? "bg-warn" : "bg-coral"
                  }`}
                  style={{
                    width: `${clamp((params.targetDensity / mPerVertex) * 100, 6, 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 font-mono text-[9.5px] text-mute/80">
                {mPerVertex <= params.targetDensity * 1.15
                  ? "密度达标 · 细节充分"
                  : mPerVertex <= params.targetDensity * 2.5
                    ? "略低于目标 · 细节轻微损失"
                    : "远超目标 · 大世界建议降低目标值或分块流式"}
              </p>
            </div>

            <div className="border-l-2 border-ok/70 bg-ink/60 px-2.5 py-2 text-[10.5px] leading-relaxed text-mute">
              <b className="text-paper">为什么大地图细节消失？</b>
              <br />
              顶点间距 = WorldSize / Resolution。6000@256 ≈ 23m/vertex；90000@256 ≈ 351m/vertex，小于间距的地貌被混叠抹掉。
              <br />
              <b className="text-ok">Auto 模式</b>按目标 m/vertex 自动提高分辨率（上限 1536）。90000m 想要 23m/vertex 需 ~3840²，超出单网格极限；那种尺度请用 chunk 流式 + LOD。
            </div>
          </Group>

          <Group
            n="4"
            title="有机地貌区域"
            note="使用低频连续噪声生成有机形状区域，每种 Example 地形在对应区域内主导。区域跨越多个 Tile，无格子感。"
          >
            <Slider label="区域尺度 Region Scale" value={params.regionScale} min={0.0001} max={0.005} step={0.0001} decimals={4} onChange={(v) => set("regionScale", v)} />
            <Slider label="区域阈值 Region Threshold" value={params.regionThreshold} min={0.1} max={0.6} step={0.01} decimals={2} onChange={(v) => set("regionThreshold", v)} />
            <div className="mt-1 grid grid-cols-2 gap-x-4">
              <Slider label="Dune 沙丘" value={params.sDune} min={0} max={3} step={0.05} decimals={2} onChange={(v) => set("sDune", v)} />
              <Slider label="Cliff 悬崖" value={params.sCliff} min={0} max={3} step={0.05} decimals={2} onChange={(v) => set("sCliff", v)} />
              <Slider label="Ravine 峡谷" value={params.sRavine} min={0} max={3} step={0.05} decimals={2} onChange={(v) => set("sRavine", v)} />
              <Slider label="Erosion 侵蚀" value={params.sErosion} min={0} max={3} step={0.05} decimals={2} onChange={(v) => set("sErosion", v)} />
              <Slider label="IQNoise 山脉" value={params.sIQ} min={0} max={3} step={0.05} decimals={2} onChange={(v) => set("sIQ", v)} />
              <Slider label="Cave 洞穴" value={params.sCave} min={0} max={3} step={0.05} decimals={2} onChange={(v) => set("sCave", v)} />
            </div>
            <div className="mt-2 border-t border-line pt-2.5">
              <p className="mb-1.5 font-mono text-[10px] tracking-wider text-mute">实时区域覆盖率（占地表采样）</p>
              {coverage.length === 0 ? (
                <p className="text-[11px] text-mute/70">生成后显示…</p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  {coverage.map((c) => (
                    <span key={c.label} className="flex items-center gap-1.5 rounded border border-line bg-ink px-2 py-1 text-[10.5px] text-paper/85">
                      <i className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: c.color }} />
                      {c.label}
                      <b className="ml-auto font-mono text-mute tabular-nums">{c.pct.toFixed(1)}%</b>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Group>

          <Group
            n="5"
            title="山脉 · 高原 · 平原合成"
            note="Minecraft 1.18 式气候分带：低侵蚀带出全高山脉（PV 折叠噪声形成环状山脊+围谷+尖峰），中侵蚀带山体被削平为台地高原（软量化阶梯边缘），高侵蚀带起伏压缩为成片平原。每个「山脉区域」内仍保持主峰最高、外围次级山脉的层级。"
          >
            <div className="grid grid-cols-2 gap-x-4">
              <Slider label="区域尺寸 (m)" value={params.massifRegion} min={400} max={12000} step={100} decimals={0} onChange={(v) => set("massifRegion", v)} />
              <Slider label="区域山峰密度" value={params.massifDensity} min={0.05} max={1} step={0.01} decimals={2} onChange={(v) => set("massifDensity", v)} />
              <Slider label="高原强度" value={params.plateauStrength} min={0} max={1} step={0.01} decimals={2} onChange={(v) => set("plateauStrength", v)} />
              <Slider label="高原抬升" value={params.plateauLift} min={0} max={0.4} step={0.01} decimals={2} onChange={(v) => set("plateauLift", v)} />
              <Slider label="平原化强度" value={params.plainStrength} min={0} max={1} step={0.01} decimals={2} onChange={(v) => set("plainStrength", v)} />
              <Slider label="Warp" value={params.warp} min={0} max={6} step={0.05} decimals={2} onChange={(v) => set("warp", v)} />
              <Slider label="Mountain Erosion" value={params.mountainErosion} min={0} max={1.5} step={0.01} decimals={2} onChange={(v) => set("mountainErosion", v)} />
              <Slider label="River Strength" value={params.riverStrength} min={0} max={3} step={0.05} decimals={2} onChange={(v) => set("riverStrength", v)} />
              <Slider label="River Width" value={params.riverWidth} min={0} max={3} step={0.05} decimals={2} onChange={(v) => set("riverWidth", v)} />
            </div>
          </Group>

          <Group n="6" title="全局参数">
            <div className="grid grid-cols-2 gap-2.5">
              <Num label="Seed" value={params.seed} step={1} onChange={(v) => set("seed", v)} />
              <Num label="Max Mountain (m)" value={params.maxMountain} step={1} onChange={(v) => set("maxMountain", v)} />
            </div>
            <div className="mt-2">
              <Slider label="Vertical Scale" value={params.verticalScale} min={0.05} max={10} step={0.05} decimals={2} onChange={(v) => set("verticalScale", v)} />
              <Slider label="Frequency Scale" value={params.freqScale} min={0.02} max={20} step={0.02} decimals={2} onChange={(v) => set("freqScale", v)} />
            </div>
          </Group>

          <section className="mb-3.5 rounded-lg border border-line bg-card p-3.5">
            <button
              onClick={generate}
              className="w-full rounded-md bg-amber py-2.5 font-display text-[13px] font-bold text-ink transition hover:brightness-110 active:scale-[0.98]"
            >
              重新生成地形
            </button>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                onClick={randomSeed}
                className="rounded-md border border-edge bg-ink py-2 font-mono text-[12px] text-paper transition hover:border-amber hover:text-amber active:scale-[0.98]"
              >
                随机 Seed
              </button>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-edge bg-ink py-2 font-mono text-[12px] text-paper select-none">
                <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-3.5 w-3.5 accent-amber" />
                自动更新
              </label>
            </div>
            {busy && progress !== null && (
              <div className="mt-2.5">
                <div className="h-1.5 w-full overflow-hidden rounded-sm bg-edge/50">
                  <div
                    className="h-full rounded-sm bg-amber transition-[width] duration-100 ease-linear"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <p className="mt-1 font-mono text-[10px] text-warn/80 tabular-nums">
                  正在分块采样地表 {Math.round(progress * 100)}% ·{" "}
                  {(effRes * effRes).toLocaleString()} 个采样点
                </p>
              </div>
            )}
            <pre
              className={`mt-2.5 min-h-[96px] rounded-md border px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap ${
                status?.error ? "border-coral/60 bg-ink text-coral" : "border-line bg-ink text-warn"
              }`}
            >
              {busy && progress !== null
                ? `Generating… Surface ${Math.round(progress * 100)}%`
                : status
                  ? status.text
                  : "等待首次生成…"}
            </pre>
          </section>
        </aside>

        {/* 视图区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={surfaceWrapRef} className="relative min-h-0 flex-[2] bg-[#7da7d0]">
            <canvas ref={threeCanvasRef} className="absolute inset-0 h-full w-full" />
            <div className="pointer-events-none absolute top-3 left-3 z-10 rounded bg-black/55 px-2.5 py-1 font-mono text-[11px] tracking-wider text-white">
              3D SURFACE — HIGH-RES ORGANIC REGIONS
            </div>
            <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded bg-black/45 px-2.5 py-1 font-mono text-[10px] text-white/85">
              拖拽旋转 · 滚轮缩放 · 右键平移
            </div>
            {busy && (
              <div className="absolute top-3 right-3 z-10 animate-pulse rounded bg-black/55 px-2.5 py-1 font-mono text-[11px] text-warn tabular-nums">
                SAMPLING TERRAIN… {progress !== null ? `${Math.round(progress * 100)}%` : ""}
              </div>
            )}
          </div>

          <div className="flex h-[248px] shrink-0 flex-col border-t-2 border-edge bg-[#0b0f14] px-3 pt-2 pb-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-wider text-mute">
                2D CROSS-SECTION · 世界中线剖面（Sample Y 中点）
              </span>
              <span className="font-mono text-[10px] text-mute/70">1024 × 220 · pixelated</span>
            </div>
            <canvas
              ref={crossRef}
              width={1024}
              height={220}
              className="min-h-0 w-full flex-1 rounded-sm border border-line bg-[#7da7d0]"
              style={{ imageRendering: "pixelated" }}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
