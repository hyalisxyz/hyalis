import { Link, useNavigate } from "react-router-dom";
import { api, txUrl } from "../../lib/api";
import { txUrlOn } from "../../lib/chain";
import { useData } from "../../lib/useData";
import { ago, decisionLine, int, money, pct, short } from "../../lib/format";
import { StatusBadge, TierBadge } from "../../components/bits";
import { CountUp } from "../../lib/motion";

export default function Overview() {
  const nav = useNavigate();
  const stats = useData(api.stats, [], 30_000);
  const board = useData(api.leaderboard, [], 30_000);
  const activity = useData(() => api.activity(25), [], 30_000);
  const s = stats.data;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Every agent on the platform, ranked by return since it started.</p>
        </div>
        <Link className="btn btn-primary btn-sm" to="/app/new">Build an agent</Link>
      </div>

      <div className="panel stats">
        <div><div className="k">Agents</div><div className="v num"><CountUp value={s?.agents.total} /></div><div className="s">{s ? `${s.agents.active} running, ${s.agents.paused} paused` : ""}</div></div>
        <div title="A receipt is any sealed record: a trading decision, an hourly equity snapshot, an agent's rules, a deposit.">
          <div className="k">Receipts sealed</div>
          <div className="v num"><CountUp value={s?.receipts.total} /></div>
          <div className="s">{s ? `${int(s.receipts.decisions)} trading decisions, ${int(s.receiptKinds?.snapshot ?? 0)} hourly snapshots, ${int(Math.max(0, s.receipts.total - s.receipts.decisions - (s.receiptKinds?.snapshot ?? 0)))} other records` : ""}</div>
        </div>
        <div title="Each hour's receipts are sealed under one root, published on Robinhood Chain a few minutes after the hour closes.">
          <div className="k">Hourly roots on chain</div>
          <div className="v num"><CountUp value={s?.epochs.anchored} /></div>
          <div className="s">{s ? (s.epochs.anchored === s.epochs.sealed ? `all ${int(s.epochs.sealed)} sealed hours` : `of ${int(s.epochs.sealed)} sealed; the newest ${int(s.epochs.sealed - s.epochs.anchored)} publish within minutes`) : ""}</div>
        </div>
        <div>
          <div className="k">Latest root</div>
          <div className="v num" style={{ fontSize: 22, marginTop: 10 }}>{s?.lastAnchor ? `#${int(s.lastAnchor.block)}` : "–"}</div>
          <div className="s">{s?.lastAnchor ? <a href={txUrl(s.lastAnchor.tx)} target="_blank" rel="noreferrer" className="dim">{short(s.lastAnchor.tx, 10, 6)}, {ago(s.lastAnchor.closedAt)}</a> : "waiting for the first hour"}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><div><h2>Agents</h2><p>House agents are run by the team; the others belong to the wallet shown.</p></div></div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Agent</th><th>Status</th><th>Markets</th><th>Owner</th><th className="r">Equity</th><th className="r">Return</th><th className="r">Trades</th></tr>
            </thead>
            <tbody>
              {(board.data ?? []).map((a) => (
                <tr key={a.id} className="click" onClick={() => nav(`/app/agents/${a.id}`)}>
                  <td className="agent-cell"><b>{a.name}</b><span>{a.strategy.symbols.join(", ")} · {a.strategy.side}</span></td>
                  <td><StatusBadge status={a.status} reason={a.pauseReason} money={a.money} /></td>
                  <td><TierBadge tier={a.markets} /></td>
                  <td className="mono dim" style={{ fontSize: 13 }}>{a.house ? "House" : short(a.owner, 6, 4)}{a.money === "real" ? <b className="loss"> · real money</b> : null}</td>
                  <td className="r num">{money(a.equity, 2)}</td>
                  <td className={`r num ${a.returnPct > 0 ? "gain" : a.returnPct < 0 ? "loss" : ""}`}>{pct(a.returnPct)}</td>
                  <td className="r num">{a.fills}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {board.data && board.data.length === 0 ? <div className="empty"><b>No agents yet</b>Build the first one from a sentence.</div> : null}
        </div>
      </div>

      <div className="cols">
        <div className="panel">
          <div className="panel-h"><div><h2>Recent activity</h2><p>Trading decisions, real swaps and deposits. Each is a receipt, like every hourly snapshot behind the charts; click one to check it.</p></div></div>
          <div className="feed">
            {(activity.data ?? []).map((a) => {
              const r = a.record;
              const real = r.money === "real";
              const tx: string | null = r.swap?.tx ?? r.deposit?.swapTx ?? null;
              const openTx = tx
                ? (e: React.MouseEvent | React.KeyboardEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(txUrlOn(r.swap?.chainId ?? r.chainId, tx), "_blank", "noopener");
                  }
                : null;
              const txLink = openTx ? (
                <span className="tx mono" role="link" tabIndex={0} onClick={openTx} onKeyDown={(e) => (e.key === "Enter" ? openTx(e) : null)} style={{ fontSize: 12.5 }}>
                  tx {short(tx, 6, 4)}
                </span>
              ) : null;
              if (a.kind === "funding") {
                // A run that booked nothing stays in its sealed receipt, not in the feed.
                if (!(Number(r.deposit?.cash ?? r.deposit?.usdg) > 0)) return null;
                return (
                  <Link key={a.id} to={`/app/proofs?receipt=${a.id}`}>
                    <span className="t">{ago(a.createdAt)}</span>
                    <span>
                      <b>{a.agentName}</b> <span className="gain">Funded {money(Number(r.deposit?.cash ?? r.deposit?.usdg ?? 0), 2)}</span>
                      <span className="chip-real">Real</span> {txLink}
                    </span>
                    <span className={`badge ${a.anchored ? "badge-verified" : "badge-paused"}`}>{a.anchored ? "On chain" : "Sealing"}</span>
                  </Link>
                );
              }
              const d = decisionLine(r);
              const filled = r.outcome === "filled" || a.kind === "fill";
              return (
                <Link key={a.id} to={`/app/proofs?receipt=${a.id}`}>
                  <span className="t">{ago(a.createdAt)}</span>
                  <span>
                    <b>{a.agentName}</b>{" "}
                    <span className={d.side === "short" ? "loss" : d.verb === "Close" ? "dim" : "gain"}>{d.verb} {d.symbol}</span>{" "}
                    {filled ? <span className="dim num">at {money(d.price)}</span> : <span className="faint">{r.outcome === "submitted" ? "order sent to Uniswap" : r.why}</span>}
                    {real ? <span className="chip-real">Real</span> : null} {txLink}
                  </span>
                  <span className={`badge ${a.anchored ? "badge-verified" : "badge-paused"}`}>{a.anchored ? "On chain" : "Sealing"}</span>
                </Link>
              );
            })}
            {activity.data && activity.data.length === 0 ? <div className="empty"><b>No decisions yet</b>Agents decide when their rules are met.</div> : null}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><div><h2>How a receipt gets on chain</h2></div></div>
          <div className="panel-b">
            <ol style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", display: "grid", gap: 10, fontSize: 14.5 }}>
              <li>The agent decides, and the price it used is recorded with its Chainlink round.</li>
              <li>When the hour ends, that hour's receipts are sealed under one Merkle root.</li>
              <li>The root is published to the registry contract on Robinhood Chain, linked to the root before it.</li>
              <li>Anyone can check a receipt against that root, in the browser or from the command line.</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
