
/** Equity curve as a filled line. Points are [unixSec, value]. */
export function Spark({ points, height = 160 }: { points: Array<[number, number]>; height?: number }) {
  if (points.length < 2) return <div className="empty">Not enough history yet to draw a curve.</div>;
  const w = 800;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.12 || 1;
  const X = (x: number) => ((x - x0) / (x1 - x0 || 1)) * w;
  const Y = (y: number) => height - ((y - (y0 - pad)) / (y1 + pad - (y0 - pad))) * height;
  const d = points.map((p, k) => `${k ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
  const up = ys.at(-1)! >= ys[0]!;
  const color = up ? "var(--gain)" : "var(--loss)";
  const start = Y(ys[0]!);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <defs>
        <linearGradient id="sg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style={{ stopColor: up ? "var(--gain)" : "var(--loss)", stopOpacity: 0.18 }} />
          <stop offset="1" style={{ stopColor: up ? "var(--gain)" : "var(--loss)", stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <line x1="0" x2={w} y1={start} y2={start} style={{ stroke: "var(--line)" }} strokeDasharray="4 6" />
      <path d={`${d} L${w},${height} L0,${height} Z`} fill="url(#sg)" />
      <path className="spark-line" d={d} pathLength={1} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function TierBadge({ tier }: { tier: "verified" | "data-feed" | "includes-data-feed" }) {
  return tier === "verified" ? <span className="badge badge-verified">✓ Verified</span> : <span className="badge badge-feed">Data feed</span>;
}

export function StatusBadge({ status, reason, money, starting }: { status: "active" | "paused"; reason?: string | null; money?: "paper" | "real"; starting?: boolean }) {
  if (reason === "ended") return <span className="badge badge-stopped" title="Its run ended">Ended</span>;
  if (starting) return <span className="badge badge-active" title="Moving the deposit in; it starts within a minute">Starting</span>;
  if (money === "real") {
    return status === "active" ? (
      <span className="badge badge-live" title="Trading real money from its own wallet"><i aria-hidden="true" />Live</span>
    ) : (
      <span className="badge badge-stopped" title="Real-money agent, not trading now">Stopped</span>
    );
  }
  if (status === "active") return <span className="badge badge-active">Running</span>;
  return <span className="badge badge-paused">{reason === "over_quota" ? "Paused: no slot" : "Paused"}</span>;
}

/** Plain-language list of an agent's rules. */
export function RulesList({ s }: { s: { entry: Array<{ description: string }>; exitConditions: Array<{ description: string }>; stopLossPct: number; takeProfitPct: number; maxHoldHours: number; positionPct: number; maxOpenPositions: number; leverage: number; side: string; symbols: string[]; riskLevel?: string; trailingStopPct?: number; atrStopMultiple?: number; maxDrawdownPct?: number } }) {
  return (
    <div className="rules">
      <div className="rule"><span className="w">Trades</span><span>{s.symbols.join(", ")} · {s.side === "short" ? "short" : "long"}{s.leverage > 1 ? `, ${s.leverage}x` : ""}</span></div>
      {s.entry.map((c, k) => (
        <div className="rule" key={`e${k}`}><span className="w">{k === 0 ? "Enter" : "and"}</span><span>{c.description}</span></div>
      ))}
      {s.exitConditions.map((c, k) => (
        <div className="rule" key={`x${k}`}><span className="w">{k === 0 ? "Exit" : "or"}</span><span>{c.description}</span></div>
      ))}
      <div className="rule"><span className="w">Risk</span><span>Stop loss {s.stopLossPct}%{s.trailingStopPct ? `, trailing stop ${s.trailingStopPct}%` : ""}{s.atrStopMultiple ? `, volatility stop ${s.atrStopMultiple}x the average move` : ""}{s.takeProfitPct ? `, take profit ${s.takeProfitPct}%` : ""}{s.maxHoldHours ? `, hold at most ${s.maxHoldHours}h` : ""}{s.maxDrawdownPct ? `; no new positions after a ${s.maxDrawdownPct}% drawdown` : ""}</span></div>
      <div className="rule"><span className="w">Size</span><span>{s.riskLevel ? `${s.riskLevel[0]!.toUpperCase()}${s.riskLevel.slice(1)} risk: sized by volatility, at most ${s.positionPct}% of equity per position` : `${s.positionPct}% of equity per position`}
        {s.symbols.length === 1 || s.maxOpenPositions === 1 ? ", one position at a time" : `, up to ${Math.min(s.maxOpenPositions, s.symbols.length)} at once (never two in the same symbol)`}</span></div>
    </div>
  );
}
