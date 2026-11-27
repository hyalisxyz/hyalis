import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useData } from "../../lib/useData";
import { useSession } from "../../lib/session";
import { ago, money, pct } from "../../lib/format";
import { StatusBadge, TierBadge } from "../../components/bits";

export function MyAgents() {
  const nav = useNavigate();
  const s = useSession();
  const me = useData(() => (s.token ? api.me(s.token) : Promise.resolve(null)), [s.token], 30_000);

  if (!s.connected)
    return (
      <div className="page"><div className="panel empty"><b>Connect your wallet</b>Your agents are tied to the wallet that created them.<div style={{ marginTop: 16 }}><button className="btn btn-primary" onClick={s.connect}>Connect wallet</button></div></div></div>
    );
  if (!s.token)
    return (
      <div className="page"><div className="panel empty"><b>Sign in to see your agents</b>Signing a message proves the wallet is yours. It costs no gas.<div style={{ marginTop: 16 }}><button className="btn btn-primary" onClick={s.signIn} disabled={s.signingIn}>{s.signingIn ? "Check your wallet…" : "Sign in"}</button></div></div></div>
    );

  const m = me.data;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>My agents</h1><p>{m ? `${m.agentsActive} of ${m.agentSlots} slots in use on the ${m.tier.name} tier.` : "Loading…"}</p></div>
        <Link className="btn btn-primary btn-sm" to="/app/new">Build an agent</Link>
      </div>
      {m && m.agentsPausedOverQuota > 0 ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          {m.agentsPausedOverQuota} agent{m.agentsPausedOverQuota > 1 ? "s are" : " is"} paused because you have more agents than slots. They resume on their own when a slot frees up. <Link to="/app/wallet" className="gain">See your tier</Link>
        </div>
      ) : null}
      <div className="panel">
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Agent</th><th>Status</th><th>Markets</th><th className="r">Equity</th><th className="r">Return</th><th className="r">Created</th></tr></thead>
            <tbody>
              {(m?.agents ?? []).map((a) => {
                const ret = ((a.account.equity - a.account.startEquity) / a.account.startEquity) * 100;
                return (
                  <tr key={a.id} className="click" onClick={() => nav(`/app/agents/${a.id}`)}>
                    <td className="agent-cell"><b>{a.name}</b><span>{a.prompt ? `“${a.prompt.slice(0, 80)}${a.prompt.length > 80 ? "…" : ""}”` : a.strategy.summary}</span></td>
                    <td><StatusBadge status={a.status} reason={a.pauseReason} money={a.money} /></td>
                    <td><TierBadge tier={a.markets} /></td>
                    <td className="r num">{money(a.account.equity, 2)}</td>
                    <td className={`r num ${ret > 0 ? "gain" : ret < 0 ? "loss" : ""}`}>{pct(ret)}</td>
                    <td className="r faint">{ago(a.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {m && m.agents.length === 0 ? <div className="empty"><b>You have no agents yet</b>Write a strategy in a sentence and test it first.<div style={{ marginTop: 16 }}><Link className="btn btn-primary" to="/app/new">Build your first agent</Link></div></div> : null}
        </div>
      </div>
    </div>
  );
}

export function Markets() {
  const markets = useData(api.markets, [], 60_000);
  const vc = useData(api.vaultConfig, []);
  // Where each market trades with real money: Robinhood Chain when it has a token there, else Arbitrum One.
  const realOn = (sym: string): string | null => {
    const c = vc.data?.chains;
    if (c?.robinhood?.tokens[sym]) return "robinhood";
    if (c?.arbitrum?.tokens[sym]) return "arbitrum";
    return null;
  };
  const groups: Array<{ title: string; note: string; rows: NonNullable<typeof markets.data> }> = [
    { title: "Stocks and ETFs", note: "Chainlink on Robinhood Chain. Trade 24/5, Sunday 8pm to Friday 8pm New York time.", rows: (markets.data ?? []).filter((m) => m.assetClass === "equity") },
    { title: "Crypto, verified", note: "Chainlink on Robinhood Chain, cross-checked against a second source. 24/7.", rows: (markets.data ?? []).filter((m) => m.assetClass === "crypto" && m.tier === "verified") },
    { title: "Crypto, data feed", note: "Priced from CoinGecko. Recorded on every receipt but not checkable on chain. Paper trading, except those marked Arbitrum: their swaps run on Arbitrum One, where the vault checks every trade against Chainlink.", rows: (markets.data ?? []).filter((m) => m.tier === "data-feed") },
  ];
  return (
    <div className="page">
      <div className="page-head"><div><h1>Markets</h1><p>{markets.data ? `${markets.data.length} markets agents can trade.` : "Loading…"}</p></div></div>
      <div style={{ display: "grid", gap: 18 }}>
        {groups.map((g) => (
          <div className="panel" key={g.title}>
            <div className="panel-h"><div><h2>{g.title}</h2><p>{g.note}</p></div><span className="faint">{g.rows.length}</span></div>
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Symbol</th><th>Price</th><th>Source</th><th>Hours</th><th className="r">Updated</th><th className="r"><span className="sr-only">Trade</span></th></tr></thead>
                <tbody>
                  {g.rows.map((m) => (
                    <tr key={m.symbol}>
                      <td><span className="sym"><img src={`/logos/${m.symbol}.webp`} alt="" width={26} height={26} loading="lazy" decoding="async" /><b>{m.symbol}</b></span></td>
                      <td className="num">{money(m.price)}</td>
                      <td><TierBadge tier={m.tier} /></td>
                      <td className="dim">{m.hours}</td>
                      <td className="r faint">{ago(m.updatedAt)}</td>
                      <td className="r">
                        {realOn(m.symbol) ? (
                          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                            {realOn(m.symbol) === "arbitrum" ? <span className="faint" style={{ fontSize: 12 }}>on Arbitrum</span> : null}
                            <Link className="btn btn-primary btn-sm" to={`/app/run?symbol=${m.symbol}`}>Trade</Link>
                          </span>
                        ) : (
                          <span className="faint" style={{ fontSize: 12 }}>paper only</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
