import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { encodeFunctionData, erc20Abi, formatUnits, parseAbi, parseEther, parseUnits, type Address } from "viem";
import { api, ApiError, type Backtest, type Strategy, type VaultChainConfig } from "../../lib/api";
import { useData } from "../../lib/useData";
import { useSession } from "../../lib/session";
import { addressUrlOn, chainById, publicClientOn, robinhoodChain, switchTo, txUrlOn, walletClientOn } from "../../lib/chain";
import { money, pct, short } from "../../lib/format";
import { RulesList } from "../../components/bits";

/**
 * Trade a market with an agent and real money, from the user's own vault:
 * pick the market, long, how the agent should trade (a Hyalis agent's rules, or your own words),
 * how much ETH or cash (USDG on Robinhood Chain, USDC on Arbitrum One), and when to stop. One
 * signature makes the vault and puts the money in; Stop (or the run's own limits) sells and
 * sends everything back to the wallet. A market trades on Robinhood Chain when it has a token
 * there (stocks, ETH), else on Arbitrum One (major crypto).
 */

const factoryAbi = parseAbi([
  "function createVaultWith(address executor, (uint256 maxTradeUsd, uint256 maxDailyUsd, uint256 maxTokenUsd, uint16 maxSlippageBps) policy, address[] tokens, address[] adapters, address depositToken, uint256 depositAmount) payable returns (address)",
]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const vaultAbi = parseAbi(["function returnToOwner(address[] tokens)"]);

type How = "agent" | "words";
type Step = "idle" | "reviewing" | "signing" | "approving" | "creating" | "starting";

export default function RunPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const s = useSession();
  const me = (s.address ?? null) as Address | null;
  const symbol = params.get("symbol") ?? "ETH";
  const markets = useData(api.markets, [], 60_000);
  const vc = useData(api.vaultConfig, []);
  const board = useData(api.leaderboard, []);
  const market = markets.data?.find((m) => m.symbol === symbol) ?? null;
  // The chain this market trades on with real money: Robinhood Chain first, then Arbitrum One.
  const chains = vc.data?.chains ?? {};
  const cc: VaultChainConfig | null = chains.robinhood?.tokens[symbol] ? chains.robinhood : chains.arbitrum?.tokens[symbol] ? chains.arbitrum : null;
  const net = cc ? chainById(cc.chainId) : robinhoodChain;
  const pc = publicClientOn(net);
  const cashSym = cc?.cashSymbol ?? "USDG";
  // Slots are checked before anything is signed: a vault is never made for an agent that cannot start.
  const ent = useData(() => (me ? api.wallet(me) : Promise.resolve(null)), [me]);
  const slotsFull = Boolean(ent.data && ent.data.agentsActive >= ent.data.agentSlots);
  // Vaults of this wallet that hold money but have no agent (made earlier, whose agent did not start).
  const [orphans, setOrphans] = useState<Array<{ vault: string; cash: string; cashToken: string; weth: string; chain: "robinhood" | "arbitrum" }>>([]);
  const loadOrphans = async (token: string) => {
    try {
      const r = await api.vaultMine(token);
      setOrphans(
        r.vaults
          .map((v) => ({ vault: v.vault, cash: v.cash ?? v.usdg, cashToken: v.cashToken ?? "USDG", weth: v.weth, agentId: v.agentId, chain: v.chain ?? "robinhood" }))
          .filter((v) => !v.agentId && (Number(v.cash) > 0 || Number(v.weth) > 0)),
      );
    } catch {
      /* not critical */
    }
  };
  useEffect(() => {
    if (s.token) void loadOrphans(s.token);
  }, [s.token]);
  const ethPrice = markets.data?.find((m) => m.symbol === "ETH")?.price ?? null;

  const [how, setHow] = useState<How>("agent");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [words, setWords] = useState("");
  const [asset, setAsset] = useState<"ETH" | "CASH">("ETH");
  const [amount, setAmount] = useState("");
  const [minutes, setMinutes] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [bal, setBal] = useState<bigint | null>(null);
  const [review, setReview] = useState<{ strategy: Strategy; backtest: Backtest } | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; tx?: string; chainId?: number } | null>(null);

  // House agents whose kind of rules fit this market (same asset class), best record first.
  const templates = useMemo(
    () =>
      (board.data ?? [])
        .filter((a) => a.house && a.money !== "real" && a.strategy.side === "long" && a.strategy.leverage === 1)
        .filter((a) => a.strategy.symbols.some((sym) => markets.data?.find((m) => m.symbol === sym)?.assetClass === market?.assetClass))
        .sort((a, b) => b.returnPct - a.returnPct),
    [board.data, markets.data, market],
  );
  useEffect(() => {
    if (!templateId && templates[0]) setTemplateId(templates[0].id);
  }, [templates, templateId]);
  const template = templates.find((t) => t.id === templateId) ?? null;

  useEffect(() => {
    setBal(null);
    if (!me) return;
    let live = true;
    if (asset === "CASH" && !cc) return;
    const read = asset === "ETH" ? pc.getBalance({ address: me }) : pc.readContract({ address: cc!.cash as Address, abi: erc20Abi, functionName: "balanceOf", args: [me] });
    read.then((b) => live && setBal(b)).catch(() => null);
    return () => {
      live = false;
    };
  }, [me, asset, cc?.key, cc?.cash, step]);

  const units = useMemo(() => {
    try {
      return amount ? (asset === "ETH" ? parseEther(amount) : parseUnits(amount, cc?.cashDecimals ?? 6)) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, asset, cc?.cashDecimals]);
  const usd = asset === "CASH" ? Number(amount || 0) : ethPrice ? Number(amount || 0) * ethPrice : null;
  const maxUsd = cc?.maxDepositUsd ?? vc.data?.maxDepositUsd ?? 100;
  const assetLabel = asset === "ETH" ? "ETH" : cashSym;
  const busy = step !== "idle";
  // Review again whenever the inputs change.
  useEffect(() => setReview(null), [how, templateId, words, minutes, takeProfit, stopLoss, symbol]);

  /** Auto-stop fields, applied on top of the rules (they win over anything the words said). */
  const ends = (st: Strategy): Strategy => {
    const out = { ...st } as Strategy & Record<string, unknown>;
    if (Number(minutes) > 0) out.endAfterMinutes = Number(minutes);
    if (Number(takeProfit) > 0) out.endAtProfitPct = Number(takeProfit);
    if (Number(stopLoss) > 0) out.endAtLossPct = Math.abs(Number(stopLoss));
    return out;
  };

  const doReview = async () => {
    setMsg(null);
    const token = s.token ?? (await s.signIn());
    if (!token) return;
    void loadOrphans(token);
    setStep("reviewing");
    try {
      const policy = { maxLeverage: 1, maxLeverageCrypto: 1, maxPositionPct: 100, maxOpenPositions: 1, allowShort: false, allowedSymbols: [symbol] };
      let st: Strategy;
      let bt: Backtest;
      if (how === "agent") {
        if (!template) throw new Error("Pick an agent first.");
        const base = { ...template.strategy, name: `${template.name} · ${symbol}`, symbols: [symbol], side: "long" as const, leverage: 1, positionPct: 95, maxOpenPositions: 1 };
        const r = await api.createAgent(token, { strategy: ends(base), dryRun: true, policy, backtestDays: 14 });
        st = r.strategy!;
        bt = r.backtest;
      } else {
        if (words.trim().length < 10) throw new Error("Write a sentence or two about how the agent should trade.");
        const r = await api.createAgent(token, { prompt: `${words.trim()}\n(Market: ${symbol} only, long only, spot.)`, dryRun: true, policy, backtestDays: 14 });
        // One market, one position at a time: the trade uses the deposit (the brain's 10% default would leave most of it idle).
        st = ends({ ...r.strategy!, symbols: [symbol], side: "long", leverage: 1, maxOpenPositions: 1, positionPct: Math.max(r.strategy!.positionPct, 95) });
        bt = r.backtest;
      }
      setReview({ strategy: st, backtest: bt });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? String(e.body?.error ?? e.message) + (e.body?.errors ? `: ${e.body.errors.join("; ")}` : "") : (e as Error).message });
    } finally {
      setStep("idle");
    }
  };

  /** Starts the reviewed agent on a vault made earlier (no new vault, no new deposit). */
  const startOn = async (vault: string, chain: "robinhood" | "arbitrum") => {
    if (!review) return;
    setMsg(null);
    try {
      const token = s.token ?? (await s.signIn());
      if (!token) return;
      setStep("starting");
      const made = await api.startVaultAgent(token, { chain, vault, strategy: review.strategy, name: review.strategy.name, ...(how === "words" ? { prompt: words.trim() } : {}), ...(how === "agent" && template ? { basedOn: template.id } : {}) });
      nav(`/app/agents/${made.agent.id}`);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? String(e.body?.error ?? e.message) : (e as Error).message });
    } finally {
      setStep("idle");
    }
  };

  /** The owner sends everything in a vault back to the wallet (WETH as ETH); signed in the wallet. */
  const sendBack = async (vault: string, chain: "robinhood" | "arbitrum") => {
    const oc = chains[chain];
    if (!me || !oc) return;
    const onNet = chainById(oc.chainId);
    setMsg(null);
    try {
      if (s.chainId !== onNet.id) await switchTo(onNet);
      setStep("signing");
      // Every token the vault could hold on its chain: cash, WETH, and each tradable token.
      const tokens = [oc.cash, oc.weth, ...Object.values(oc.tokens)];
      const h = await walletClientOn(me, onNet).sendTransaction({ account: me, chain: onNet, to: vault as Address, data: encodeFunctionData({ abi: vaultAbi, functionName: "returnToOwner", args: [[...new Set(tokens.map((t) => t.toLowerCase()))] as Address[]] }) });
      setStep("creating");
      const r = await publicClientOn(onNet).waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error("sending it back failed on chain; the money is still in your vault");
      setMsg({ kind: "ok", text: "Sent back to your wallet.", tx: h, chainId: onNet.id });
      setOrphans((o) => o.filter((v) => v.vault !== vault));
    } catch (e) {
      const m = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
      setMsg({ kind: "err", text: /reject|denied/i.test(m) ? "You cancelled it in your wallet." : m.split("\n")[0]! });
    } finally {
      setStep("idle");
    }
  };

  const start = async () => {
    if (!me || !review || !cc || !market) return;
    if (slotsFull) {
      setMsg({ kind: "err", text: "Your agent slot is in use. Pause an agent in My agents (or hold more tokens for more slots), then start." });
      return;
    }
    setMsg(null);
    try {
      const token = s.token ?? (await s.signIn());
      if (!token) return;
      if (s.chainId !== net.id) await switchTo(net);
      const w = walletClientOn(me, net);
      const cfg = cc;
      const tokenAddr = cfg.tokens[symbol] as Address | undefined;
      if (!tokenAddr) throw new Error(`${symbol} has no token on ${cfg.name}`);
      // The vault's own limits: a trade at most 1.5x the deposit, plenty of room for a short run's in and out, 2% below the oracle at worst.
      const cap = BigInt(Math.max(5, Math.ceil((usd ?? 0) * 1.5))) * 10n ** 8n;
      const policy = { maxTradeUsd: cap, maxDailyUsd: cap * 40n, maxTokenUsd: 0n, maxSlippageBps: 200 };
      if (asset === "CASH") {
        const allowed = await pc.readContract({ address: cfg.cash as Address, abi: erc20Abi, functionName: "allowance", args: [me, cfg.factory as Address] });
        if (allowed < units) {
          setStep("approving");
          const h = await w.sendTransaction({ account: me, chain: net, to: cfg.cash as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.factory as Address, units] }) });
          await pc.waitForTransactionReceipt({ hash: h });
        }
      }
      setStep("signing");
      const data = encodeFunctionData({
        abi: factoryAbi,
        functionName: "createVaultWith",
        args: [cfg.executor as Address, policy, [tokenAddr], [cfg.adapter as Address], asset === "CASH" ? (cfg.cash as Address) : ZERO, asset === "CASH" ? units : 0n],
      });
      const hash = await w.sendTransaction({ account: me, chain: net, to: cfg.factory as Address, data, value: asset === "ETH" ? units : 0n });
      setStep("creating");
      const r = await pc.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("making the vault failed on chain; nothing was moved");
      setStep("starting");
      let made: Awaited<ReturnType<typeof api.startVaultAgent>> | null = null;
      for (let i = 0; i < 6 && !made; i++) {
        try {
          made = await api.startVaultAgent(token, {
            chain: cfg.key,
            txHash: hash,
            strategy: review.strategy,
            name: review.strategy.name,
            ...(how === "words" ? { prompt: words.trim() } : {}),
            ...(how === "agent" && template ? { basedOn: template.id } : {}),
          });
        } catch (e) {
          if (e instanceof ApiError && e.status !== 404 && e.status !== 503) throw e;
          await new Promise((res) => setTimeout(res, 2500));
        }
      }
      if (!made) throw new Error("The vault is made and funded, but the agent did not start yet. Your money is safe in your vault: start it from the banner above, or send it back.");
      nav(`/app/agents/${made.agent.id}`);
    } catch (e) {
      const m = e instanceof ApiError ? String(e.body?.error ?? e.message) : ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
      setMsg({ kind: "err", text: /reject|denied/i.test(m) ? "You cancelled it in your wallet. Nothing was moved." : m.split("\n")[0]! });
      if (s.token) void loadOrphans(s.token);
    } finally {
      setStep("idle");
    }
  };

  const tooMuch = usd !== null && usd > maxUsd;
  // Every trade must be at least $1 (the vault's minimum order).
  const tradeTooSmall = Boolean(review && usd !== null && units > 0n && (usd * review.strategy.positionPct) / 100 < 1);
  const tooLittle = usd !== null && usd > 0 && usd < 2;
  const noFunds = bal !== null && units > bal;

  return (
    <div className="page run">
      <div className="page-head">
        <div>
          <h1>
            <span className="sym"><img src={`/logos/${symbol}.webp`} alt="" width={40} height={40} /></span> Trade {symbol} with an agent
          </h1>
          <p>
            Real money from your own vault{cc ? ` on ${cc.name}` : ""}. Only your wallet can take money out; the agent can only trade {symbol} and hand everything back to you.
            {market?.price ? ` ${symbol} is ${money(market.price, market.price < 10 ? 4 : 2)} now.` : ""}
          </p>
        </div>
        <Link className="btn btn-ghost btn-sm" to="/app/markets">All markets</Link>
      </div>

      {vc.data && !cc ? <div className="notice err">{vc.data.on ? `${symbol} cannot be traded with real money yet; paper agents can trade it.` : "Real-money agents are not available right now."}</div> : null}
      {orphans.map((o) => (
        <div key={o.vault} className="notice" style={{ marginBottom: 16 }}>
          <b>Your vault <a className="mono" href={addressUrlOn(chains[o.chain]?.chainId, o.vault)} target="_blank" rel="noreferrer">{short(o.vault, 6, 4)}</a>{o.chain !== "robinhood" ? ` on ${chains[o.chain]?.name ?? o.chain}` : ""} holds {Number(o.weth) > 0 ? `${Number(o.weth)} ETH` : ""}{Number(o.weth) > 0 && Number(o.cash) > 0 ? " and " : ""}{Number(o.cash) > 0 ? `${Number(o.cash).toFixed(2)} ${o.cashToken}` : ""} but has no agent yet.</b>{" "}
          Only your wallet can take it out.
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {o.chain === cc?.key ? (
              <button className="btn btn-primary btn-sm" disabled={busy || slotsFull} onClick={() => (review ? startOn(o.vault, o.chain) : doReview())} title={slotsFull ? "Free an agent slot first" : ""}>
                {slotsFull ? "Free an agent slot first" : review ? "Start the agent on this vault" : "Review the rules for this vault"}
              </button>
            ) : null}
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => sendBack(o.vault, o.chain)}>Send it back to my wallet</button>
          </div>
        </div>
      ))}
      {slotsFull ? (
        <div className="notice err" style={{ marginBottom: 16 }}>
          Your {ent.data?.tier.name} tier has {ent.data?.agentSlots} agent slot{ent.data?.agentSlots === 1 ? "" : "s"}, and {ent.data?.agentsActive === 1 ? "it is" : "they are"} in use. <Link to="/app/mine">Pause an agent</Link> to free one before you start; nothing is signed until then.
        </div>
      ) : null}

      <div className="cols run-cols">
        <div className="panel">
          <div className="panel-b run-form">
            <div className="run-q">
              <span className="run-n">1</span>
              <div>
                <b>Direction</b>
                <div className="seg big">
                  <button type="button" className="on">Long: profit if it rises</button>
                  <button type="button" disabled title="Shorting needs perpetual futures, which are not live yet">Short (soon)</button>
                </div>
              </div>
            </div>

            <div className="run-q">
              <span className="run-n">2</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>How should it trade?</b>
                <div className="seg big">
                  <button type="button" className={how === "agent" ? "on" : ""} onClick={() => setHow("agent")}>Use a Hyalis agent</button>
                  <button type="button" className={how === "words" ? "on" : ""} onClick={() => setHow("words")}>In my own words</button>
                </div>
                {how === "agent" ? (
                  <div className="run-tpl">
                    {templates.map((t) => (
                      <label key={t.id} className={`run-tpl-i${t.id === templateId ? " on" : ""}`}>
                        <input type="radio" name="tpl" checked={t.id === templateId} onChange={() => setTemplateId(t.id)} />
                        <span>
                          <b>{t.name}</b>
                          <span className="faint">{t.strategy.summary}</span>
                        </span>
                        <span className={`num ${t.returnPct > 0 ? "gain" : t.returnPct < 0 ? "loss" : ""}`}>{pct(t.returnPct)}<small className="faint"> on paper since {new Date(t.since * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small></span>
                      </label>
                    ))}
                    {board.data && templates.length === 0 ? <p className="faint">No Hyalis agent fits {symbol} yet; write your own.</p> : null}
                  </div>
                ) : (
                  <>
                    <textarea
                      className="run-words"
                      rows={4}
                      value={words}
                      onChange={(e) => setWords(e.target.value)}
                      placeholder={`Buy ${symbol} now and hold for 2 minutes. Stop if I'm up 1% or down 1%.`}
                    />
                    <div className="run-chips">
                      {[`Buy ${symbol} now and hold for 2 minutes. Stop at +1% or -1%.`, `Buy ${symbol} when it breaks its 24-hour high, trail the stop by 3%.`, `Buy the dip: ${symbol} 3% under its 24-hour average, sell back above it.`].map((c) => (
                        <button key={c} type="button" onClick={() => setWords(c)}>{c}</button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="run-q">
              <span className="run-n">3</span>
              <div style={{ flex: 1 }}>
                <b>How much</b>
                <div className="run-amt">
                  <input className="num" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} aria-label="Amount" />
                  <select value={asset} onChange={(e) => setAsset(e.target.value as "ETH" | "CASH")} aria-label="Pay with">
                    <option value="ETH">ETH</option>
                    <option value="CASH">{cashSym}</option>
                  </select>
                </div>
                <div className="trade-sub">
                  <span>{usd !== null && units > 0n ? `≈ ${money(usd, 2)}` : `Up to ${money(maxUsd, 0)} during the beta`}</span>
                  {bal !== null ? <span>Balance {Number(formatUnits(bal, asset === "ETH" ? 18 : cc?.cashDecimals ?? 6)).toLocaleString("en-US", { maximumFractionDigits: 5 })} {assetLabel}{cc && cc.key !== "robinhood" ? ` on ${cc.name}` : ""}</span> : null}
                </div>
              </div>
            </div>

            <div className="run-q">
              <span className="run-n">4</span>
              <div style={{ flex: 1 }}>
                <b>Auto stop</b> <span className="faint">(optional; ends the run and sends the money back)</span>
                <div className="run-stops">
                  <label>After <input inputMode="numeric" placeholder="–" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, ""))} /> min</label>
                  <label>At <span className="gain">+</span><input inputMode="decimal" placeholder="–" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value.replace(/[^0-9.]/g, ""))} />%</label>
                  <label>At <span className="loss">−</span><input inputMode="decimal" placeholder="–" value={stopLoss} onChange={(e) => setStopLoss(e.target.value.replace(/[^0-9.]/g, ""))} />%</label>
                </div>
              </div>
            </div>

            {!review ? (
              <button className="btn btn-primary trade-go" disabled={busy || !s.connected} onClick={doReview}>
                {!s.connected ? "Connect your wallet first" : step === "reviewing" ? "Reading the rules" : "Review the rules"}
              </button>
            ) : (
              <button className="btn btn-primary trade-go" disabled={busy || !units || tooMuch || tooLittle || noFunds || !cc || slotsFull || tradeTooSmall} onClick={start}>
                {slotsFull ? "Free an agent slot first" : tradeTooSmall ? `Each trade would be under $1; put in more` : step === "approving" ? `Approving ${cashSym}` : step === "signing" ? "Confirm in your wallet" : step === "creating" ? "Making your vault" : step === "starting" ? "Starting the agent" : tooMuch ? `At most ${money(maxUsd, 0)} during the beta` : tooLittle ? "At least $2" : noFunds ? `Not enough ${assetLabel}` : !units ? "Enter an amount" : `Start with ${amount} ${assetLabel}${cc && cc.key !== "robinhood" ? ` on ${cc.name}` : ""}`}
              </button>
            )}
            {!s.connected ? <button className="btn btn-ghost" onClick={() => s.connect()}>Connect wallet</button> : null}
            {msg ? <div className={`notice ${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}{msg.tx ? <> <a href={txUrlOn(msg.chainId ?? net.id, msg.tx)} target="_blank" rel="noreferrer">tx</a></> : null}</div> : null}
          </div>
        </div>

        <div style={{ display: "grid", gap: 18, alignContent: "start" }}>
          {review ? (
            <div className="panel">
              <div className="panel-h"><div><h2>What it will do</h2><p>These rules are sealed on chain when it starts.</p></div></div>
              <div className="panel-b">
                <RulesList s={review.strategy} />
                {usd ? <p className="faint" style={{ fontSize: 13.5 }}>Each trade uses about {money((usd * review.strategy.positionPct) / 100, 2)} of the {money(usd, 2)} you put in.</p> : null}
                <div className="run-ends">
                  {review.strategy.endAfterMinutes ? <span>Ends after <b>{review.strategy.endAfterMinutes} min</b></span> : null}
                  {review.strategy.endAtProfitPct ? <span>or at <b className="gain">+{review.strategy.endAtProfitPct}%</b></span> : null}
                  {review.strategy.endAtLossPct ? <span>or at <b className="loss">−{review.strategy.endAtLossPct}%</b></span> : null}
                  {!review.strategy.endAfterMinutes && !review.strategy.endAtProfitPct && !review.strategy.endAtLossPct ? <span>Runs until you press Stop.</span> : null}
                </div>
                <p className="faint" style={{ fontSize: 13.5 }}>
                  Last 14 days with these rules: {pct(review.backtest.returnPct)} (holding {symbol}: {review.backtest.benchmarkReturnPct === null ? "–" : pct(review.backtest.benchmarkReturnPct)}), worst dip {review.backtest.maxDrawdownPct}%. Past results say little about the future.
                </p>
              </div>
            </div>
          ) : null}
          <div className="panel">
            <div className="panel-h"><div><h2>How it works</h2></div></div>
            <div className="panel-b">
              <ol className="run-how">
                <li><b>One signature</b> makes your own vault{cc ? ` on ${cc.name}` : ""} and puts your {assetLabel} in it. Only your wallet can take money out.</li>
                <li><b>The agent trades {symbol}</b> on Uniswap inside your vault, within limits the vault itself enforces: trade size, 2% below the Chainlink price at worst.</li>
                <li><b>Every decision is a receipt</b>, sealed on chain, with its reason and the swap's transaction.</li>
                <li><b>Stop any time</b>, or let the auto stop end it: it sells, and everything goes back to your wallet.</li>
              </ol>
              {cc ? <p className="faint mono" style={{ fontSize: 12 }}>{cc.name} · vault factory <a href={addressUrlOn(cc.chainId, cc.factory)} target="_blank" rel="noreferrer">{short(cc.factory, 6, 4)}</a> · agent <a href={addressUrlOn(cc.chainId, cc.executor)} target="_blank" rel="noreferrer">{short(cc.executor, 6, 4)}</a></p> : null}
              {cc && cc.key !== "robinhood" ? <p className="faint" style={{ fontSize: 13 }}>{symbol} has no token on Robinhood Chain, so it trades on {cc.name}. You need a little ETH on {cc.name} for the one signature; the agent pays its own gas. Receipts are still sealed on Robinhood Chain.</p> : null}
              <p className="faint" style={{ fontSize: 13 }}>Beta: up to {money(maxUsd, 0)} a vault. Trading can lose money. Not financial advice.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
