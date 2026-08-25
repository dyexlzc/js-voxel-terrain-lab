import { useEffect, useRef, useState } from "react";

interface BootLine {
  text: string;
  speed: number;
}

const LINES: BootLine[] = [
  { text: "$ h5 new hello-world --live", speed: 38 },
  { text: "✔ scaffold · 模板解析完成", speed: 14 },
  { text: "✔ install · 42 packages in 1.2s", speed: 14 },
  { text: "✔ compile · [████████████] 100%", speed: 18 },
  { text: "➜ local   http://localhost:5173/h5", speed: 12 },
  { text: "● READY · 正在把 Hello World 推送到你的屏幕…", speed: 16 },
];

function lineColor(line: string): string {
  if (line.startsWith("$")) return "text-amber";
  if (line.startsWith("✔")) return "text-aqua";
  if (line.startsWith("➜")) return "text-aqua";
  if (line.startsWith("●")) return "text-coral";
  return "text-paper";
}

export default function BootScreen({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState<string[]>([]);
  const [typing, setTyping] = useState("");
  const skipRef = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    (async () => {
      for (const line of LINES) {
        if (skipRef.current || cancelled) return;
        for (let i = 1; i <= line.text.length; i++) {
          if (skipRef.current || cancelled) return;
          setTyping(line.text.slice(0, i));
          await sleep(line.speed);
        }
        if (cancelled) return;
        setShown((s) => [...s, line.text]);
        setTyping("");
        await sleep(240);
      }
      if (!cancelled) {
        await sleep(650);
        if (!cancelled && !doneRef.current) {
          doneRef.current = true;
          onDone();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onDone]);

  const skip = () => {
    if (doneRef.current) return;
    skipRef.current = true;
    doneRef.current = true;
    setShown(LINES.map((l) => l.text));
    setTyping("");
    setTimeout(onDone, 220);
  };

  const activeLine = LINES[shown.length];
  const progress =
    ((shown.length + (activeLine ? typing.length / activeLine.text.length : 0)) / LINES.length) * 100;

  return (
    <div
      className="tap-surface relative z-10 flex h-full cursor-pointer flex-col items-center justify-center px-5"
      onClick={skip}
    >
      <p className="anim-rise mb-4 font-mono text-[11px] tracking-[0.35em] text-mist uppercase">
        Transmission 001 · 正在建立实时连接
      </p>

      {/* 终端窗口 */}
      <div
        className="anim-rise w-full max-w-xl overflow-hidden border border-line bg-abyss/90 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-coral" />
          <span className="h-3 w-3 rounded-full bg-amber" />
          <span className="h-3 w-3 rounded-full bg-aqua" />
          <span className="ml-3 font-mono text-xs text-mist">hello-world — h5 preview</span>
          <span className="ml-auto font-mono text-[10px] text-aqua">bash</span>
        </div>

        <div className="min-h-[248px] px-5 py-4 font-mono text-[13px] leading-7 sm:text-sm">
          {shown.map((l, i) => (
            <p key={i} className={lineColor(l)}>
              {l}
            </p>
          ))}
          {typing && (
            <p className={lineColor(activeLine?.text ?? "")}>
              {typing}
              <span className="anim-caret ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-aqua" />
            </p>
          )}
          {!typing && shown.length < LINES.length && (
            <p>
              <span className="anim-caret inline-block h-4 w-2 translate-y-0.5 bg-aqua" />
            </p>
          )}
        </div>

        {/* 编译进度条 */}
        <div className="h-1 w-full bg-panel">
          <div
            className="h-full bg-gradient-to-r from-aqua via-amber to-coral transition-[width] duration-200 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <button
        className="btn-chunk mt-8 border border-line bg-panel/60 px-5 py-2 font-mono text-xs tracking-[0.25em] text-mist hover:border-amber hover:text-amber"
        onClick={(e) => {
          e.stopPropagation();
          skip();
        }}
      >
        点击跳过 ▸▸
      </button>
    </div>
  );
}
