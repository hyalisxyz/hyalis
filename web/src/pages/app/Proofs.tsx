import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, txUrl, type ReceiptProof } from "../../lib/api";
import { useData } from "../../lib/useData";
import { verifyReceipt, type Check } from "../../lib/verify";
import { ago, decisionLine, int, money, short } from "../../lib/format";

const MARK: Record<Check["state"], { cls: string; ch: string }> = {
  ok: { cls: "ok", ch: "✓" },
  fail: { cls: "ok no", ch: "✕" },
  skip: { cls: "ok wait", ch: "–" },
  wait: { cls: "ok wait", ch: "…" },
};

export default function Proofs() {
  const [params, setParams] = useSearchParams();
  const [id, setId] = useState(params.get("receipt") ?? "");
  const [receipt, setReceipt] = useState<ReceiptProof | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const epochs = useData(api.epochs, [], 60_000);

  const run = async (rid: string) => {
    setErr(null);
    setChecks(null);
    setReceipt(null);
    if (!/^\d+$/.test(rid)) return;
    try {
      const r = await api.receipt(rid);
      setReceipt(r);
      await verifyReceipt(r, setChecks);
    } catch (e) {
      setErr(`Receipt ${rid} could not be loaded: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    const r = params.get("receipt");
    if (r) {
      setId(r);
      run(r);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const d = receipt ? decisionLine(receipt.record) : null;
  const allOk = checks?.every((c) => c.state === "ok");
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Proofs</h1><p>Check any receipt in your browser. It reads Robinhood Chain directly and does not trust this site's server.</p></div>
      </div>

      <form className="panel panel-b" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); setParams({ receipt: id }); }}>
        <label htmlFor="rid" className="dim">Receipt number</label>
        <input id="rid" className="input" style={{ width: 180 }} inputMode="numeric" value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ""))} placeholder="for example 6" />
        <button className="btn btn-primary btn-sm" disabled={!id}>Check receipt</button>
      </form>
      {err ? <div className="notice err" style={{ marginTop: 14 }}>{err}</div> : null}

      {receipt ? (
        <div className="cols">
          <div className="panel">
            <div className="panel-h">
              <div><h2>Receipt #{receipt.id}</h2><p>{d ? `${d.verb} ${d.symbol}${d.price ? ` at ${money(d.price)}` : ""}` : receipt.record.kind}, epoch {receipt.epoch}</p></div>
              {checks && !checks.some((c) => c.state === "wait") ? (
                <span className={`badge ${allOk ? "badge-active" : checks.some((c) => c.state === "fail") ? "badge-paused" : "badge-feed"}`}>
                  {allOk ? "All 4 checks passed" : checks.some((c) => c.state === "fail") ? "A check failed" : "Partly checkable"}
                </span>
              ) : null}
            </div>
            <div className="panel-b">
              <ul className="checks">
                {(checks ?? []).map((c) => (
                  <li key={c.label}><span className={MARK[c.state].cls}>{MARK[c.state].ch}</span><div><b>{c.label}</b><small className="mono">{c.detail}</small></div></li>
                ))}
              </ul>
            </div>
          </div>
          <div className="panel">
            <div className="panel-h"><div><h2>The record</h2><p>Exactly what was sealed.</p></div></div>
            <pre className="mono" style={{ margin: 0, padding: "16px 20px", fontSize: 12, lineHeight: 1.55, color: "var(--text-2)", maxHeight: 520, overflow: "auto" }}>
              {JSON.stringify(receipt.record, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="panel-h"><div><h2>Hourly roots</h2><p>Each root seals one hour of receipts and names the root before it.</p></div></div>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Epoch</th><th>Root</th><th className="r">Receipts</th><th>On chain</th><th className="r">Sealed</th></tr></thead>
            <tbody>
              {(epochs.data ?? []).map((e) => (
                <tr key={e.epoch}>
                  <td className="num">{e.epoch}</td>
                  <td className="mono dim" style={{ fontSize: 13 }}>{short(e.root, 10, 8)}</td>
                  <td className="r num">{e.leafCount}</td>
                  <td>{e.anchorTx ? <a className="badge badge-verified" href={txUrl(e.anchorTx)} target="_blank" rel="noreferrer">Block {int(e.anchorBlock)}</a> : <span className="badge badge-paused">Publishing</span>}</td>
                  <td className="r faint">{ago(e.closedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {epochs.data && epochs.data.length === 0 ? <div className="empty"><b>No roots yet</b>The first root is sealed when the first hour with decisions ends.</div> : null}
        </div>
      </div>
    </div>
  );
}
