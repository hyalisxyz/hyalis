import { useEffect, useRef, useState } from "react";

export const prefersReduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** True once the element has scrolled into view. */
export function useInView<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReduced()) return setSeen(true);
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && (setSeen(true), io.disconnect()), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, seen] as const;
}

/** A number that rolls up to its value the first time it is seen, and eases to new values after. */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString("en-US"), duration = 1.4 }: { value: number | null | undefined; format?: (n: number) => string; duration?: number }) {
  const [ref, seen] = useInView<HTMLSpanElement>(0.4);
  const shown = useRef(0);
  const [text, setText] = useState(format(0));
  useEffect(() => {
    if (!seen || value === null || value === undefined) return;
    if (prefersReduced()) {
      shown.current = value;
      setText(format(value));
      return;
    }
    const from = shown.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / (duration * 1000));
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t); // expo out
      const v = from + (value - from) * eased;
      setText(format(v));
      if (t < 1) raf = requestAnimationFrame(step);
      else shown.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, value]);
  return <span ref={ref} className="num">{value === null || value === undefined ? "–" : text}</span>;
}
