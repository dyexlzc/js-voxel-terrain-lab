import { useState } from "react";
import TerrainLab from "./components/TerrainLab";
import CaveLab from "./components/CaveLab";

type Tab = "terrain" | "cave";

const TABS: { id: Tab; label: string; sub: string }[] = [
  { id: "terrain", label: "Terrain Lab", sub: "Noise Router 主地形（平原/高原/山脉/大湖）" },
  { id: "cave", label: "Cave Lab", sub: "3D SDF → Marching Tetrahedra（VoxelPlugin Cave）" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("terrain");

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-ink text-paper">
      {/* 页签栏：两个 Lab 各自持有独立 Three.js 场景，切换时卸载以释放 WebGL 上下文 */}
      <nav className="flex shrink-0 items-stretch gap-px border-b border-line bg-panel">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`group flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left transition-colors ${
              tab === t.id ? "bg-card" : "hover:bg-card/60"
            }`}
          >
            <span
              className={`h-6 w-1 shrink-0 rounded-sm transition-colors ${
                tab === t.id ? "bg-amber" : "bg-line group-hover:bg-mute/50"
              }`}
            />
            <span className="min-w-0">
              <span
                className={`block truncate font-display text-[13px] font-bold leading-tight tracking-wide ${
                  tab === t.id ? "text-paper" : "text-mute"
                }`}
              >
                {t.label}
              </span>
              <span className="block truncate text-[10.5px] leading-tight text-mute/80">{t.sub}</span>
            </span>
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1">
        {tab === "terrain" ? <TerrainLab /> : <CaveLab />}
      </div>
    </div>
  );
}
