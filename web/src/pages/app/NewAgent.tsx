import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, type Backtest, type Strategy } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useData } from "../../lib/useData";
import { money, pct } from "../../lib/format";
import { RulesList, Spark } from "../../components/bits";
import { SessionError } from "../../components/Wallet";
import { LessonList } from "../../components/Journal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXAMPLES = [
  "Buy Nvidia, AMD and Micron when they are 3% below the 24-hour average and RSI is under 40. Sell back above the average, stop at 4%.",
  "Short BTC and ETH while they trade 1.5% below the 72-hour average and are falling. Cover above the average.",
  "Buy SPY and QQQ when they dip 1% below the daily average but are still above the 5-day trend. Stop loss 3%.",
];

export default function NewAgent() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const s = useSession();
  const [prompt, setPrompt] = useState(params.get("prompt") ?? "");
  const [days, setDays] = useState(30);
  // Test several versions of the strategy and pick the steadiest on the first part of the history.
  const [several, setSeveral] = useState(true);
  const [versions, setVersions] = useState<{ list: Array<{ strategy: Strategy; backtest: Backtest; chosen: boolean }>; deflated: number | null } | null>(null);
  const [busy, setBusy] = useState<"" | "test" | "create">("");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ strategy: Strategy; backtest: Backtest; basedOnDigest?: string } | null>(null);
  const wallet = useData(() => (s.address ? api.wallet(s.address) : Promise.resolve(null)), [s.address, result]);
  // Building on an earlier agent: its public lessons go to the AI with the strategy.
  const basedOnParam = params.get("basedOn");
  const basedOn = basedOnParam && UUID.test(basedOnParam) ? basedOnParam : null;
  const base = useData(() => (basedOn ? Promise.all([api.agent(basedOn), api.journal(basedOn)]) : Promise.resolve(null)), [basedOn]);

  useEffect(() => setResult(null), [prompt]);
  // Start from the earlier agent's summary, so the user edits rather than starts over.
  useEffect(() => {
    if (base.data && !prompt) setPrompt(base.data[0].agent.strategy.summary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.data]);

  const explain = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 403 && e.body?.agentSlots !== undefined) return `Every agent slot is in use (${e.body.agentsActive} of ${e.body.agentSlots}). Pause an agent, hold more tokens or burn for a slot.`;
      if (e.status === 429) return e.body?.error ?? "Daily AI limit reached; it resets at 00:00 UTC.";
      if (e.status === 422) return `These rules do not fit the limits: ${(e.body?.errors ?? []).join("; ")}`;
      if (e.status === 401) return "Your sign-in expired. Sign in again.";
      if (e.status === 409) return "The earlier agent closed another trade and its lessons changed since your test. Test again to use the newest lessons.";
    }
    return (e as Error).message;
  };

  const token = async () => s.token ?? (await s.signIn());

  const test = async () => {
    setErr(null);
    const t = await token();
    if (!t) return;
    setBusy("test");
    try {
      const r = await api.createAgent(t, { prompt, dryRun: true, backtestDays: days, ...(several ? { versions: true } : {}), ...(basedOn ? { basedOn } : {}) });
      setResult({ strategy: r.strategy!, backtest: r.backtest, basedOnDigest: r.basedOn?.digest });
      setVersions(r.versions ? { list: r.versions, deflated: r.selection?.deflatedSharpe ?? null } : null);
    } catch (e) {
      setErr(explain(e));
    } finally {
      setBusy("");
    }
  };

  const create = async () => {
    if (!result) return;
    setErr(null);
    const t = await token();
    if (!t) return;
    setBusy("create");
    try {
      // The exact rules that were tested are created; the AI is not asked again.
      const r = await api.createAgent(t, {
        strategy: result.strategy,
        name: result.strategy.name,
        backtestDays: days,
        // The lessons the AI saw in the test are the ones recorded on the agent.
        ...(basedOn ? { basedOn, ...(result.basedOnDigest ? { basedOnDigest: result.basedOnDigest } : {}) } : {}),
      });
      nav(`/app/agents/${r.agent!.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setResult(null);
      setErr(explain(e));
    } finally {
      setBusy("");
    }
  };

  const w = wallet.data;
  const bt = result?.backtest;
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <h1>New agent</h1>
          <p>Describe the strategy. You will see the exact rules and a backtest before anything runs.</p>
        </div>
        {w ? <span className="pill">{w.agentsActive} of {w.agentSlots} agent slots in use · {w.compilesPerDay - w.compilesToday} AI builds left today</span> : null}
      </div>

      {basedOn ? (
        <section className="panel learning" style={{ marginBottom: 18 }} aria-labelledby="learning-h">
          <div className="panel-h">
            <div>
              <h2 id="learning-h">
                {base.data ? `Your new agent starts with what ${base.data[0].agent.name} learned` : "Your new agent starts with an earlier agent's lessons"}
              </h2>
              <p>
                {base.data && base.data[1].lessons.length
                  ? `${base.data[1].lessons.length === 1 ? "One lesson" : `${base.data[1].lessons.length} lessons`} from ${base.data[1].closedTrades} sealed trades go to the AI with your strategy. Where they disagree, your words win, and the AI says which lesson each change answers.`
                  : "The AI reads the earlier agent's record with your strategy. Where they disagree, your words win."}
              </p>
            </div>
          </div>
          {base.error ? (
            <div className="panel-b"><div className="notice err">That agent could not be loaded: {base.error}</div></div>
          ) : !base.data ? (
            <div className="panel-b faint">Reading its lessons…</div>
          ) : base.data[1].lessons.length === 0 ? (
            <div className="panel-b faint">It has no lessons yet ({base.data[1].closedTrades} closed trades). Your agent is still recorded as built on it.</div>
          ) : (
            <LessonList lessons={base.data[1].lessons} compact />
          )}
        </section>
      ) : null}

      <div className="panel">
        <div className="panel-b">
          <label htmlFor="prompt" className="sr-only">Strategy</label>
          <textarea id="prompt" className="textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000}
            placeholder="For example: buy Nvidia when it drops 3% in a day and RSI is under 35, sell at 6% profit or 5% loss." />
          <div className="chips">
            {EXAMPLES.map((e) => (
              <button key={e} className="chip" onClick={() => setPrompt(e)}>{e.length > 70 ? `${e.slice(0, 70)}…` : e}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 18, flexWrap: "wrap" }}>
            {!s.connected ? (
              <button className="btn btn-primary" onClick={s.connect}>Connect wallet to start</button>
            ) : (
              <button className="btn btn-primary" onClick={test} disabled={busy !== "" || prompt.trim().length < 10}>
                {busy === "test" ? "Building rules and testing…" : s.token ? "Build rules and test" : "Sign in, then build and test"}
              </button>
            )}
            <label className="dim" style={{ fontSize: 14 }}>
              Test over{" "}
              <select className="input" style={{ width: "auto", display: "inline-block", height: 36 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
            <label className="dim" style={{ fontSize: 14, display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={several} onChange={(e) => setSeveral(e.target.checked)} /> Try 3–4 versions and pick the steadiest
            </label>
            <span className="faint" style={{ fontSize: 13 }}>Signing in costs no gas. It only proves the wallet is yours.</span>
          </div>
          <SessionError />
          {err ? <div className="notice err" style={{ marginTop: 14 }}>{err}</div> : null}
        </div>
      </div>

      {result && versions && versions.list.length > 1 ? (
        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-h">
            <div>
              <h2>{versions.list.length} versions, tested side by side</h2>
              <p>
                Picked on the first 70% of the last {days} days (steadiest gains), then checked on the last 30%, which the pick never saw.
                {versions.deflated !== null ? ` After allowing for having tried ${versions.list.length}, the chance its edge is more than luck: ${Math.round(versions.deflated * 100)}%.` : ""}
              </p>
            </div>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Version</th><th className="r">Picked on (70%)</th><th className="r">Checked on (30%)</th><th className="r">Whole period</th><th className="r">Sharpe</th><th /></tr></thead>
              <tbody>
                {versions.list.map((v) => {
                  const on = v.strategy === result.strategy || v.strategy.name === result.strategy.name;
                  return (
                    <tr key={v.strategy.name} className={on ? "on-row" : ""}>
                      <td className="agent-cell"><b>{v.strategy.name}{v.chosen ? <span className="badge badge-active" style={{ marginLeft: 8 }}>picked</span> : null}</b><span>{v.strategy.summary}</span></td>
                      <td className="r num">{v.backtest.split ? pct(v.backtest.split.inSample.returnPct) : "–"}</td>
                      <td className={`r num ${(v.backtest.split?.outOfSample.returnPct ?? 0) >= 0 ? "gain" : "loss"}`}>{v.backtest.split ? pct(v.backtest.split.outOfSample.returnPct) : "–"}</td>
                      <td className="r num">{pct(v.backtest.returnPct)}</td>
                      <td className="r num">{v.backtest.metrics?.sharpe ?? "–"}</td>
                      <td className="r">{on ? <span className="faint">shown below</span> : <button className="btn btn-ghost btn-sm" onClick={() => setResult({ ...result, strategy: v.strategy, backtest: v.backtest })}>Use this one</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {result && bt ? (
        <div className="cols">
          <div className="panel">
            <div className="panel-h">
              <div><h2>Backtest, last {days} days</h2><p>Same engine the live agent uses, on recorded prices.</p></div>
              <span className={`badge ${bt.returnPct >= 0 ? "badge-active" : "badge-paused"}`}>{pct(bt.returnPct)}</span>
            </div>
            <div className="panel-b">
              <Spark points={bt.equityCurve} />
              <dl className="kv" style={{ marginTop: 16 }}>
                <dt>Return</dt><dd className={bt.returnPct >= 0 ? "gain" : "loss"}>{pct(bt.returnPct)} ({money(bt.endEquity, 2)} from {money(bt.startEquity, 0)})</dd>
                <dt>Just holding</dt><dd>{pct(bt.benchmarkReturnPct)}</dd>
                <dt>Worst drawdown</dt><dd>{bt.maxDrawdownPct.toFixed(2)}%</dd>
                <dt>Trades</dt><dd>{bt.trades.length}{bt.winRatePct !== null ? `, ${bt.winRatePct}% won` : ""}</dd>
                <dt>In the market</dt><dd>{bt.exposurePct}% of the time</dd>
                <dt>Fees</dt><dd>{money(bt.fees, 2)}</dd>
                {bt.metrics ? (
                  <>
                    <dt title="Return per unit of ups and downs, yearly. Above 1 is good, above 2 is rare.">Sharpe</dt><dd>{bt.metrics.sharpe ?? "–"}</dd>
                    <dt title="Like Sharpe, but only falls count as risk.">Sortino</dt><dd>{bt.metrics.sortino ?? "–"}</dd>
                    <dt title="Yearly return over the deepest fall.">Calmar</dt><dd>{bt.metrics.calmar ?? "–"}</dd>
                    <dt title="Money won on winning trades over money lost on losing ones.">Profit factor</dt><dd>{bt.metrics.profitFactor ?? "–"}</dd>
                    <dt title="Probabilistic Sharpe: how likely the true edge is above zero, given how many hours there were and how lumpy they were.">Edge is real</dt><dd>{bt.metrics.probabilisticSharpe === null ? "–" : `${Math.round(bt.metrics.probabilisticSharpe * 100)}% likely`}</dd>
                  </>
                ) : null}
                {bt.split ? (
                  <>
                    <dt>First 70%</dt><dd>{pct(bt.split.inSample.returnPct)}</dd>
                    <dt>Last 30%</dt><dd className={bt.split.outOfSample.returnPct >= 0 ? "gain" : "loss"}>{pct(bt.split.outOfSample.returnPct)}</dd>
                  </>
                ) : null}
              </dl>
              <ul style={{ color: "var(--text-3)", fontSize: 13, paddingLeft: 18, marginBottom: 0 }}>
                {bt.caveats.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
          </div>
          <div className="panel">
            <div className="panel-h"><div><h2>{result.strategy.name}</h2><p>{result.strategy.summary}</p></div></div>
            <div className="panel-b">
              <RulesList s={result.strategy} />
              {result.strategy.notes.length ? (
                <div className="notice" style={{ marginTop: 14 }}>
                  <b style={{ color: "var(--text)" }}>What the AI changed or assumed</b>
                  <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>{result.strategy.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                </div>
              ) : null}
              <button className="btn btn-primary" style={{ marginTop: 18, width: "100%" }} onClick={create} disabled={busy !== ""}>
                {busy === "create" ? "Starting the agent…" : "Start this agent"}
              </button>
              <p className="faint" style={{ fontSize: 13, marginBottom: 0 }}>Paper trading with $10,000 of virtual equity. Its rules are sealed on chain when it starts.</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
