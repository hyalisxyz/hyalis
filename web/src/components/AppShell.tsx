import { Suspense, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { WalletButton } from "./Wallet";
import { Logo } from "./Logo";
import { api } from "../lib/api";
import { useData } from "../lib/useData";

const I = {
  overview: <path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  markets: <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />,
  proof: <path d="M6 3h12v16l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5zM9 8h6M9 12h4" />,
  wallet: <path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M16 13h2" />,
  mine: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" />,
  trade: <path d="M7 4v16M7 4 3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4" />,
};
const Icon = ({ d }: { d: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

export default function AppShell() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const stats = useData(api.stats, [], 60_000);
  const market = stats.data?.lastTick?.market;

  const find = (e: React.FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (/^\d+$/.test(v)) nav(`/app/proofs?receipt=${v}`);
    else if (/^[0-9a-f-]{36}$/i.test(v)) nav(`/app/agents/${v}`);
    else if (/^0x[0-9a-fA-F]{40}$/.test(v)) nav(`/app/wallet?address=${v}`);
  };

  return (
    <div className="app">
      <aside className="side">
        <Link to="/" className="brand" aria-label="Hyalis home">
          <Logo size={52} className="brand-mark" /> <span>Hyalis</span>
        </Link>
        <NavLink to="/app/new" className={({ isActive }) => `side-cta${isActive ? " on" : ""}`}><Icon d={I.plus} /> Build an agent</NavLink>
        <nav aria-label="App">
          <NavLink end to="/app"><Icon d={I.overview} /> Overview</NavLink>
          <NavLink to="/app/mine"><Icon d={I.mine} /> My agents</NavLink>
          <NavLink to="/app/trade"><Icon d={I.trade} /> Trade</NavLink>
          <NavLink to="/app/markets"><Icon d={I.markets} /> Markets</NavLink>
          <NavLink to="/app/proofs"><Icon d={I.proof} /> Proofs</NavLink>
          <NavLink to="/app/wallet"><Icon d={I.wallet} /> Wallet & tier</NavLink>
        </nav>
        <div className="foot">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`dot ${market && !market.open ? "amber" : ""}`} /> Robinhood Chain 4663
          </div>
          <div className="faint" style={{ marginTop: 4 }}>
            Stocks {market ? (market.open ? `open (${market.session})` : `closed (${market.reason})`) : "…"} · crypto 24/7
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <a className="faint" href="https://x.com/hyalisAI" target="_blank" rel="noreferrer me">X @hyalisAI</a>
            <a className="faint" href="https://github.com/hyalisxyz/hyalis" target="_blank" rel="noreferrer me">GitHub</a>
          </div>
        </div>
      </aside>
      <div className="main">
        <div className="appbar">
          <form className="search" onSubmit={find} role="search">
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Receipt number, agent id or wallet address" aria-label="Find" />
          </form>
          <div className="appbar-right">
            <WalletButton />
          </div>
        </div>
        <Suspense fallback={<div className="page faint" aria-busy="true">Loading…</div>}>
          <Outlet />
        </Suspense>
      </div>
      {/* On phones the pages sit in a bar at the bottom, in reach of a thumb. */}
      <nav className="tabbar" aria-label="App sections">
        <NavLink end to="/app"><Icon d={I.overview} /><span>Overview</span></NavLink>
        <NavLink to="/app/mine"><Icon d={I.mine} /><span>My agents</span></NavLink>
        <NavLink to="/app/trade"><Icon d={I.trade} /><span>Trade</span></NavLink>
        <NavLink to="/app/markets"><Icon d={I.markets} /><span>Markets</span></NavLink>
        <NavLink to="/app/proofs"><Icon d={I.proof} /><span>Proofs</span></NavLink>
        <NavLink to="/app/wallet"><Icon d={I.wallet} /><span>Wallet</span></NavLink>
      </nav>
    </div>
  );
}
