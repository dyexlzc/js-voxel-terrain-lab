import { useEffect, useRef, useState } from "react";

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

interface Props {
  sent: number;
  taps: number;
}

/** 实时号码观察台：时钟(0.1s)、帧率、运行时长、问候/触碰计数、滚动幸运号码 */
export default function Telemetry({ sent, taps }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [fps, setFps] = useState(60);
  const [boot] = useState(() => Date.now());
  const [luck, setLuck] = useState([4, 2, 0, 1]);
  const [locked, setLocked] = useState(false);
  const lockUntil = useRef(0);

  /* 10Hz 时钟 */
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 100);
    return () => clearInterval(t);
  }, []);

  /* 帧率采样 */
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      frames += 1;
      if (t - last >= 500) {
        setFps(Math.min(240, Math.round((frames * 1000) / (t - last))));
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* 幸运号码滚动 */
  useEffect(() => {
    const t = setInterval(() => {
      if (performance.now() > lockUntil.current) {
        setLocked(false);
        setLuck(Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)));
      }
    }, 110);
    return () => clearInterval(t);
  }, []);

  const lockLuck = () => {
    lockUntil.current = performance.now() + 2600;
    setLocked(true);
  };

  const up = Math.max(0, Math.floor((now.getTime() - boot) / 1000));
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${Math.floor(now.getMilliseconds() / 100)}`;
  const fpsTone = fps >= 50 ? "text-aqua" : fps >= 30 ? "text-amber" : "text-coral";

  const cells: { label: string; value: string; tone?: string }[] = [
    { label: "CLOCK 时钟", value: clock, tone: "text-paper" },
    { label: "FPS 帧率", value: pad(fps, 2), tone: fpsTone },
    { label: "UPTIME 运行", value: `${pad(Math.floor(up / 60))}:${pad(up % 60)}`, tone: "text-mist" },
    { label: "SENT 问候", value: pad(sent, 2), tone: "text-amber" },
    { label: "TAPS 触碰", value: pad(taps, 2), tone: "text-coral" },
  ];

  return (
    <div className="anim-rise relative z-10 px-4 pb-3 sm:px-8" style={{ animationDelay: "0.75s" }}>
      <div className="border border-line bg-abyss/80 backdrop-blur-sm">
        {/* 面板标题 */}
        <div className="flex items-center justify-between border-b border-line/70 px-3 py-1.5">
          <span className="flex items-center gap-2 font-mono text-[10px] font-semibold tracking-[0.3em] text-mist uppercase">
            <span className="anim-pulse-dot h-1.5 w-1.5 rounded-full bg-aqua" />
            Telemetry · 实时号码台
          </span>
          <span className="hidden font-mono text-[10px] tracking-widest text-mist/70 sm:inline">refresh 10Hz</span>
        </div>

        {/* 读数网格 */}
        <div className="grid grid-cols-3 gap-px bg-line/40 sm:grid-cols-6">
          {cells.map((c) => (
            <div key={c.label} className="bg-panel/70 px-3 py-2.5 transition-colors hover:bg-panel">
              <div className="font-mono text-[9px] tracking-[0.22em] text-mist uppercase">{c.label}</div>
              <div className={`mt-1 font-mono text-xl font-bold tracking-tight tabular-nums sm:text-2xl ${c.tone ?? "text-paper"}`}>
                {c.value}
              </div>
            </div>
          ))}

          {/* 幸运号码：点击锁定 */}
          <button
            onClick={lockLuck}
            onPointerDown={(e) => e.stopPropagation()}
            title="点击锁定号码 2.6 秒"
            className={`btn-chunk bg-panel/70 px-3 py-2.5 text-left ${locked ? "outline-1 outline-amber" : ""}`}
          >
            <div className="font-mono text-[9px] tracking-[0.22em] text-mist uppercase">
              LUCK 幸运号 {locked ? "· 已锁定" : "· 点按锁定"}
            </div>
            <div className={`mt-1 flex gap-1 font-display text-xl font-bold sm:text-2xl ${locked ? "text-amber" : "text-paper/85"}`}>
              {luck.map((d, i) => (
                <span key={i} className={i === 3 ? (locked ? "text-coral" : "text-aqua") : ""}>
                  {d}
                </span>
              ))}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
