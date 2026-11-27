import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, type Activity, type Backtest, type LeaderRow, type Market } from "../lib/api";
import { CountUp, prefersReduced } from "../lib/motion";
import { useData } from "../lib/useData";
import { decisionLine, money, sealedHour, short, sourceName, tokens } from "../lib/format";
import type { Check } from "../lib/verify";
import { Printer, utcStamp } from "../components/Printer";
import { SiteFooter, SiteHeader } from "../components/Site";
import "./landing.css";

/* ------------------------------------------------------------------ hero */

/** A strip of live prices running under the hero, like ticker tape. */
function Ticker({ markets }: { markets: Market[] }) {
  const items = markets.filter((m) => m.price !== null).slice(0, 24);
  if (!items.length) return null;
  const row = (copy: boolean) =>
    items.map((m) => (
      <span key={`${m.symbol}${copy ? "-2" : ""}`} className="tk" aria-hidden={copy || undefined}>
        <img src={`/logos/${m.symbol}.webp`} alt={copy ? "" : `${m.symbol} logo`} width={32} height={32} decoding="async" />
        <span className="tk-t"><b>{m.symbol}</b><em>{money(m.price)}</em></span>
      </span>
    ));
  // The second copy only closes the loop of the scrolling strip; screen readers read the list once.
  return (
    <div className="tp-ticker" role="region" aria-label="Latest prices">
      <div className="tp-ticker-track">{row(false)}{row(true)}</div>
    </div>
  );
}

function Hero({ activity, stats, markets }: { activity: Activity[]; stats: any; markets: Market[] }) {
  return (
    <section className="tp-hero">
      <div className="tp-hero-in">
        <div className="tp-hero-copy">
          <h1 className="tp-h1">AI agents that show their receipts.</h1>
          <p className="tp-lede">
            Tell an AI agent your strategy in one sentence. It trades 35 tokenized stocks and 32 cryptocurrencies, and prints a receipt for every move, sealed on Robinhood Chain so nobody can fake the record. Not even us.
          </p>
          <div className="tp-cta">
            <Link className="tp-btn paper" to="/app/new">Build your agent free</Link>
            <a className="tp-btn line" href="#agents">Watch live agents</a>
          </div>
          <p className="tp-tally">
            {stats ? <><CountUp value={stats.receipts.total} /> receipts printed so far, every one of them checkable. <CountUp value={stats.epochs.anchored} /> hourly roots sealed on chain.</> : " "}
          </p>
        </div>
        <Printer activity={activity} />
      </div>
      <Ticker markets={markets} />
    </section>
  );
}

/* ------------------------------------------------------------------ how it works */

const STEPS = [
  { t: "Write it", d: "Type it the way you would text a friend. The AI turns it into exact rules and shows you anything it had to change. No code, no charts to wire up." },
  { t: "Test it", d: "See how your rules did on recent real prices, side by side with just holding, before a single trade runs." },
  { t: "Run it", d: "Stocks trade in every session, from pre-market to overnight; crypto never stops. If two price sources disagree by more than 1.5%, your agent sits the trade out." },
  { t: "Prove it", d: "Every decision becomes a receipt, and each hour the receipts are sealed on Robinhood Chain. Nobody can edit the record afterwards." },
];

/** The backtest panel: a real replay of a house agent's rules, with its dates. */
function Replay({ bt, name }: { bt: Backtest | null; name: string }) {
  if (!bt) return <div className="tp-art-row"><span>Replaying the last 30 days…</span></div>;
  const pts = bt.equityCurve;
  const lo = Math.min(...pts.map((p) => p[1]));
  const hi = Math.max(...pts.map((p) => p[1]));
  const x = (i: number) => (i / Math.max(1, pts.length - 1)) * 240;
  const y = (v: number) => 100 - ((v - lo) / Math.max(1e-9, hi - lo)) * 90;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const sign = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
  return (
    <>
      <svg viewBox="0 0 240 110" className="tp-spark" role="img" aria-label={`${name}: ${sign(bt.returnPct)} from ${day(bt.from)} to ${day(bt.to)}`}>
        <line className="hold" x1="0" x2="240" y1={y(bt.startEquity)} y2={y(bt.startEquity)} />
        <path className="strat" d={d} />
      </svg>
      <div className="tp-art-row"><span>The rules</span><b>{sign(bt.returnPct)}</b></div>
      {bt.benchmarkReturnPct !== null ? <div className={`tp-art-row${bt.benchmarkReturnPct < 0 ? " red" : ""}`}><span>Just holding</span><b>{sign(bt.benchmarkReturnPct)}</b></div> : null}
      <div className="tp-art-note">{name}, {day(bt.from)} to {day(bt.to)} UTC, {bt.trades.length} trades. Past results do not promise future ones.</div>
    </>
  );
}

