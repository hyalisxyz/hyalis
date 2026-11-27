import { Fragment, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, EXPLORER } from "../../lib/api";
import { addressUrlOn } from "../../lib/chain";
import { useData } from "../../lib/useData";
import { ago, decisionLine, money, short } from "../../lib/format";
import { RulesList, Spark } from "../../components/bits";
import { useSession } from "../../lib/session";
import { AgentPassport } from "../../components/Passport";
import { JournalPanel } from "../../components/Journal";
import { ShareCardButton } from "../../components/ShareCard";
import { LiveNow } from "../../components/LiveNow";

export default function AgentDetail() {
  const { id = "" } = useParams();
  const s = useSession();
  const detail = useData(() => api.agent(id), [id], 30_000);
  const receipts = useData(() => api.receipts(id, 200), [id], 30_000);
  const journal = useData(() => api.journal(id), [id], 60_000);
  // Live view: prices, rules and profit or loss, every 30 seconds.
  // Real money: every 5 seconds (the server marks positions at executable prices that often).
  const live = useData(() => api.agentNow(id), [id], detail.data?.agent.money === "real" ? 5_000 : 15_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  if (detail.error)
    return (
      <div className="page">
        <div className="empty">
          <b>{/not found/i.test(String(detail.error)) ? "No agent with this id" : "This agent could not be loaded"}</b>
          {/not found/i.test(String(detail.error)) ? "Check the link, or find it in the list of every agent." : String(detail.error)}
          <div style={{ marginTop: 14 }}><Link className="btn btn-primary btn-sm" to="/app">Back to Overview</Link></div>
        </div>
      </div>
    );
  if (!detail.data) return <div className="page faint">Loading…</div>;
  const { agent, account } = detail.data;
  const mine = Boolean(s.address && agent.owner && agent.owner.toLowerCase() === s.address.toLowerCase());

  const curve = (receipts.data ?? [])
    .filter((r) => r.kind === "snapshot")
    .map((r) => [r.record.at as number, r.record.equity as number] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const decisions = (receipts.data ?? []).filter((r) => r.kind === "decision" || r.kind === "fill");

  const toggle = async () => {
    setMsg(null);
    const token = s.token ?? (await s.signIn());
    if (!token) return;
    setBusy(true);
    try {
      const r = await api.setStatus(token, agent.id, agent.status === "active" ? "pause" : "resume");
      setMsg({ kind: "ok", text: r.status === "active" ? "Agent resumed." : "Agent paused. Open positions stay open and are still protected by liquidation." });
      detail.reload();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError && e.body?.agentSlots !== undefined ? `No free slot: ${e.body.agentsActive} of ${e.body.agentSlots} in use. Pause another agent or raise your tier.` : (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      {agent.basedOn ? (
        <p className="faint" style={{ fontSize: 14, margin: "0 0 12px" }}>
          This agent was built on the sealed lessons of <Link to={`/app/agents/${agent.basedOn}`}>an earlier agent</Link>.
        </p>
      ) : null}
      {agent.money === "real" && agent.wallet ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <b>Real money.</b> This agent swaps real tokens on Uniswap{agent.chain === "arbitrum" ? " on Arbitrum One" : ""} from its own wallet{" "}
          <a className="mono" href={agent.chain === "arbitrum" ? addressUrlOn(42161, agent.wallet) : `${EXPLORER}/address/${agent.wallet}`} target="_blank" rel="noreferrer">{short(agent.wallet, 6, 4)}</a>
          . Its balance and every swap can be checked on chain.
        </div>
      ) : null}
      <AgentPassport
        agent={agent}
        account={{
          equity: live.data?.equity ?? account.equity,
          startEquity: live.data?.startEquity ?? account.startEquity,
          returnPct: live.data?.returnPct ?? account.returnPct,
          openPositions: account.account.positions.length,
        }}
        journal={journal.data ?? null}
        mine={mine}
        onLinked={detail.reload}
        actions={
          <>
            <ShareCardButton agent={agent} account={account} journal={journal.data ?? null} />
            {mine && !agent.vault && agent.endedAt == null ? (
              <button className="btn btn-ghost btn-sm" onClick={toggle} disabled={busy}>
                {agent.status === "active" ? "Pause agent" : "Resume agent"}
              </button>
            ) : null}
          </>
        }
      />
      {msg ? <div className={`notice ${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"} style={{ marginBottom: 16 }}>{msg.text}</div> : null}
      {live.data ? (
        <LiveNow
          chainId={agent.chain === "arbitrum" ? 42161 : 4663}
          now={live.data}
          real={agent.money === "real"}
          stopping={busy}
          onStop={
            mine && agent.endedAt == null
              ? async () => {
                  if (!window.confirm(agent.vault ? "Stop now? The agent sells its position and sends everything back to your wallet." : "Stop this agent now? Its positions close.")) return;
                  setMsg(null);
                  const token = s.token ?? (await s.signIn());
                  if (!token) return;
                  setBusy(true);
                  try {
                    await api.stopAgent(token, agent.id);
                    setMsg({ kind: "ok", text: agent.vault ? "Stopping: the position is sold and the money goes back to your wallet within a minute." : "Stopped." });
                    detail.reload();
                    live.reload();
                  } catch (e) {
                    setMsg({ kind: "err", text: (e as Error).message });
                  } finally {
                    setBusy(false);
                  }
                }
              : undefined
          }
        />
      ) : null}

      <div className="cols">
        <div style={{ display: "grid", gap: 18 }}>
          <JournalPanel journal={journal.data ?? null} agentId={agent.id} />
          <div className="panel">
            <div className="panel-h"><div><h2>Equity, hour by hour</h2><p>From the sealed hourly snapshots.</p></div></div>
            <div className="panel-b"><Spark points={curve} /></div>
          </div>
          <div className="panel">
            <div className="panel-h"><div><h2>Decisions</h2><p>Every decision is a receipt you can check.</p></div></div>
            <div className="feed">
              {decisions.map((r) => {
                const d = decisionLine(r.record);
                const filled = r.record.outcome === "filled" || r.kind === "fill";
                return (
                  <Link key={r.id} to={`/app/proofs?receipt=${r.id}`}>
                    <span className="t">{ago(r.createdAt)}</span>
                    <span>
                      <span className={d.side === "short" ? "loss" : d.verb === "Close" ? "dim" : "gain"}>{d.verb} {d.symbol}</span>{" "}
                      {filled ? <span className="dim num">at {money(d.price)}</span> : <span className="faint">{r.record.outcome === "submitted" ? "order sent to Uniswap" : String(r.record.why ?? "")}</span>}
                      {r.record.money === "real" ? <span className="chip-real">Real</span> : null}
                      {r.record.swap?.tx ? <span className="faint mono" style={{ fontSize: 12.5 }}> tx {short(r.record.swap.tx, 6, 4)}</span> : null}
                      <div className="faint" style={{ fontSize: 13 }}>{r.record.decision?.reason ?? r.record.reason}</div>
                    </span>
                    <span className="faint mono" style={{ fontSize: 12 }}>#{r.id}</span>
                  </Link>
                );
              })}
              {receipts.data && decisions.length === 0 ? <div className="empty"><b>No decisions yet</b>The agent is waiting for its entry rules to be met.</div> : null}
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gap: 18 }}>
          <div className="panel">
            <div className="panel-h"><div><h2>Rules</h2><p>Exactly what the agent runs. Sealed on chain when it was created.</p></div></div>
            <div className="panel-b"><RulesList s={agent.strategy} /></div>
          </div>
          <div className="panel">
            <div className="panel-h"><div><h2>Positions</h2></div></div>
            <div className="panel-b">
              {account.account.positions.length === 0 ? (
                <div className="faint">No open positions.</div>
              ) : (
                <dl className="kv">
                  {account.account.positions.map((p) => (
                    <Fragment key={p.symbol}>
                      <dt>{p.symbol}</dt>
                      <dd>
                        <span className={p.side === "short" ? "loss" : "gain"}>{p.side}</span> {p.qty.toPrecision(4)} at {money(p.entryPrice)} ({p.venue}{p.leverage > 1 ? `, ${p.leverage}x` : ""}), {ago(p.openedAt)}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
