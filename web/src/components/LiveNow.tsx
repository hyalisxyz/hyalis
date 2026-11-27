import { useEffect, useState } from "react";
import type { AgentNow } from "../lib/api";
import { money, short } from "../lib/format";
import { txUrlOn } from "../lib/chain";

/**
 * What the agent is doing right now, refreshed every half minute: its live return, the four
 * steps every decision goes through (with the current one lit), and for each market it trades
 * the latest price and each rule measured against its threshold, or the open position and its
 * profit or loss.
 */
export function LiveNow({ now, real, onStop, stopping, chainId }: { now: AgentNow; real: boolean; onStop?: () => void; stopping?: boolean; chainId?: number }) {
  const clock = useClock();
  const nextAt = now.lastTickAt ? now.lastTickAt + now.tickSec : null;
  const inSec = nextAt ? Math.max(0, nextAt - clock) : null;
  const holding = now.symbols.some((s) => s.position);
  const signal = now.symbols.some((s) => s.state === "signal");
  const ordering = now.orders.length > 0;
  const stage = ordering ? 2 : holding ? 3 : signal ? 1 : 0;
  const steps = ["Watch prices", "Rules met", real ? "Swap on Uniswap" : "Fill on paper", "Sealed on chain"];
  const active = now.status === "active";
  const ended = now.endedAt !== null;
  // The clock starts once the deposit is in (startEquity > 0).
  const left = now.endAt !== null && !ended && now.startEquity > 0 ? Math.max(0, now.endAt - clock) : null;
  const hasEnds = Boolean(now.ends.afterMinutes || now.ends.profitPct || now.ends.lossPct);

  return (
    <div className="panel live-now">
      <div className="panel-h">
        <div>
          <h2>
            <span className={`ln-dot${active ? " on" : ""}`} aria-hidden="true" /> {active ? "Live now" : ended ? "Run ended" : "Stopped"}
          </h2>
          <p>
            {now.lastTickAt ? `Checked ${ago2(clock - now.lastTickAt)} ago` : "Waiting for the first check"}
            {active && inSec !== null ? ` · next check ${inSec > 0 ? `in ${mmss(inSec)}` : "any moment"}` : ""}
            {` · ${real ? "real money from its own wallet" : "paper money at real prices"}`}
          </p>
        </div>
        <div className="ln-pnl">
          <b className={`num ${now.returnPct > 0 ? "gain" : now.returnPct < 0 ? "loss" : ""}`}>{now.returnPct > 0 ? "+" : ""}{now.returnPct.toFixed(2)}%</b>
          <span className="num">{money(now.equity, 2)} from {money(now.startEquity, now.startEquity < 1000 ? 2 : 0)}</span>
        </div>
      </div>

      {real && now.startEquity === 0 && !ended ? (
        <div className="ln-run"><span><b>Starting.</b> Your deposit is being moved in and turned into trading cash; the run starts within a minute, and its clock starts then.</span></div>
      ) : null}
      {hasEnds || ended || onStop ? (
        <div className={`ln-run${ended ? " ended" : ""}`}>
          {ended ? (
            <span>
              <b>Run ended</b>: {now.endedReason}. Final result <b className={now.returnPct > 0 ? "gain" : now.returnPct < 0 ? "loss" : ""}>{now.returnPct > 0 ? "+" : ""}{now.returnPct.toFixed(2)}%</b> ({money(now.equity, 2)} from {money(now.startEquity, 2)}).{" "}
              {now.stopState === "closing" ? "Selling the position…" : now.stopState === "returning" ? "Sending the money back to your wallet…" : now.stopState === "returned" ? "The money is back in the owner's wallet." : ""}
            </span>
          ) : (
            <span>
              {left !== null ? <>Ends in <b className="num ln-count">{hms(left)}</b></> : now.ends.afterMinutes ? null : <>Runs until stopped</>}
              {now.ends.profitPct ? <> · stops at <b className="gain">+{now.ends.profitPct}%</b></> : null}
              {now.ends.lossPct ? <> · stops at <b className="loss">−{now.ends.lossPct}%</b></> : null}
            </span>
          )}
          {onStop && !ended ? (
            <button className="btn btn-sm ln-stop" onClick={onStop} disabled={stopping}>
              {stopping ? "Stopping…" : real ? "Stop and send the money back" : "Stop"}
            </button>
          ) : null}
        </div>
      ) : null}
      {now.positions === 0 && !ended ? (
        <p className="ln-cash">
          <b>All in cash ({real ? "USDG" : "paper dollars"})</b>, so the return holds still until it buys.
          {now.symbols.filter((x) => x.sinceStartPct !== null).length ? (
            <>
              {" "}Since it started:{" "}
              {now.symbols
                .filter((x) => x.sinceStartPct !== null)
                .map((x, i) => (
                  <span key={x.symbol}>
                    {i ? ", " : ""}
                    {x.symbol} <b className={`num ${x.sinceStartPct! > 0 ? "gain" : x.sinceStartPct! < 0 ? "loss" : ""}`}>{x.sinceStartPct! > 0 ? "+" : ""}{x.sinceStartPct!.toFixed(2)}%</b>
                  </span>
                ))}
              .
            </>
          ) : null}
        </p>
      ) : null}
      <ol className="ln-flow" aria-label="How a decision happens">
        {steps.map((s, i) => (
          <li key={s} className={i === stage && active ? "on" : i < stage ? "done" : ""}>
            <span className="n">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {now.orders.map((o) => (
        <div key={o.id} className="notice" style={{ margin: "0 18px 12px" }}>
          <b>{o.action === "open" ? "Buying" : "Selling"} {o.symbol}</b> on Uniswap now{o.tx ? <> · <a href={txUrlOn(chainId, o.tx)} target="_blank" rel="noreferrer">tx {short(o.tx, 6, 4)}</a></> : " · sending"}
        </div>
      ))}

      <div className="ln-rows">
        {now.symbols.map((s) => (
          <div key={s.symbol} className={`ln-row ${s.state}`}>
            <div className="ln-sym">
              <b>{s.symbol}</b>
              <span className="num">{s.price !== null ? money(s.price, s.price < 10 ? 4 : 2) : "–"}</span>
              <span className={`ln-state ${ended ? "ended" : s.state}`}>{ended ? "Ended" : (STATE[s.state as keyof typeof STATE] ?? s.state)}</span>
            </div>
            {s.position ? (
              <div className="ln-pos">
                <span>
                  Holding {trimQty(s.position.qty)} {s.symbol} bought at {money(s.position.entryPrice, 2)}
                </span>
                <b className={`num ${(s.position.pnlPct ?? 0) > 0 ? "gain" : (s.position.pnlPct ?? 0) < 0 ? "loss" : ""}`}>
                  {(s.position.pnlPct ?? 0) > 0 ? "+" : ""}{(s.position.pnlPct ?? 0).toFixed(2)}% ({money(s.position.pnl ?? 0, 2)})
                </b>
                <span className="faint">
                  Stop at {money(s.position.stopAt, 2)}
                  {s.position.takeProfitAt ? ` · take profit at ${money(s.position.takeProfitAt, 2)}` : ""}
                  {s.position.closesBy ? ` · sells by ${new Date(s.position.closesBy * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC` : ""}
                </span>
              </div>
            ) : null}
            {s.checks.length ? (
              <ul className="ln-checks">
                <li className="faint">{s.rules === "exit" ? "Sells when any of these holds" : `Buys when all of these hold · ${s.met} of ${s.of} now`}</li>
                {s.checks.map((c, i) => (
                  <li key={i} className={c.pass ? "pass" : ""}>
                    <span className="ic" aria-label={c.pass ? "met" : "not met"}>{c.pass ? "✓" : "·"}</span>
                    <span>
                      {c.description}
                      <span className="faint"> · {c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const STATE = {
  waiting: "Watching",
  signal: "Rules met",
  holding: "Holding",
  "market-closed": "Market closed",
} as const;

function useClock() {
  const [t, setT] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const i = setInterval(() => setT(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(i);
  }, []);
  return t;
}
const hms = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const ago2 = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);
const trimQty = (q: number) => (q >= 1 ? q.toLocaleString("en-US", { maximumFractionDigits: 4 }) : q.toPrecision(4));
