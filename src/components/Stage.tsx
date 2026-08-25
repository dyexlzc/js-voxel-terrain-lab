import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BURST_GLYPHS, GREETINGS, TICKER_TEXT } from "../data/greetings";
import { useScramble } from "../hooks/useScramble";
import Telemetry from "./Telemetry";

interface Ripple {
  id: number;
  x: number;
  y: number;
  glyph: string;
  dx: number;
  dy: number;
  rot: number;
  hue: string;
}

const RING_COLORS = ["border-aqua/70", "border-amber/70", "border-coral/70"];
const pad = (n: number) => String(n).padStart(2, "0");

export default function Stage({ onReplay }: { onReplay: () => void }) {
  const [idx, setIdx] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [sent, setSent] = useState(1);
  const [taps, setTaps] = useState(0);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [now, setNow] = useState(() => new Date());
  const rootRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  const greeting = GREETINGS[idx];
  const display = useScramble(greeting.text);

  /* 实时时钟 */
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  /* 自动轮换问候 */
  useEffect(() => {
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % GREETINGS.length);
      setSent((s) => s + 1);
    }, 4600);
    return () => clearInterval(t);
  }, [nonce]);

  const next = useCallback(() => {
    setIdx((i) => (i + 1) % GREETINGS.length);
    setSent((s) => s + 1);
    setNonce((n) => n + 1);
  }, []);

  /* 点击涟漪 + 符号迸发 */
  const handleTap = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const id = ++idRef.current;
    const ripple: Ripple = {
      id,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      glyph: BURST_GLYPHS[id % BURST_GLYPHS.length],
      dx: -60 + Math.random() * 120,
      dy: -90 - Math.random() * 50,
      rot: -50 + Math.random() * 100,
      hue: RING_COLORS[id % RING_COLORS.length],
    };
    setRipples((r) => [...r.slice(-9), ripple]);
    setTaps((t) => t + 1);
  };

  const removeRipple = (id: number) => setRipples((r) => r.filter((x) => x.id !== id));

  const popLetter = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const el = e.currentTarget;
    el.classList.remove("letter-pop");
    void el.offsetWidth;
    el.classList.add("letter-pop");
  };

  const vw = Math.min(19, 132 / greeting.text.length);
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const dateStr = `${now.getMonth() + 1}/${pad(now.getDate())} 周${"日一二三四五六"[now.getDay()]}`;

  return (
    <div
      ref={rootRef}
      onPointerDown={handleTap}
      className="tap-surface relative z-10 flex h-full flex-col overflow-hidden"
    >
      {/* 涟漪层 */}
      {ripples.map((r) => (
        <div key={r.id} className="pointer-events-none absolute z-20" style={{ left: r.x, top: r.y }}>
          <div
            className={`h-28 w-28 rounded-full border-2 ${r.hue}`}
            style={{ animation: "ripple-ring 0.7s ease-out forwards", transform: "translate(-50%,-50%)" }}
            onAnimationEnd={() => removeRipple(r.id)}
          />
          <span
            className="absolute font-mono text-sm font-bold text-amber"
            style={{
              animation: "burst-glyph 0.85s cubic-bezier(0.16,1,0.3,1) forwards",
              ["--dx" as string]: `${r.dx}px`,
              ["--dy" as string]: `${r.dy}px`,
              ["--rot" as string]: `${r.rot}deg`,
            }}
          >
            {r.glyph}
          </span>
        </div>
      ))}

      {/* 顶部 HUD */}
      <header className="anim-rise flex items-center justify-between px-5 pt-4 sm:px-8 sm:pt-6">
        <div className="flex items-center gap-3">
          <span className="anim-pulse-dot h-2.5 w-2.5 rounded-full bg-coral" />
          <span className="font-mono text-[11px] font-semibold tracking-[0.3em] text-paper uppercase">
            Live · 实时预览
          </span>
          <span className="hidden border border-line px-2 py-0.5 font-mono text-[10px] tracking-widest text-mist sm:inline">
            H5 / 001
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="hidden font-mono text-[11px] tracking-widest text-mist sm:inline">{dateStr}</span>
          <span className="font-mono text-sm font-bold tracking-widest text-amber tabular-nums">{timeStr}</span>
        </div>
      </header>

      {/* 两侧竖排轨道（桌面） */}
      <p className="anim-rise absolute top-1/2 left-4 hidden -translate-y-1/2 font-mono text-[10px] tracking-[0.5em] text-mist/60 uppercase [writing-mode:vertical-rl] rotate-180 lg:block" style={{ animationDelay: "0.5s" }}>
        Hello World — First Transmission 001
      </p>
      <p className="anim-rise absolute top-1/2 right-4 hidden -translate-y-1/2 font-mono text-[10px] tracking-[0.5em] text-mist/60 uppercase [writing-mode:vertical-rl] lg:block" style={{ animationDelay: "0.6s" }}>
        Tap anywhere · 字符会回应你
      </p>

      {/* 主舞台 */}
      <main className="flex flex-1 flex-col items-center justify-center gap-7 px-4">
        <div className="anim-rise flex items-center gap-3 font-mono text-[11px] tracking-[0.35em] text-mist uppercase" style={{ animationDelay: "0.15s" }}>
          <span className="text-aqua">[</span>
          SIGNAL {pad(idx + 1)} / {GREETINGS.length} — {greeting.region}
          <span className="text-aqua">]</span>
        </div>

        <h1
          dir="auto"
          className="anim-rise max-w-5xl text-center font-display font-black tracking-tight text-paper break-words"
          style={{
            animationDelay: "0.25s",
            fontSize: `clamp(30px, ${vw}vw, 116px)`,
            textShadow: "0 0 42px rgba(79,227,193,0.22), 0 4px 0 rgba(3,10,12,0.9)",
          }}
        >
          {display.split("").map((ch, i) =>
            ch === " " ? (
              <span key={i} className="inline-block w-[0.35em]" />
            ) : (
              <span key={i} className="letter" onPointerDown={popLetter}>
                {ch}
              </span>
            )
          )}
        </h1>

        <div className="anim-rise font-mono text-xs tracking-widest text-mist" style={{ animationDelay: "0.35s" }}>
          语言 <b className="text-aqua">{greeting.lang}</b> · 点击屏幕任意位置试试
        </div>

        {/* 控制台 */}
        <div className="anim-rise flex items-center gap-3" style={{ animationDelay: "0.45s" }} onPointerDown={(e) => e.stopPropagation()}>
          <button
            onClick={next}
            className="btn-chunk flex items-center gap-2 bg-amber px-6 py-3 font-mono text-sm font-bold text-ink shadow-[0_10px_30px_-8px_rgba(255,180,84,0.55)] hover:bg-[#ffc677]"
            style={{ clipPath: "polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            换一句
          </button>
          <button
            onClick={onReplay}
            className="btn-chunk flex items-center gap-2 border border-line bg-panel/70 px-6 py-3 font-mono text-sm font-bold text-paper hover:border-aqua hover:text-aqua"
            style={{ clipPath: "polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 4.5v15l13-7.5-13-7.5z" />
            </svg>
            重播启动
          </button>
        </div>

        {/* 连接状态芯片 */}
        <div className="anim-rise flex items-center gap-2 border border-line bg-abyss/80 px-3.5 py-1.5 font-mono text-[10px] tracking-wider text-mist" style={{ animationDelay: "0.55s" }}>
          <span className="anim-pulse-dot h-1.5 w-1.5 rounded-full bg-aqua" />
          npm run dev ▸ ws://localhost:5173 · streaming
        </div>
      </main>

      {/* 实时号码观察台 */}
      <Telemetry sent={sent} taps={taps} />

      {/* 底部问候跑马灯 */}
      <footer className="anim-rise relative z-10 border-t border-line/70 bg-ink/70 py-2.5 backdrop-blur-sm" style={{ animationDelay: "0.65s" }}>
        <div className="overflow-hidden">
          <div className="marquee-track" style={{ ["--speed" as string]: "38s" }}>
            {[0, 1].map((k) => (
              <span key={k} className="pr-10 font-mono text-xs tracking-[0.2em] whitespace-nowrap text-mist uppercase">
                {TICKER_TEXT}
                <span className="text-amber"> ✳ </span>
              </span>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
