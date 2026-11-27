import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { api, txUrl } from "../../lib/api";
import { useData } from "../../lib/useData";
import { useSession } from "../../lib/session";
import { publicClient, robinhoodChain, switchToRobinhood, walletClient } from "../../lib/chain";
import { allowanceOf, approveCall, balanceOf, poolToken, quote, swapCall, type Route, type TradeToken } from "../../lib/swap";
import { ago, money, short } from "../../lib/format";

/**
 * Manual trading inside Hyalis: swap between ETH, USDG and the stock tokens from your own wallet,
 * on the official Uniswap V3 router. Hyalis never holds the funds; your wallet signs, and the
 * trade is then read from the chain and sealed as a receipt in your history.
 */

const SLIPPAGES = [50, 100, 200] as const;
/** Further than this from the oracle price and the page asks for a second confirmation. */
const WARN_GAP = 0.03;

type Step = "idle" | "switching" | "approving" | "swapping" | "recording";

export default function Trade() {
  const s = useSession();
  const me = (s.address ?? null) as Address | null;
  const cfg = useData(api.tradeConfig, []);
  const markets = useData(api.markets, [], 60_000);
  const history = useData(() => (me ? api.trades(me) : Promise.resolve([])), [me]);
  const tokens = cfg.data?.tokens ?? [];

  const [fromSym, setFromSym] = useState("ETH");
  const [toSym, setToSym] = useState("USDG");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState<number>(100);
  const [route, setRoute] = useState<Route | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [noRoute, setNoRoute] = useState(false);
  const [bal, setBal] = useState<bigint | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; tx?: string } | null>(null);
  const [confirmGap, setConfirmGap] = useState(false);

  const from = tokens.find((t) => t.symbol === fromSym) ?? null;
  const to = tokens.find((t) => t.symbol === toSym) ?? null;
  const amountIn = useMemo(() => {
    if (!from || !amount) return 0n;
    try {
      return parseUnits(amount, from.decimals);
    } catch {
      return 0n;
    }
  }, [amount, from]);

  // Balance of the token being sold.
  useEffect(() => {
    setBal(null);
    if (!me || !from) return;
    let live = true;
    balanceOf(from, me).then((b) => live && setBal(b)).catch(() => null);
    return () => {
      live = false;
    };
  }, [me, from, step]);

  // Quote, a moment after typing stops.
  useEffect(() => {
    setRoute(null);
    setNoRoute(false);
    setConfirmGap(false);
    if (!from || !to || amountIn === 0n || poolToken(from) === poolToken(to)) return;
    let live = true;
    setQuoting(true);
    const t = setTimeout(() => {
      quote(from, to, amountIn)
        .then((r) => {
          if (!live) return;
          setRoute(r);
          setNoRoute(!r);
        })
        .catch(() => live && setNoRoute(true))
        .finally(() => live && setQuoting(false));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [from, to, amountIn]);

  // Dollar values from the oracle prices, to show what each side is worth and catch a bad pool price.
  const usdOf = (t: TradeToken | null, units: bigint): number | null => {
    if (!t) return null;
    const n = Number(formatUnits(units, t.decimals));
    if (t.symbol === "USDG") return n;
    const sym = t.symbol === "WETH" ? "ETH" : t.symbol;
    const p = markets.data?.find((m) => m.symbol === sym)?.price;
    return p ? n * p : null;
  };
  const usdIn = usdOf(from, amountIn);
  const usdOut = route ? usdOf(to, route.amountOut) : null;
  const gap = usdIn && usdOut ? usdOut / usdIn - 1 : null;
  const minOut = route ? (route.amountOut * BigInt(10_000 - slip)) / 10_000n : 0n;
  const wrongChain = s.connected && s.chainId !== robinhoodChain.id;
  const tooMuch = bal !== null && amountIn > bal;
  const busy = step !== "idle";

  const swap = async () => {
    if (!me || !from || !to || !route) return;
    setMsg(null);
    try {
      if (wrongChain) {
        setStep("switching");
        await switchToRobinhood();
      }
      const w = walletClient(me);
      // Approval for exactly this amount, when selling a token (ETH needs none).
      if (from.address !== "ETH") {
        const allowed = await allowanceOf(from.address, me);
        if (allowed < route.amountIn) {
          setStep("approving");
          const a = approveCall(from.address, route.amountIn);
          const h = await w.sendTransaction({ account: me, chain: robinhoodChain, to: a.to, data: a.data });
          const r = await publicClient.waitForTransactionReceipt({ hash: h });
          if (r.status !== "success") throw new Error("the approval failed");
        }
      }
      setStep("swapping");
      const call = swapCall(from, to, route, minOut, me, Math.floor(Date.now() / 1000) + 600);
      const hash = await w.sendTransaction({ account: me, chain: robinhoodChain, to: call.to, data: call.data, value: call.value });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("the swap failed on chain; nothing was traded");
      setStep("recording");
      let recorded = false;
      for (let i = 0; i < 6 && !recorded; i++) {
        try {
          await api.recordTrade(hash);
          recorded = true;
        } catch {
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
      setMsg({ kind: "ok", text: `Swapped ${amount} ${from.symbol} for about ${fmt(to, route.amountOut)} ${to.symbol}.${recorded ? " It is in your history below." : ""}`, tx: hash });
      setAmount("");
      history.reload();
    } catch (e) {
      const m = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? "something went wrong";
      setMsg({ kind: "err", text: /reject|denied/i.test(m) ? "You cancelled it in your wallet." : m.split("\n")[0]! });
    } finally {
      setStep("idle");
    }
  };

  const button = !s.connected
    ? { label: "Connect wallet", on: () => s.connect(), off: !s.hasWallet }
    : !from || !to
      ? { label: "Loading tokens", on: undefined, off: true }
      : fromSym === toSym || (from && to && poolToken(from) === poolToken(to))
        ? { label: "Pick two different tokens", on: undefined, off: true }
        : amountIn === 0n
          ? { label: "Enter an amount", on: undefined, off: true }
          : tooMuch
            ? { label: `Not enough ${from.symbol}`, on: undefined, off: true }
            : quoting
              ? { label: "Finding the best price", on: undefined, off: true }
              : noRoute || !route
                ? { label: "No pool can fill this", on: undefined, off: true }
                : gap !== null && gap < -WARN_GAP && !confirmGap
                  ? { label: "Confirm the price below first", on: undefined, off: true }
                  : {
                      label:
                        step === "switching" ? "Switching network" : step === "approving" ? `Approving ${from.symbol}` : step === "swapping" ? "Swapping" : step === "recording" ? "Recording" : wrongChain ? "Switch to Robinhood Chain and swap" : "Swap",
                      on: swap,
                      off: busy,
                    };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Trade</h1>
          <p>Swap ETH, USDG and stock tokens from your own wallet. Your wallet signs; Hyalis never holds your funds.</p>
        </div>
      </div>

      <div className="cols trade-cols">
        <div className="panel">
          <div className="panel-b trade">
            <TokenBox label="You sell" tokens={tokens} sym={fromSym} onSym={(v) => (v === toSym ? (setToSym(fromSym), setFromSym(v)) : setFromSym(v))}>
              <input className="trade-amt num" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} aria-label="Amount to sell" />
              <div className="trade-sub">
                <span>{usdIn !== null && amountIn > 0n ? `≈ ${money(usdIn, 2)}` : " "}</span>
                {bal !== null && from ? (
                  <button type="button" className="linkish" onClick={() => setAmount(maxOf(from, bal))}>
                    Balance {fmt(from, bal)} · Max
                  </button>
                ) : null}
              </div>
            </TokenBox>
            <button type="button" className="trade-flip" aria-label="Swap the two tokens" onClick={() => (setFromSym(toSym), setToSym(fromSym), setAmount(""))}>
              ↓↑
            </button>
            <TokenBox label="You get" tokens={tokens} sym={toSym} onSym={(v) => (v === fromSym ? (setFromSym(toSym), setToSym(v)) : setToSym(v))}>
              <div className="trade-amt num out">{route && to ? fmt(to, route.amountOut) : quoting ? "…" : "0.0"}</div>
              <div className="trade-sub"><span>{usdOut !== null ? `≈ ${money(usdOut, 2)}` : " "}</span></div>
            </TokenBox>

            <div className="trade-meta">
              <div>
                <span>Slippage</span>
                <span className="seg">
                  {SLIPPAGES.map((b) => (
                    <button type="button" key={b} className={slip === b ? "on" : ""} onClick={() => setSlip(b)}>{b / 100}%</button>
                  ))}
                </span>
              </div>
              {route && to ? (
                <>
                  <div><span>Least you get</span><span className="num">{fmt(to, minOut)} {to.symbol}</span></div>
                  <div><span>Route</span><span>Uniswap V3{route.fees.length === 2 ? ", through USDG" : ""} · fee {route.fees.map((f) => `${f / 10_000}%`).join(" + ")}</span></div>
                  {gap !== null ? (
                    <div><span>Against the oracle</span><span className={gap < -WARN_GAP ? "loss" : "dim"}>{gap >= 0 ? "+" : ""}{(gap * 100).toFixed(2)}%</span></div>
                  ) : null}
                </>
              ) : null}
            </div>

            {route && gap !== null && gap < -WARN_GAP ? (
              <label className="notice err" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input type="checkbox" checked={confirmGap} onChange={(e) => setConfirmGap(e.target.checked)} />
                <span>This trade gets {(-gap * 100).toFixed(1)}% less than the Chainlink price says it is worth: the pool is thin at this size. Tick to trade anyway.</span>
              </label>
            ) : null}

            <button className="btn btn-primary trade-go" disabled={button.off} onClick={button.on}>{button.label}</button>
            {!s.hasWallet ? <p className="faint" style={{ fontSize: 13 }}>Install a browser wallet to trade.</p> : null}
            {msg ? (
              <div className={`notice ${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>
                {msg.text}{" "}
                {msg.tx ? <a href={txUrl(msg.tx)} target="_blank" rel="noreferrer">View the transaction</a> : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-h"><div><h2>Your trades</h2><p>Read from the chain and sealed as receipts.</p></div></div>
          <div className="feed">
            {!me ? <div className="empty"><b>Connect a wallet</b>Your trades will show here.</div> : null}
            {(history.data ?? []).map((t) => (
              <a key={t.tx} href={txUrl(t.tx)} target="_blank" rel="noreferrer">
                <span className="t">{ago(t.at)}</span>
                <span>
                  <span className="dim num">{trim(t.sellAmount)} {t.sellSymbol}</span> → <b className="num">{trim(t.buyAmount)} {t.buySymbol}</b>
                </span>
                <span className="faint mono" style={{ fontSize: 12 }}>{short(t.tx, 6, 4)}</span>
              </a>
            ))}
            {me && history.data && history.data.length === 0 ? <div className="empty"><b>No trades yet</b>Your first swap will show here.</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function TokenBox({ label, tokens, sym, onSym, children }: { label: string; tokens: TradeToken[]; sym: string; onSym: (s: string) => void; children: React.ReactNode }) {
  return (
    <div className="trade-box">
      <div className="trade-top">
        <span className="faint">{label}</span>
        <select value={sym} onChange={(e) => onSym(e.target.value)} aria-label={`${label}: token`}>
          {tokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
        </select>
      </div>
      {children}
    </div>
  );
}

const trim = (s: string) => {
  const n = Number(s);
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toPrecision(4);
};
const fmt = (t: TradeToken, units: bigint) => trim(formatUnits(units, t.decimals));
/** The whole balance, keeping a little ETH for gas. */
const maxOf = (t: TradeToken, b: bigint) => formatUnits(t.address === "ETH" ? (b > 30_000_000_000_000n ? b - 30_000_000_000_000n : 0n) : b, t.decimals);
