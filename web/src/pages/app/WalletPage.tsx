import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, txUrl } from "../../lib/api";
import { useData } from "../../lib/useData";
import { useSession } from "../../lib/session";
import { date, short, tokens } from "../../lib/format";

export default function WalletPage() {
  const s = useSession();
  const [params] = useSearchParams();
  const address = params.get("address") ?? s.address;
  const [tx, setTx] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const token = useData(api.token, []);
  const w = useData(() => (address ? api.wallet(address) : Promise.resolve(null)), [address], 30_000);

  if (!address)
    return (
      <div className="page"><div className="panel empty"><b>Connect your wallet</b>Your balance and tier show here the moment you connect. No signature needed.<div style={{ marginTop: 16 }}><button className="btn btn-primary" onClick={s.connect}>Connect wallet</button></div></div></div>
    );

  const v = w.data;
  const t = token.data;
  const own = Boolean(s.address && address.toLowerCase() === s.address.toLowerCase());
  const progress = v?.nextTier ? Math.min(100, (Number(v.balance) / v.nextTier.minTokens) * 100) : 100;

  const claim = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const tk = s.token ?? (await s.signIn());
    if (!tk) return;
    setBusy(true);
    try {
      const r = await api.claimBurn(tk, tx.trim());
      setMsg({ kind: "ok", text: r.already ? `This burn was already counted: ${r.slots} slot(s) until ${date(r.expiresAt)}.` : `Burn counted: +${r.slots} agent slot(s) until ${date(r.expiresAt)}.` });
      setTx("");
      w.reload();
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof ApiError ? err.message : (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div><h1>Wallet & tier</h1><p className="mono">{short(address, 10, 8)}</p></div>
      </div>
      {w.error ? <div className="notice err">The balance could not be read from the chain right now. Try again in a moment.</div> : null}

      {v ? (
        <>
          <div className="panel stats">
            <div><div className="k">Balance</div><div className="v num">{tokens(v.balance)}</div><div className="s">{v.token.launched ? v.token.symbol : "Token not launched yet"}</div></div>
            <div><div className="k">Tier</div><div className="v">{v.tier.name}</div><div className="s">{v.nextTier ? `${tokens(v.nextTier.needed)} more for ${v.nextTier.name}` : "Highest tier"}</div></div>
            <div><div className="k">Agent slots</div><div className="v num">{v.agentsActive} / {v.agentSlots}</div><div className="s">{v.burnSlots.length ? `${v.burnSlots.reduce((a, b) => a + b.slots, 0)} from burns` : "in use / available"}</div></div>
            <div><div className="k">AI builds today</div><div className="v num">{v.compilesToday} / {v.compilesPerDay}</div><div className="s">resets 00:00 UTC</div></div>
          </div>

          {v.nextTier ? (
            <div className="panel panel-b" style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 14 }}>
                <span>{v.tier.name}</span><span className="dim">{v.nextTier.name}: {tokens(v.nextTier.minTokens)} tokens, {v.nextTier.agents} agents</span>
              </div>
              <div className="meter"><i style={{ width: `${progress}%` }} /></div>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="cols" style={{ marginTop: 0 }}>
        <div className="panel">
          <div className="panel-h"><div><h2>Tiers</h2><p>{t?.launched ? "Read from your token balance on every visit." : "Everyone is on the first tier until the token launches on Pons."}</p></div></div>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Tier</th><th className="r">Tokens held</th><th className="r">Agents</th><th className="r">AI builds a day</th></tr></thead>
              <tbody>
                {(t?.tiers ?? []).map((x) => (
                  <tr key={x.name} style={v?.tier.name === x.name ? { background: "rgba(139,155,255,0.06)" } : undefined}>
                    <td><b>{x.name}</b>{v?.tier.name === x.name ? <span className="badge badge-verified" style={{ marginLeft: 8 }}>You</span> : null}</td>
                    <td className="r num">{tokens(x.minTokens)}</td>
                    <td className="r num">{x.agents}</td>
                    <td className="r num">{x.compilesPerDay}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-h"><div><h2>Burn for a slot</h2><p>{t ? `Send ${tokens(t.burn.tokensPerSlot)} tokens to the dead address, then paste the transaction here. One slot per ${tokens(t.burn.tokensPerSlot)}, for ${t.burn.slotDays} days.` : ""}</p></div></div>
          <div className="panel-b">
            {!t?.launched ? (
              <div className="notice">Burning opens when the token launches.</div>
            ) : !own ? (
              <div className="notice">Connect the wallet that sent the burn to claim it.</div>
            ) : (
              <form onSubmit={claim} style={{ display: "grid", gap: 10 }}>
                <input className="input mono" value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x… transaction hash" aria-label="Burn transaction hash" />
                <button className="btn btn-primary btn-sm" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(tx.trim())}>{busy ? "Checking the transaction…" : "Claim slot"}</button>
              </form>
            )}
            {msg ? <div className={`notice ${msg.kind}`} style={{ marginTop: 12 }}>{msg.text}</div> : null}
            {v?.burnSlots.length ? (
              <ul style={{ paddingLeft: 18, marginBottom: 0, color: "var(--text-2)", fontSize: 14 }}>
                {v.burnSlots.map((b) => <li key={b.txHash}>+{b.slots} until {date(b.expiresAt)} · <a href={txUrl(b.txHash)} target="_blank" rel="noreferrer" className="dim">{short(b.txHash)}</a></li>)}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