function How({ sample, bt, btName }: { sample: Activity | null; bt: Backtest | null; btName: string }) {
  const d = sample ? decisionLine(sample.record) : null;
  const gap: number = sample?.record?.gate?.gapBps ?? 27;
  const price: number = sample?.record?.gate?.price ?? d?.price ?? 149.26;
  const second = String(sample?.record?.gate?.secondSource ?? "Pyth");
  return (
    <section className="tp-paper tp-how" id="how">
      <div className="tp-wrap">
        <h2 className="tp-h2" data-reveal>One sentence in. A sealed trade out.</h2>
        <ol className="tp-steps">
          {STEPS.map((s, i) => (
            <li key={s.t} data-reveal style={{ ["--d" as any]: i }}>
              <span className="tp-n" aria-hidden>{i + 1}</span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
              <div className="tp-art" data-reveal="print" style={{ ["--d" as any]: i + 2 }}>
                {i === 0 ? (
                  <>
                    <q>Short BTC and ETH while they trend below the 3-day average, stop at 4%</q>
                    <ul>
                      <li>BTC, ETH, short</li>
                      <li>Enter 1.5% under the 72h average, falling</li>
                      <li>Exit back above the average</li>
                      <li>Stop loss 4%</li>
                    </ul>
                  </>
                ) : i === 1 ? (
                  <>
                    <Replay bt={bt} name={btName} />
                  </>
                ) : i === 2 ? (
                  <>
                    <div className="tp-art-row"><span>Chainlink</span><b>{money(price)}</b></div>
                    <div className="tp-art-row"><span>{sourceName(second)}</span><b>{money(price * (1 - gap / 10000))}</b></div>
                    <div className="tp-art-note">{(gap / 100).toFixed(2)}% apart, inside the 1.5% limit, so it trades. Further apart, it would wait.</div>
                  </>
                ) : (
                  <div className="tp-mini-stamp" role="img" aria-label="Sealed on Robinhood Chain" data-reveal="stamp">
                    <b>Sealed</b>
                    <span>{sample ? sealedHour(sample.epoch).replace(/–\d\d:\d\d/, "") : "every hour"}</span>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ features */

const FEATURES = [
  { t: "Plain-language builder", d: "Write a strategy in a sentence. Get exact rules you can read." },
  { t: "Backtest before launch", d: "Recent real prices, next to just holding." },
  { t: "67 markets", d: "35 tokenized stocks, 24 hours on weekdays. 32 cryptocurrencies, 24/7." },
  { t: "Price safety check", d: "No trade on a stale, halted or disputed price. Chainlink plus a second source on verified markets." },
  { t: "Risk limits on every agent", d: "Stop loss, position size, daily loss cap and leverage limits." },
  { t: "Receipts sealed hourly", d: "Every decision Merkle-sealed on Robinhood Chain. History cannot be rewritten." },
  { t: "One-click verification", d: "Check any receipt against the chain, right in your browser." },
  { t: "Agent Passport", d: "An ERC-8004 identity on chain that any app can look up, with a card to share." },
  { t: "Lessons journal", d: "Its own sealed trades turned into lessons, and a smarter version built from them." },
  { t: "Open record and API", d: "Every agent, trade and hourly bundle, free to read, export and build on." },
];

function Features() {
  return (
    <section className="tp-paper tp-features" id="features">
      <div className="tp-wrap tp-features-grid">
        <div className="tp-features-copy">
          <h2 className="tp-h2" data-reveal>Everything your agent comes with.</h2>
          <p className="tp-sub" data-reveal style={{ ["--d" as any]: 1 }}>
            Most trading bots show you a screenshot of their profits. Every agent here gets the tools to trade well and the paperwork to prove it.
          </p>
          <Link className="tp-btn field" to="/app/new" data-reveal style={{ ["--d" as any]: 2 }}>Build your agent free</Link>
        </div>
        <div className="tp-bill" role="table" aria-label="What every agent includes" data-reveal="print">
          <div className="tp-bill-head" role="row">
            <span role="columnheader">Item</span>
            <span role="columnheader">Price</span>
          </div>
          {FEATURES.map((f) => (
            <div className="tp-bill-item" role="row" key={f.t}>
              <div role="cell">
                <b>{f.t}</b>
                <span>{f.d}</span>
              </div>
              <span role="cell" className="tp-bill-price">Included</span>
            </div>
          ))}
          <div className="tp-bill-total" role="row">
            <span role="cell">Total while paper trading</span>
            <b role="cell">$0.00</b>
          </div>
          <p className="tp-bill-foot">Agents you build trade on paper at real prices. Not financial advice.</p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ agents */

function Stub({ a, i }: { a: LeaderRow; i: number }) {
  const pct = Number(a.returnPct.toFixed(2));
  const down = pct < 0;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  const since = new Date(a.since * 1000).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <Link className="tp-stub" to={`/app/agents/${a.id}`} data-reveal="drop" style={{ ["--d" as any]: i }}>
      <span className="st-top">{a.status === "active" ? "Running" : "Paused"} since {since}</span>
      {a.money === "real" ? <span className="st-real">Real money</span> : <span className="st-paper">Paper</span>}
      {a.money === "real" && a.fills === 0 ? <span className="st-wait">Just started · waiting for its first signal</span> : null}
      <h3>{a.name}</h3>
      <span className="st-sym">{a.strategy.symbols.join(", ")}</span>
      <b className={`st-ret${down ? " red" : ""}`}>{sign}{Math.abs(pct).toFixed(2)}%</b>
      <span className="st-foot"><span>{money(a.equity, 2)}</span><span>{a.fills} trades</span></span>
    </Link>
  );
}

/* ------------------------------------------------------------------ live proof */

function LiveProof({ receiptId }: { receiptId: number | null }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    if (!receiptId) return;
    setRunning(true);
    setChecks(null);
    try {
      // The verifier (and its chain client) loads only when someone checks a receipt.
      const [r, { verifyReceipt }] = await Promise.all([api.receipt(receiptId), import("../lib/verify")]);
      await verifyReceipt(r, (c) => setChecks(c));
    } finally {
      setRunning(false);
    }
  };
  const labels = ["The record matches its hash", "It is inside the hourly root", "Robinhood Chain confirms the root", "The price matches the Chainlink round"];
  const shown = checks ?? labels.map((label) => ({ label, state: "idle" as any, detail: "" }));
  const passed = checks?.every((c) => c.state === "ok");
  const mark = (s: string) => (s === "ok" ? "Match" : s === "fail" ? "Fail" : s === "skip" ? "Skipped" : "");
  return (
    <section className="tp-paper tp-proof" id="proof">
      <div className="tp-wrap tp-proof-grid">
        <div>
          <h2 className="tp-h2" data-reveal>Don't trust the leaderboard. Check it.</h2>
          <p className="tp-sub" data-reveal style={{ ["--d" as any]: 1 }}>
            Press the button. Your browser pulls a real receipt and checks it against Robinhood Chain itself, not against our server. Change one number after the fact and a check fails.
          </p>
          <button className="tp-btn field" onClick={run} disabled={running || !receiptId}>
            {running ? "Checking on chain" : receiptId ? `Check receipt ${receiptId}` : "Waiting for a receipt"}
          </button>
          <p className="tp-passed" role="status">{passed ? "All four checks passed, straight from the chain." : " "}</p>
        </div>
        <div className="tp-slip" data-reveal="print">
          <div className="rc-row dim"><span>Check of receipt {receiptId ?? "…"}</span><span>Robinhood Chain</span></div>
          <ol>
            {shown.map((c, i) => (
              <li key={c.label} className={c.state}>
                <span className="ck-n">{i + 1}</span>
                <div>
                  <b>{c.label}</b>
                  <small>{c.detail ? short(c.detail, 40, 10) : c.state === "wait" ? "checking" : " "}</small>
                </div>
                <span className="ck-stamp" aria-hidden={!mark(c.state)}>{mark(c.state)}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ tiers */

function Tiers({ token }: { token: any }) {
  const tiers: Array<{ name: string; minTokens: number; agents: number; compilesPerDay: number }> = token?.tiers ?? [];
  const max = Math.max(6_000_000, (tiers.at(-1)?.minTokens ?? 5_000_000) * 1.2);
  const [held, setHeld] = useState(1_200_000);
  const idx = tiers.reduce((acc, t, i) => (held >= t.minTokens ? i : acc), 0);
  const tier = tiers[idx];
  const slots = tiers.at(-1)?.agents ?? 10;
  return (
    <section className="tp-field tp-tiers" id="token">
      <div className="tp-wrap tp-tiers-grid">
        <div>
          <h2 className="tp-h2" data-reveal>Hold more, run more agents.</h2>
          <p className="tp-sub" data-reveal style={{ ["--d" as any]: 1 }}>
            {token?.launched
              ? "Start free with one agent. Holders run three at once, whales ten, with more AI builds a day. Your tier follows the tokens in your wallet, read the moment you connect."
              : "Start free with one agent. Holders run three at once, whales ten, with more AI builds a day. The token launches on a Pons bonding curve, and tiers switch on the moment it is live."}
          </p>
          {token ? <p className="tp-sub small">Or burn {tokens(token.burn.tokensPerSlot)} tokens for one more slot for {token.burn.slotDays} days. Selling tokens pauses extra agents; it never deletes them.</p> : null}
        </div>
        <div className="tp-till" data-reveal="print">
          <label className="tp-till-q" htmlFor="held">Tokens you hold</label>
          <output className="tp-till-n" htmlFor="held">{tokens(held)}</output>
          <input
            id="held"
            className="tp-range"
            type="range"
            min={0}
            max={max}
            step={50_000}
            value={held}
            onChange={(e) => setHeld(Number(e.target.value))}
            style={{ ["--v" as any]: `${(held / max) * 100}%` }}
          />
          <div className="tp-ticks" aria-hidden>
            {tiers.map((t) => <span key={t.name} style={{ left: `${(t.minTokens / max) * 100}%` }}>{t.name}</span>)}
          </div>
          <div className="tp-till-out">
            <div className="rc-row"><span>Tier</span><strong key={tier?.name}>{tier?.name ?? "Free"}</strong></div>
            <div className="rc-row"><span>Agents at once</span><b>{tier?.agents ?? 1}</b></div>
            <div className="rc-row"><span>AI builds a day</span><b>{tier?.compilesPerDay ?? 10}</b></div>
            <div className="tp-slots" aria-hidden>
              {Array.from({ length: slots }, (_, i) => <i key={i} className={i < (tier?.agents ?? 1) ? "on" : ""} />)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ compose */

function Compose() {
  const nav = useNavigate();
  const [text, setText] = useState("");
  const ready = text.trim().length >= 10;
  return (
    <section className="tp-paper tp-final">
      <div className="tp-wrap">
        <h2 className="tp-h2 big" data-reveal>Your strategy, in a sentence.</h2>
        <p className="tp-sub" data-reveal style={{ ["--d" as any]: 1 }}>Type it below. You will see the rules and a backtest before anything runs, and it costs nothing to try.</p>
        <form
          className="tp-compose"
          data-reveal
          style={{ ["--d" as any]: 2 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) nav(`/app/new?prompt=${encodeURIComponent(text.trim())}`);
          }}
        >
          <textarea
            aria-label="Describe your strategy"
            rows={3}
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Buy Nvidia and AMD when they are 3% below the 24-hour average. Sell back above it, stop at 4%."
          />
          <button className="tp-btn field" disabled={!ready}>Build this agent</button>
        </form>
        <p className="tp-fine">Your agent starts on paper at real prices; the house already trades real money. Not financial advice.</p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ page */

/**
 * Things marked data-reveal come in as they scroll into view: text rises, paper prints downward,
 * tickets drop, stamps land. Without IntersectionObserver, or with reduced motion, nothing hides.
 */
function useReveal(deps: unknown[]) {
  const root = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!prefersReduced() && "IntersectionObserver" in window) setArmed(true);
  }, []);
  useEffect(() => {
    const el = root.current;
    if (!el || !armed) return;
    // Paper that "prints" is hidden with clip-path until it comes in, and the browser counts a
    // clipped element as not visible at all; so for those we watch the parent instead.
    const owners = new Map<Element, Element[]>();
    el.querySelectorAll("[data-reveal]:not(.is-in)").forEach((n) => {
      // Anything printed, or sitting on printed paper (a stamp), is watched through the paper's parent.
      const paper = n.closest("[data-reveal=\"print\"]");
      const watch = paper?.parentElement ?? n;
      owners.set(watch, [...(owners.get(watch) ?? []), n]);
    });
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          for (const n of owners.get(e.target) ?? []) n.classList.add("is-in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );
    owners.forEach((_, watch) => io.observe(watch));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, ...deps]);
  return { root, armed };
}

export default function Landing() {
  const stats = useData(api.stats, [], 30_000);
  const markets = useData(api.markets, [], 60_000);
  const activity = useData(() => api.activity(16), [], 30_000);
  const board = useData(api.leaderboard, [], 60_000);
  const token = useData(api.token, []);
  const sample = useMemo(() => (activity.data ?? []).find((a) => a.anchored && a.record?.fill) ?? null, [activity.data]);
  // The example in "How it works" is the Crypto Trend Short house agent: its own rules, replayed for real.
  const example = useMemo(() => (board.data ?? []).find((a) => a.house && a.name === "Crypto Trend Short") ?? null, [board.data]);
  const replay = useData(() => (example ? api.backtest(example.strategy, 30) : Promise.resolve(null)), [example?.id]);
  const last = stats.data?.lastAnchor;
  const { root, armed } = useReveal([board.data, token.data]);
  // Funded real-money agents first, then the best paper agents.
  const stubs = [...(board.data ?? []).filter((a) => a.money === "real" && a.equity > 0), ...(board.data ?? []).filter((a) => a.money !== "real")].slice(0, 4);

  // Arriving from another page at /#section: glide to it once the page has drawn.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: prefersReduced() ? "auto" : "smooth" }), 150);
    return () => clearTimeout(t);
  }, [hash]);

  return (
    <div className={`tp${armed ? " armed" : ""}`} ref={root}>
      <SiteHeader onHome />
      <main>
        <Hero activity={activity.data ?? []} stats={stats.data} markets={markets.data ?? []} />
        <How sample={sample} bt={replay.data ?? null} btName={example?.name ?? "Crypto Trend Short"} />
        <section className="tp-field tp-agents" id="agents">
          <div className="tp-wrap">
            <div className="tp-head">
              <h2 className="tp-h2" data-reveal>Running right now.</h2>
              <Link to="/app" className="tp-link">See every agent</Link>
            </div>
            <p className="tp-sub" data-reveal style={{ ["--d" as any]: 1 }}>
              {stubs.some((a) => a.money === "real")
                ? "House agents trading live. The ones stamped real money swap real tokens from their own wallets; the others trade paper on real prices. Every record is on chain, losing trades included."
                : "House agents trading live on real prices, with paper money. Their whole record is on chain, losing trades included. That is the point."}
            </p>
            <div className="tp-stubs">
              {stubs.map((a, i) => <Stub key={a.id} a={a} i={i} />)}
            </div>
          </div>
        </section>
        <Features />
        <LiveProof receiptId={sample?.id ?? null} />
        <Tiers token={token.data} />
        <Compose />
      </main>
      <SiteFooter lastAnchor={last} note={stats.data?.lastReceiptAt ? `Times are UTC; last printed ${utcStamp(stats.data.lastReceiptAt)}.` : undefined} />
    </div>
  );
}
