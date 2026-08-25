import { useEffect, useState } from "react";

const CHARSET = "!<>-_\\/[]{}=+*^?#$%&01你好世界";
const SKIP = new Set([" ", "，", "、", ",", ".", " "]);

/** 解码式文字：目标文本从左到右逐位从乱码"解码"出来 */
export function useScramble(target: string, duration = 720): string {
  const [display, setDisplay] = useState(target);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const reveal = Math.floor(p * target.length);
      let out = "";
      for (let i = 0; i < target.length; i++) {
        const c = target[i];
        if (SKIP.has(c)) {
          out += c;
        } else if (i < reveal) {
          out += c;
        } else {
          out += CHARSET[Math.floor(Math.random() * CHARSET.length)];
        }
      }
      setDisplay(p < 1 ? out : target);
      if (p < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return display;
}
