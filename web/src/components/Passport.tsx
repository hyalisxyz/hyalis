import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { parseAbi, type Hex } from "viem";
import { api, ApiError, type Agent, type IdentityInfo, type Journal } from "../lib/api";
import { publicClient, robinhoodChain, switchToRobinhood, walletClient } from "../lib/chain";
import { useSession } from "../lib/session";
import { useData } from "../lib/useData";
import { date, money, pct, short } from "../lib/format";
import { StatusBadge, TierBadge } from "./bits";

/**
 * The agent's passport: the head of its page, built like an identity document. Its photo is the
 * avatar, its number is its ERC-8004 identity on Robinhood Chain, and the line at the bottom is a
 * machine-readable zone made from its own data.
 *
 * The owner registers the identity from their own wallet (they own the token, gas is a fraction
 * of a cent). The server links it only after checking owner and URI on chain. A registration
 * sent but not yet linked is remembered in this browser and finished on the next visit.
 */

const REGISTER_ABI = parseAbi(["function register(string agentURI) returns (uint256 agentId)"]);
const pendingKey = (agentId: string) => `au.identity.${agentId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readPending(agentId: string): Hex | null {
  try {
    const v = localStorage.getItem(pendingKey(agentId));
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
  } catch {
    return null;
  }
}
function writePending(agentId: string, tx: Hex | null) {
  try {
    if (tx) localStorage.setItem(pendingKey(agentId), tx);
    else localStorage.removeItem(pendingKey(agentId));
  } catch {
    /* storage unavailable: linking still works in this visit */
  }
}

/** Asks the server to link; retries while its RPC has not seen the transaction yet. */
async function linkWithRetry(agentId: string, txHash: Hex) {
  for (let i = 0; ; i++) {
    try {
      return await api.linkIdentity(agentId, { txHash });
    } catch (e) {
      const retry = e instanceof ApiError && (e.status === 404 || e.status === 503) && i < 9;
      if (!retry) throw e;
      await sleep(3000);
    }
  }
}

const STATUS_TEXT: Record<string, string> = {
  "owner-changed": "This identity token was moved to another wallet, so it no longer speaks for this agent.",
  "uri-changed": "This identity token now points somewhere else, so it no longer speaks for this agent.",
  missing: "This identity token can no longer be found in the registry.",
};

/** Registering and linking the identity, from the owner's wallet. */
function useRegister(agent: Agent, onLinked: () => void) {
  const info = useData(() => api.identityInfo(agent.id), [agent.id]);
  const { address, chainId } = useSession();
  const [step, setStep] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const resumed = useRef(false);

  const finish = useCallback(
    async (tx: Hex) => {
      setStep("Linking it to this agent…");
      try {
        const r = await linkWithRetry(agent.id, tx);
        writePending(agent.id, null);
        setMsg({ kind: "ok", text: `Done. This agent is now ERC-8004 #${r.identity.agentId} on Robinhood Chain, and the token is in your wallet.` });
        info.reload();
        onLinked();
      } catch (e) {
        const keep = e instanceof ApiError && (e.status === 404 || e.status === 503);
        if (!keep) writePending(agent.id, null);
        setMsg({ kind: "err", text: keep ? "The registration is on chain, but the link is not confirmed yet. Reload this page in a minute to finish it." : (e as Error).message });
      } finally {
        setStep(null);
      }
    },
    [agent.id, info, onLinked],
  );

  useEffect(() => {
    if (resumed.current || agent.identity?.verified) return;
    const tx = readPending(agent.id);
    if (!tx) return;
    resumed.current = true;
    void finish(tx);
  }, [agent.id, agent.identity?.verified, finish]);

  const register = async () => {
    const i: IdentityInfo | null = info.data;
    setMsg(null);
    if (!i) return;
    if (!address) return setMsg({ kind: "err", text: "Connect the wallet that owns this agent first." });
    if (!i.expectedOwner || address.toLowerCase() !== i.expectedOwner.toLowerCase())
      return setMsg({ kind: "err", text: `Switch to the wallet that owns this agent (${short(i.expectedOwner, 6, 4)}).` });
    try {
      if (chainId !== robinhoodChain.id) {
        setStep("Switching to Robinhood Chain…");
        await switchToRobinhood();
      }
      setStep("Checking the registration…");
      try {
        await publicClient.simulateContract({ address: i.registry, abi: REGISTER_ABI, functionName: "register", args: [i.agentURI], account: address as `0x${string}` });
      } catch (e) {
        throw new Error(
          "The registry would refuse this transaction from your wallet. Smart-contract wallets that cannot receive NFTs cannot hold an identity; " +
            "use a regular wallet account. (" + ((e as Error).message.split("\n")[0] ?? "") + ")",
        );
      }
      setStep("Confirm in your wallet…");
      const tx = await walletClient(address as `0x${string}`).writeContract({ address: i.registry, abi: REGISTER_ABI, functionName: "register", args: [i.agentURI] });
      writePending(agent.id, tx);
      setStep("Waiting for Robinhood Chain…");
      const r = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 180_000 });
      if (r.status !== "success") {
        writePending(agent.id, null);
        throw new Error("The registration transaction failed on chain. Nothing was linked.");
      }
      await finish(tx);
    } catch (e) {
      setStep(null);
      const text = (e as Error).message.split("\n")[0] ?? "Something went wrong.";
      setMsg({ kind: "err", text: /reject|denied|cancel/i.test(text) ? "Cancelled in the wallet. Nothing was sent." : text });
    }
  };
  return { ready: Boolean(info.data), step, msg, register };
}

