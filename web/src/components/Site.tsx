import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { txUrl } from "../lib/api";
import { ago, short } from "../lib/format";
import { Logo } from "./Logo";

/**
 * Header and footer shared by the public pages (landing, docs). The header is a strip of paper
 * floating over the page, perforated like a ticket between the name and the menu. On the landing
 * page the section links scroll; elsewhere they go to the landing page's sections. Narrow screens
 * get a Menu button.
 */
export function SiteHeader({ onHome = false }: { onHome?: boolean }) {
  const [solid, setSolid] = useState(!onHome);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!onHome) return;
    const on = () => setSolid(window.scrollY > 24);
    const first = requestAnimationFrame(on);
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      cancelAnimationFrame(first);
      window.removeEventListener("scroll", on);
    };
  }, [onHome]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  const at = (id: string) => (onHome ? `#${id}` : `/#${id}`);
  const links = [
    { href: at("how"), t: "How it works", wide: true },
    { href: at("features"), t: "Features", wide: true },
    { href: at("agents"), t: "Live agents", wide: false },
  ];
  const close = () => setOpen(false);
  return (
    <header className={`tp-top${solid ? " solid" : ""}${open ? " open" : ""}`}>
      <div className="tp-bar">
        <Link to="/" className="tp-brand" aria-label="Hyalis home"><Logo size={52} /><span>Hyalis</span></Link>
        <span className="tp-perf" aria-hidden />
        <nav className="tp-nav" aria-label="Main">
          {links.map((l) => <a key={l.t} href={l.href} className={l.wide ? "wide" : undefined}>{l.t}</a>)}
          <Link to="/app/proofs">Proofs</Link>
          <Link to="/docs">Docs</Link>
        </nav>
        <div className="tp-right">
          <Link to="/app" className="tp-open">Open app</Link>
          <Link to="/app/new" className="tp-build">Build an agent</Link>
          <button className="tp-menu" aria-expanded={open} aria-controls="tp-sheet" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>
      {open ? (
        <nav id="tp-sheet" className="tp-sheet" aria-label="Menu">
          {links.map((l) => <a key={l.t} href={l.href} onClick={close}>{l.t}</a>)}
          <Link to="/app/proofs" onClick={close}>Proofs</Link>
          <Link to="/docs" onClick={close}>Docs</Link>
          <Link to="/app" onClick={close}>Open app</Link>
        </nav>
      ) : null}
    </header>
  );
}

export function SiteFooter({ lastAnchor, note }: { lastAnchor?: { tx: string; closedAt: number } | null; note?: string }) {
  return (
    <footer className="tp-foot">
      <div className="tp-wrap tp-foot-in">
        <span className="tp-brand"><Logo size={52} /><span>Hyalis</span></span>
        <nav aria-label="Footer">
          <Link to="/app">Dashboard</Link>
          <Link to="/app/markets">Markets</Link>
          <Link to="/app/proofs">Proofs</Link>
          <Link to="/docs">Docs</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/risk">Risk</Link>
          <a href="https://x.com/hyalisAI" target="_blank" rel="noreferrer me">X (Twitter)</a>
          <a href="https://github.com/hyalisxyz/hyalis" target="_blank" rel="noreferrer me">GitHub</a>
        </nav>
        <span>
          {lastAnchor ? <>Latest root <a href={txUrl(lastAnchor.tx)} target="_blank" rel="noreferrer">{short(lastAnchor.tx, 8, 6)}</a>, sealed {ago(lastAnchor.closedAt)}</> : null}
        </span>
      </div>
      <p className="tp-wrap tp-foot-fine tp-foot-ca">
        $HYALIS{" "}
        <a href="https://robinhoodchain.blockscout.com/token/0xcb5b905d404ef2021ce1583efb28f992467c5b47" target="_blank" rel="noreferrer"><code>0xcb5b905d404ef2021ce1583efb28f992467c5b47</code></a>{" "}
        · Robinhood Chain · any other address is not ours
      </p>
      {/* Our own sources, linked from our own domain: the code, its history, the docs, the security review and every contract we deployed. */}
      <p className="tp-wrap tp-foot-fine tp-foot-src">
        Source <a href="https://github.com/hyalisxyz/hyalis" target="_blank" rel="noreferrer">GitHub</a>
        {" · "}<a href="https://github.com/hyalisxyz/hyalis/commits/main" target="_blank" rel="noreferrer">Changelog</a>
        {" · "}<a href="https://github.com/hyalisxyz/hyalis/releases" target="_blank" rel="noreferrer">Releases</a>
        {" · "}<a href="/docs">Docs</a>
        {" · "}<a href="https://github.com/hyalisxyz/hyalis/blob/main/AUDIT.md" target="_blank" rel="noreferrer">Security review</a>
        {" · "}Contracts:{" "}
        <a href="https://robinhoodchain.blockscout.com/address/0xeafa7d3b763cfa8d4509907263072722910631cf" target="_blank" rel="noreferrer">AgentVaultFactory</a>
        {" · "}<a href="https://robinhoodchain.blockscout.com/address/0x88781501b8ca8a04c4ce287ccc4e20fb8996aa45" target="_blank" rel="noreferrer">UniswapV3Adapter</a>
        {" · "}<a href="https://robinhoodchain.blockscout.com/address/0x8c4730f9fed980132eb6a8a681ceb558870de41a" target="_blank" rel="noreferrer">ReceiptRegistry</a>
        {" · "}<a href="https://arbiscan.io/address/0x8c4730f9fed980132eb6a8a681ceb558870de41a" target="_blank" rel="noreferrer">Arbitrum factory</a>
        {" · "}<a href="https://arbiscan.io/address/0x242be6fe51aaa67a9bac7592b755def337a416fb" target="_blank" rel="noreferrer">Arbitrum adapter</a>
      </p>
      <p className="tp-wrap tp-foot-fine">Receipts sealed on Robinhood Chain. Agents stamped Real money trade real tokens on Robinhood Chain or Arbitrum One, from their own wallets or your own vault; the rest trade on paper at real prices. Not financial advice.{note ? ` ${note}` : ""}</p>
    </footer>
  );
}
