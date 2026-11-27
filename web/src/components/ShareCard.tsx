import { useState } from "react";
import type { Agent, Journal } from "../lib/api";
import { money } from "../lib/format";
import { PATHS } from "./Logo";

/**
 * A share card for an agent, drawn in the browser in the Hyalis look: cobalt, the mascot, the
 * agent's avatar, and its record printed on a receipt with the stamp. Every number on it comes from the API, and the card says where to
 * check them. Nothing is uploaded; the PNG is saved by the user.
 */

const W = 1200;
const H = 630;
const DISPLAY = '"Archivo", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const FIELD = "#2533e6";
const PAPER = "#f2f3ee";
const INK = "#17171b";
const FADE = "#64676f";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image ${src} could not be loaded`));
    img.src = src;
  });
}

/** Cuts text to fit a width, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Condensed display type, as on the site (falls back to the normal width where unsupported). */
function display(ctx: CanvasRenderingContext2D, weight: number, px: number, condensed = true) {
  ctx.font = `${weight} ${px}px ${DISPLAY}`;
  if ("fontStretch" in ctx) (ctx as CanvasRenderingContext2D & { fontStretch: string }).fontStretch = condensed ? "extra-condensed" : "normal";
}

/** A paper edge torn into teeth along the bottom of a rectangle. */
function paper(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tooth = 18) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  for (let i = x + w; i > x; i -= tooth) {
    ctx.lineTo(Math.max(x, i - tooth / 2), y + h + tooth / 2);
    ctx.lineTo(Math.max(x, i - tooth), y + h);
  }
  ctx.closePath();
}

export async function drawCard(agent: Agent, account: { equity: number; startEquity: number; returnPct: number }, journal: Journal | null): Promise<Blob> {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Cobalt field, the mascot and the name.
  ctx.fillStyle = FIELD;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(64, 44);
  ctx.scale(3, 3);
  for (const [fill, d] of PATHS) {
    ctx.fillStyle = fill;
    ctx.fill(new Path2D(d));
  }
  ctx.restore();
  ctx.fillStyle = "#ffffff";
  display(ctx, 900, 58);
  ctx.fillText("Hyalis", 150, 100);

  // The agent's avatar in a paper frame, slightly turned like a photo pinned to the record.
  const img = await loadImage(agent.avatar ?? `/v1/agents/${agent.id}/image.svg`).catch(() => null);
  ctx.save();
  ctx.translate(250, 345);
  ctx.rotate(-0.04);
  ctx.fillStyle = "rgba(8, 10, 60, 0.35)";
  ctx.fillRect(-170, -154, 340, 340);
  ctx.fillStyle = PAPER;
  ctx.fillRect(-180, -180, 340, 340);
  if (img) ctx.drawImage(img, -166, -166, 312, 312);
  ctx.restore();

  // The record, printed on a receipt.
  const rx = 500, ry = 52, rw = 640, rh = 500;
  ctx.fillStyle = "rgba(8, 10, 60, 0.35)";
  paper(ctx, rx + 12, ry + 14, rw, rh);
  ctx.fill();
  ctx.fillStyle = PAPER;
  paper(ctx, rx, ry, rw, rh);
  ctx.fill();

  const x = rx + 40, maxW = rw - 80;
  ctx.fillStyle = FADE;
  ctx.font = `400 20px ${MONO}`;
  ctx.fillText(agent.identity?.verified ? `ERC-8004 #${agent.identity.agentId}, Robinhood Chain` : "AI trading agent, Robinhood Chain", x, ry + 54);

  ctx.fillStyle = INK;
  display(ctx, 900, 70);
  ctx.fillText(fit(ctx, agent.name, maxW), x, ry + 128);
  ctx.font = `400 22px ${MONO}`;
  ctx.fillStyle = FADE;
  ctx.fillText(fit(ctx, `${agent.strategy.symbols.join(", ")}, ${agent.strategy.side}`, maxW), x, ry + 166);

  const pct = Number(account.returnPct.toFixed(2));
  ctx.fillStyle = pct < 0 ? "#cf2236" : "#0b8457";
  display(ctx, 900, 150);
  ctx.fillText(`${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`, x - 4, ry + 312);

  ctx.strokeStyle = "rgba(23, 23, 27, 0.35)";
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, ry + 348);
  ctx.lineTo(x + maxW, ry + 348);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = INK;
  ctx.font = `400 22px ${MONO}`;
  const trades = journal ? `${journal.closedTrades} closed trades, ${journal.wins} won` : agent.money === "real" ? "real money" : "paper trading";
  ctx.fillText(fit(ctx, `${money(account.equity, 2)} from ${money(account.startEquity, 2)}`, maxW), x, ry + 392);
  ctx.fillText(fit(ctx, trades, maxW - 190), x, ry + 426);
  ctx.fillStyle = FADE;
  ctx.font = `400 18px ${MONO}`;
  ctx.fillText(fit(ctx, `${location.host}/app/agents/${agent.id.slice(0, 8)}`, maxW - 190), x, ry + 466);

  // The stamp: every decision behind this number is sealed on chain.
  ctx.save();
  ctx.translate(rx + rw - 120, ry + rh - 90);
  ctx.rotate(-0.16);
  ctx.strokeStyle = FIELD;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(-92, -46, 184, 92, 14);
  ctx.stroke();
  ctx.fillStyle = FIELD;
  display(ctx, 900, 50);
  ctx.textAlign = "center";
  ctx.fillText("Sealed", 0, 8);
  ctx.font = `600 15px ${MONO}`;
  ctx.fillText("on Robinhood Chain", 0, 32);
  ctx.restore();

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the card could not be drawn"))), "image/png"));
}

export function ShareCardButton({ agent, account, journal }: { agent: Agent; account: { equity: number; startEquity: number; returnPct: number }; journal: Journal | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const blob = await drawCard(agent, account, journal);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${agent.name.replace(/[^A-Za-z0-9-_]+/g, "-").slice(0, 40) || "agent"}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tweet = `${agent.name}: ${account.returnPct >= 0 ? "+" : ""}${account.returnPct.toFixed(2)}%${agent.money === "real" ? " with real money" : " paper trading"}. Every decision is sealed on Robinhood Chain.`;
  const share = `https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(`${location.origin}/app/agents/${agent.id}`)}`;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button className="btn btn-ghost btn-sm" onClick={save} disabled={busy}>{busy ? "Drawing…" : "Save share card"}</button>
      <a className="btn btn-ghost btn-sm" href={share} target="_blank" rel="noreferrer">Post on X</a>
      {err ? <span className="loss" style={{ fontSize: 13 }}>{err}</span> : null}
    </div>
  );
}