/** A passport's machine-readable zone, from the agent's own data. Decorative; hidden from screen readers. */
function mrz(agent: Agent) {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "<");
  const pad = (s: string) => (s + "<".repeat(44)).slice(0, 44);
  const d = new Date(agent.createdAt * 1000);
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const id = agent.identity?.verified ? `ERC8004<${agent.identity.agentId}` : "UNREGISTERED";
  return [pad(`HY<AGENT<<${clean(agent.name)}`), pad(`${id}<4663<${agent.strategyHash.slice(2, 12).toUpperCase()}<${agent.strategy.side === "short" ? "S" : "L"}<${ymd}`)];
}

export function AgentPassport({
  agent,
  account,
  journal,
  mine,
  onLinked,
  actions,
}: {
  agent: Agent;
  account: { equity: number; startEquity: number; returnPct: number; openPositions: number };
  journal: Journal | null;
  mine: boolean;
  onLinked: () => void;
  actions: ReactNode;
}) {
  const reg = useRegister(agent, onLinked);
  const card = useRef<HTMLElement>(null);
  const identity = agent.identity;
  const [line1, line2] = mrz(agent);

  // The light on the foil follows the pointer.
  const follow = (e: React.PointerEvent) => {
    const el = card.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
  };

  return (
    <section className="passport" ref={card} onPointerMove={follow} aria-label={`${agent.name}, agent passport`}>
      <div className="pp-grid">
        <div className="pp-photo">
          <img src={agent.avatar ?? `/v1/agents/${agent.id}/image.svg`} alt="" width={168} height={168} />
          <span className={`pp-stamp ${identity?.verified ? "on" : ""}`}>{identity?.verified ? `ERC-8004 #${identity.agentId}` : "No passport yet"}</span>
        </div>

        <div className="pp-main">
          <div className="pp-badges">
            <StatusBadge status={agent.status} reason={agent.pauseReason} money={agent.money} starting={Boolean(agent.vault && !agent.endedAt && account.startEquity === 0)} />
            <TierBadge tier={agent.markets} />
          </div>
          <h1>{agent.name}</h1>
          <p className="pp-summary">{agent.strategy.summary}</p>
          <dl className="pp-facts">
            <div><dt>Owner</dt><dd>{agent.house ? "House agent" : <span className="mono">{short(agent.owner, 6, 4)}</span>}</dd></div>
            <div><dt>Trades</dt><dd>{agent.strategy.symbols.join(", ")}, {agent.strategy.side}</dd></div>
            <div><dt>Running since</dt><dd>{date(agent.createdAt)}</dd></div>
            <div><dt>Rules sealed as</dt><dd className="mono">{short(agent.strategyHash, 8, 6)}</dd></div>
          </dl>
        </div>

        <div className="pp-record">
          <div className={`pp-return ${account.returnPct > 0 ? "gain" : account.returnPct < 0 ? "loss" : ""}`}>{pct(account.returnPct)}</div>
          <div className="pp-record-line">{money(account.equity, 2)} from {money(account.startEquity, account.startEquity < 1000 ? 2 : 0)}</div>
          <div className="pp-record-line faint">
            {journal ? `${journal.closedTrades} closed trades, ${journal.wins} won` : agent.money === "real" ? "Real money" : "Paper trading"}
            {account.openPositions ? `, ${account.openPositions} open now` : ""}
          </div>
        </div>
      </div>

      <div className="pp-identity">
        <div className="pp-identity-text">
          {identity?.verified ? (
            <>
              <strong>Its identity lives on Robinhood Chain.</strong>{" "}
              <span>Any app that reads ERC-8004 can find this agent and check that its record is the one you see here.</span>{" "}
              <a href={identity.explorer} target="_blank" rel="noreferrer">See token #{identity.agentId}</a>{" "}
              <a href={`/v1/agents/${agent.id}/registration.json`} target="_blank" rel="noreferrer">Registration file</a>
            </>
          ) : identity ? (
            <span className="loss">{STATUS_TEXT[identity.status] ?? "This identity no longer checks out."}</span>
          ) : mine ? (
            <>
              <strong>Give it a passport.</strong>{" "}
              <span>Register this agent in ERC-8004, the open registry for AI agents on Robinhood Chain. The token goes to your wallet, and anyone can check it is this agent.</span>
            </>
          ) : (
            <span>{agent.house ? "This house agent has no passport yet." : "Its owner has not registered a passport for this agent yet."}</span>
          )}
          <span role="status" className="sr-only">{reg.step ?? ""}</span>
          {reg.msg ? <div className={`notice ${reg.msg.kind}`} role={reg.msg.kind === "err" ? "alert" : "status"} style={{ marginTop: 12 }}>{reg.msg.text}</div> : null}
        </div>
        <div className="pp-actions">
          {mine && !identity?.verified && reg.ready ? (
            <button className="btn btn-primary btn-sm" onClick={reg.register} disabled={reg.step !== null} title="One transaction from your wallet; gas is a fraction of a cent">
              {reg.step ?? "Register on ERC-8004"}
            </button>
          ) : null}
          {actions}
        </div>
      </div>

      <div className="pp-mrz" aria-hidden="true">
        <span>{line1}</span>
        <span>{line2}</span>
      </div>
    </section>
  );
}
