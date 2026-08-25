import { useMemo } from "react";
import { FIELD_GLYPHS } from "../data/greetings";

interface FieldGlyph {
  id: number;
  char: string;
  left: number;
  size: number;
  duration: number;
  delay: number;
  opacity: number;
  rot: number;
  color: string;
}

const COLORS = ["rgba(79,227,193,0.5)", "rgba(255,180,84,0.45)", "rgba(127,166,173,0.4)", "rgba(255,107,94,0.4)"];

export default function Background() {
  const glyphs = useMemo<FieldGlyph[]>(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        id: i,
        char: FIELD_GLYPHS[i % FIELD_GLYPHS.length],
        left: Math.random() * 100,
        size: 11 + Math.random() * 22,
        duration: 14 + Math.random() * 22,
        delay: -Math.random() * 30,
        opacity: 0.12 + Math.random() * 0.3,
        rot: -40 + Math.random() * 80,
        color: COLORS[i % COLORS.length],
      })),
    []
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {/* 分层底色 */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,#0d2b33_0%,#06141a_58%,#04100f_100%)]" />

      {/* 呼吸光晕：左上青、右下琥珀 */}
      <div className="anim-glow absolute -top-32 -left-32 h-[52vmax] w-[52vmax] rounded-full bg-[radial-gradient(circle,rgba(79,227,193,0.14)_0%,transparent_62%)]" />
      <div
        className="anim-glow absolute -right-40 -bottom-44 h-[58vmax] w-[58vmax] rounded-full bg-[radial-gradient(circle,rgba(255,180,84,0.13)_0%,transparent_60%)]"
        style={{ animationDelay: "-3.5s" }}
      />
      <div className="absolute top-1/3 left-1/2 h-[36vmax] w-[36vmax] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,107,94,0.06)_0%,transparent_65%)]" />

      {/* 上升的代码符号 */}
      {glyphs.map((g) => (
        <span
          key={g.id}
          className="absolute font-mono"
          style={{
            left: `${g.left}%`,
            top: "100%",
            fontSize: g.size,
            color: g.color,
            animation: `glyph-drift ${g.duration}s linear ${g.delay}s infinite`,
            ["--o" as string]: g.opacity,
            ["--rot" as string]: `${g.rot}deg`,
          }}
        >
          {g.char}
        </span>
      ))}

      {/* 底部透视网格 */}
      <div className="bg-grid absolute inset-x-0 bottom-0 h-[38vh] [transform:perspective(420px)_rotateX(48deg)] [transform-origin:bottom]" />

      {/* 噪点 + 暗角 */}
      <div className="noise-overlay absolute inset-0" />
      <div className="absolute inset-0 bg-[radial-gradient(90%_90%_at_50%_45%,transparent_55%,rgba(3,10,12,0.75)_100%)]" />
    </div>
  );
}
