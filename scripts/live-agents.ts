/**
 * Real-money house agents: create them, see their wallets, fund them, start and stop them.
 *
 *   node --env-file-if-exists=.env scripts/live-agents.ts create [--yes]        the two agents below (paused, empty)
 *   node --env-file-if-exists=.env scripts/live-agents.ts status                wallets and balances
 *   node --env-file-if-exists=.env scripts/live-agents.ts fund <id> [--yes] [--tx <hash>]
 *                                         ETH/WETH in the wallet -> USDG cash, then start; --tx names the swap
 *                                         when booking USDG a stopped run already swapped
 *   node --env-file-if-exists=.env scripts/live-agents.ts stop <id>             pause (positions stay as they are)
 *
 * On the server: docker exec agent-utility node scripts/live-agents.ts <command> ...
 * Everything is a preview unless --yes is given (stop excepted).
 */
import { loadConfig, loadMarkets } from "../src/config.ts";
import { openDb } from "../src/store/db.ts";
import { chainClient } from "../src/sources/chainlink.ts";
import { createAgent, getAccount, getAgent, listAgents, setStatus } from "../src/engine/agents.ts";
import { addReceipt, epochOf } from "../src/engine/epochs.ts";
import { Policy } from "../src/guard/policy.ts";
import { checkBounds, type Strategy } from "../src/strategy/schema.ts";
import { LiveTrader } from "../src/live/live.ts";

const [cmd, arg] = process.argv.slice(2);
const YES = process.argv.includes("--yes");
const config = loadConfig();
if (!config.LIVE_MNEMONIC) {
  console.error("LIVE_MNEMONIC is not set");
  process.exit(2);
}
const markets = loadMarkets();
const db = openDb(config.DB_PATH);
const chain = chainClient(config.RPC_URL);
const trader = new LiveTrader(db, chain, {
  mnemonic: config.LIVE_MNEMONIC,
  markets,
  slippageBps: config.LIVE_SLIPPAGE_BPS,
  maxGapBps: config.LIVE_MAX_GAP_BPS,
  minOrderUsd: config.LIVE_MIN_ORDER_USD,
  epochSec: config.EPOCH_SEC,
  rpcUrl: config.RPC_URL,
});
const now = () => Math.floor(Date.now() / 1000);
const live = () => listAgents(db).filter((a) => a.liveIndex !== null);

/** The real-money versions of two house agents: same rules, sized for a small wallet, spot only. */
function plans(): Array<{ index: number; name: string; strategy: Strategy; policy: Policy }> {
  const base = (name: string) => {
    const a = listAgents(db).find((x) => x.name === name && x.owner === null && x.liveIndex === null);
    if (!a) throw new Error(`house agent "${name}" not found`);
    return a.strategy;
  };
  const ethLong = base("Crypto Trend Long");
  const megacap = base("Megacap Pullback");
  return [
    {
      index: 0,
      name: "Crypto Trend Long · Real",
      strategy: {
        ...ethLong,
        name: "Crypto Trend Long · Real",
        summary: "The Crypto Trend Long rules on ETH with real money: buys when ETH is clearly above its 48-hour average and rising, sells when it falls back below.",
        symbols: ["ETH"],
        positionPct: 95,
        maxOpenPositions: 1,
        notes: [...ethLong.notes, "Real money: swaps on Uniswap V3 from its own wallet. ETH only, because BTC has no token on Robinhood Chain."],
      },
      policy: Policy.parse({ maxLeverage: 1, maxLeverageCrypto: 1, maxPositionPct: 95, maxOpenPositions: 1, dailyLossPct: 10, allowShort: false, allowedSymbols: ["ETH"] }),
    },
    {
      index: 1,
      name: "Megacap Pullback · Real",
      strategy: {
        ...megacap,
        name: "Megacap Pullback · Real",
        summary: "The Megacap Pullback rules with real money: buys 2% dips in the six large caps while the trend is up, sells on the bounce.",
        positionPct: 45,
        maxOpenPositions: 2,
        notes: [...megacap.notes, "Real money: swaps on Uniswap V3 from its own wallet, at most two positions at a time."],
      },
      policy: Policy.parse({ maxLeverage: 1, maxLeverageCrypto: 1, maxPositionPct: 45, maxOpenPositions: 2, dailyLossPct: 10, allowShort: false, allowedSymbols: megacap.symbols }),
    },
  ];
}

if (cmd === "create") {
  const allowed = new Set(markets.filter((m) => m.token).map((m) => m.symbol));
  for (const p of plans()) {
    const exists = live().find((a) => a.liveIndex === p.index);
    const wallet = trader.addressOf(p.index);
    if (exists) {
      console.log(`${p.name}: exists (${exists.id}), wallet ${wallet}`);
      continue;
    }
    const errors = checkBounds(p.strategy, allowed);
    if (errors.length) throw new Error(`${p.name}: ${errors.join("; ")}`);
    if (!YES) {
      console.log(`would create ${p.name} on ${p.strategy.symbols.join(", ")}, wallet ${wallet}`);
      continue;
    }
    const t = now();
    const a = createAgent(db, { name: p.name, prompt: null, strategy: p.strategy, policy: p.policy, owner: null, liveIndex: p.index }, t);
    addReceipt(db, a.id, epochOf(t, config.EPOCH_SEC), "agent", {
      agentId: a.id, at: t, owner: null, strategyHash: a.strategyHash, strategy: p.strategy, promptHash: null, policy: p.policy, brain: null,
      startEquity: 0, money: "real", wallet, venue: "uniswap-v3",
    }, t);
    console.log(`created ${p.name} (${a.id}), wallet ${wallet}; paused until funded`);
  }
  if (!YES) console.log("Preview only. Add --yes to create.");
} else if (cmd === "status") {
  for (const a of live()) {
    const b = await trader.balances(a);
    const acc = getAccount(db, a.id);
    console.log(`${a.name} (${a.id}) ${a.status}`);
    console.log(`  wallet ${b.wallet}: ${b.eth} ETH, ${b.usdg} USDG, ${Object.entries(b.tokens).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${v} ${k}`).join(", ") || "no tokens"}`);
    console.log(`  account: cash ${acc.account.cash.toFixed(4)}, ${acc.account.positions.length} position(s), equity ${acc.equity.toFixed(4)}, started at ${acc.startEquity.toFixed(4)}`);
  }
} else if (cmd === "fund") {
  const a = arg ? getAgent(db, arg) : null;
  if (!a || a.liveIndex === null) throw new Error("fund <agent id> of a real-money agent");
  const txArg = process.argv.indexOf("--tx");
  const r = await trader.fundFromEth(a, now, { dryRun: !YES, ...(txArg > 0 ? { tx: process.argv[txArg + 1] } : {}) });
  console.log(r.plan);
  if (!r.done) console.log("Preview only. Add --yes to wrap, swap and start the agent.");
  else {
    setStatus(db, a.id, "active");
    console.log(`funded: ${r.done.added.toFixed(4)} USDG added (tx ${r.done.tx}); ${a.name} is active`);
  }
} else if (cmd === "stop") {
  const a = arg ? getAgent(db, arg) : null;
  if (!a || a.liveIndex === null) throw new Error("stop <agent id> of a real-money agent");
  setStatus(db, a.id, "paused");
  console.log(`${a.name} paused`);
} else {
  console.error("commands: create [--yes] | status | fund <id> [--yes] | stop <id>");
  process.exit(2);
}
