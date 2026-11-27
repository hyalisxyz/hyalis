import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useData } from "../lib/useData";
import { SiteFooter, SiteHeader } from "../components/Site";
import "./landing.css";
import "./docs.css";

const EXPLORER = "https://robinhoodchain.blockscout.com/address/";
const RECEIPT_REGISTRY = "0x8c4730f9fed980132eb6a8a681ceb558870de41a";
const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const SECTIONS = [
  { id: "start", t: "Get started" },
  { id: "write", t: "Writing a strategy" },
  { id: "backtest", t: "Backtests" },
  { id: "markets", t: "Markets and hours" },
  { id: "safety", t: "Safety limits" },
  { id: "receipts", t: "Receipts and proof" },
  { id: "passport", t: "Agent Passport" },
  { id: "journal", t: "Lessons journal" },
  { id: "tiers", t: "Tiers and the token" },
  { id: "api", t: "Public API" },
  { id: "faq", t: "Questions" },
];

function Addr({ a }: { a: string }) {
  return <a className="dc-addr" href={EXPLORER + a} target="_blank" rel="noreferrer">{a}</a>;
}

function Sec({ id, t, children }: { id: string; t: string; children: ReactNode }) {
  return (
    <section id={id} className="dc-sec" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{t}</h2>
      {children}
    </section>
  );
}

/** Highlights the section being read in the contents list. */
function useActive(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (seen[0]) setActive(seen[0].target.id);
      },
      { rootMargin: "-90px 0px -65% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);
  return active;
}

export default function Docs() {
  const stats = useData(api.stats, [], 60_000);
  const active = useActive(SECTIONS.map((s) => s.id));
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  useEffect(() => {
    document.title = "Docs · Hyalis";
    return () => void (document.title = "Hyalis · AI agents that show their receipts");
  }, []);

  return (
    <div className="tp dc">
      <SiteHeader />
      <main>
        <section className="dc-hero">
          <div className="tp-wrap">
            <h1 className="tp-h2">Docs</h1>
            <p className="tp-sub">How agents are built, what they are allowed to do, and how to check every decision they make. Plain words first, details after.</p>
            <div className="tp-cta">
              <a className="tp-btn paper" href="#start">Start in five minutes</a>
              <a className="tp-btn line" href="#api">Jump to the API</a>
            </div>
          </div>
        </section>

        <div className="tp-paper dc-body">
          <div className="tp-wrap dc-grid">
            <nav className="dc-toc" aria-label="On this page">
              <p>On this page</p>
              <ol>
                {SECTIONS.map((s) => (
                  <li key={s.id}><a href={`#${s.id}`} aria-current={active === s.id ? "location" : undefined}>{s.t}</a></li>
                ))}
              </ol>
              <Link className="tp-btn field dc-toc-cta" to="/app/new">Build an agent</Link>
            </nav>

            <article className="dc-text">
              <Sec id="start" t="Get started">
                <ol className="dc-steps">
                  <li><b>Connect a wallet.</b> Any browser wallet works, MetaMask and Rabby included. Connecting shows your tier; it costs nothing.</li>
                  <li><b>Sign in.</b> Your wallet signs a short message. No gas, no transaction. The session lasts seven days in this browser.</li>
                  <li><b>Describe your strategy.</b> One or two sentences about what to buy or short, when, and when to get out.</li>
                  <li><b>Review before it runs.</b> You see the exact rules the AI wrote, anything it changed to fit the limits, and a backtest next to just holding.</li>
                  <li><b>Create the agent.</b> It starts on the next hourly check with $10,000 of paper money. Pause or resume it any time.</li>
                </ol>
                <p className="dc-note">Agents you build trade on paper for now: real prices, $10,000 of virtual money. The house agents stamped Real money trade real tokens on Uniswap from their own wallets. The free tier runs one agent.</p>
                <p><Link className="dc-link" to="/app/new">Build your first agent</Link></p>
              </Sec>

              <Sec id="write" t="Writing a strategy">
                <p>Write it the way you would explain it to a friend. The AI turns your words into rules made of these building blocks, and it never places orders itself.</p>
                <table className="dc-table">
                  <thead><tr><th>You can say</th><th>It becomes</th></tr></thead>
                  <tbody>
                    <tr><td>"when it drops 5% in a day"</td><td>Change over a window of hours</td></tr>
                    <tr><td>"10% below its weekly high"</td><td>Distance below the recent high</td></tr>
                    <tr><td>"above its 48-hour average"</td><td>Price against a moving average</td></tr>
                    <tr><td>"when the fast average crosses the slow one"</td><td>Moving average cross</td></tr>
                    <tr><td>"RSI under 30"</td><td>Relative strength over a window</td></tr>
                    <tr><td>"only when the crowd on X is bullish"</td><td>Mood of the last 24 hours of posts on X, from -1 to 1, read every 6 hours and sealed with links to the posts (Holder tier and up)</td></tr>
                    <tr><td>"stop at 4%, take profit at 8%, sell after 3 days"</td><td>Stop loss, take profit, maximum hold</td></tr>
                    <tr><td>"short", "2x"</td><td>Side and leverage (up to 3x)</td></tr>
                  </tbody>
                </table>
                <p>Good sentences name the markets, the entry, the exit and a stop. For example:</p>
                <blockquote>Buy Nvidia, AMD and Micron when they are 3% below the 24-hour average and RSI is under 40. Sell back above the average, stop at 4%.</blockquote>
                <p>Every agent has a stop loss between 0.5% and 50%. If your words ask for something outside the limits, the rules show what was changed and why. Your written words stay private; only the rules are public.</p>
              </Sec>

              <Sec id="backtest" t="Backtests">
                <p>Before an agent runs, its rules are replayed over up to 30 days of recorded prices, one market hour at a time, with the same code the live agent uses. You get the return, the buy-and-hold return of the same markets, the deepest drawdown, the number of trades, the win rate, fees, and why any orders were blocked.</p>
                <p className="dc-note">Decisions are hourly, so a stop can fill past its level when a price jumps within the hour. The backtest lists this and its other caveats. Past results do not promise future ones.</p>
                              <p>Every backtest also reports how steady the gains were, not only how big: <b>Sharpe</b> and <b>Sortino</b> (return per unit of ups and downs), <b>Calmar</b> (return over the deepest fall), <b>profit factor</b> (won over lost), and how likely the edge is real rather than luck (<b>probabilistic Sharpe</b>). The same run is cut in two: the first 70% of the hours and the last 30%.</p>
                <p>With <b>Try 3–4 versions</b>, the AI writes a few versions of your strategy that change only what you left open. All are tested; one is picked on the first 70% only, then checked on the last 30%, which the pick never saw. The chance its edge is more than luck is then lowered for having tried several (<b>deflated Sharpe</b>), so trying more versions cannot make a lucky one look skilled.</p>
              </Sec>

              <Sec id="markets" t="Markets and hours">
                <table className="dc-table">
                  <thead><tr><th>Group</th><th>Markets</th><th>Price</th><th>Hours</th></tr></thead>
                  <tbody>
                    <tr><td>Verified</td><td>35 tokenized stocks and ETFs, plus BTC, ETH, LINK and ENA</td><td>Chainlink on Robinhood Chain, checkable on chain</td><td>Stocks 24 hours on weekdays, crypto 24/7</td></tr>
                    <tr><td>Data feed</td><td>28 more cryptocurrencies</td><td>CoinGecko, recorded on each receipt</td><td>24/7</td></tr>
                  </tbody>
                </table>
                <p>Stock prices update from Sunday 20:00 to Friday 20:00 New York time, across the pre-market, regular, after-hours and overnight sessions. Market holidays and early closes follow the exchange calendar. While a market is closed, agents make no decisions in it.</p>
                <p><Link className="dc-link" to="/app/markets">See every market and its latest price</Link></p>
              </Sec>

              <Sec id="safety" t="Safety limits">
                <p>Two checks stand between a rule firing and a trade.</p>
                <h3>The price check</h3>
                <p>No trade happens on a halted market, or on a price that is missing, stale, from the future, or more than 1.5% (150 bps) away from a second source. When in doubt, the agent sits out.</p>
                <h3>Your limits</h3>
                <table className="dc-table">
                  <thead><tr><th>Limit</th><th>Default</th></tr></thead>
                  <tbody>
                    <tr><td>Leverage on stocks</td><td>2x (platform cap 3x)</td></tr>
                    <tr><td>Leverage on crypto</td><td>1.5x (platform cap 3x)</td></tr>
                    <tr><td>Size of one position</td><td>20% of equity</td></tr>
                    <tr><td>Open positions at once</td><td>5</td></tr>
                    <tr><td>Daily loss stop</td><td>No new positions after losing 5% in a UTC day</td></tr>
                    <tr><td>Re-entry pause</td><td>6 hours after a position in a symbol closes</td></tr>
                  </tbody>
                </table>
                <p>Positions use isolated margin with trading fees. Above 1x, or short, a position is a perpetual; it is liquidated if it loses 90% of its margin.</p>
              </Sec>

              <Sec id="receipts" t="Receipts and proof">
                <p>Every decision, fill and hourly snapshot is written as a receipt: the rule that fired, the exact Chainlink round the price came from, the price check, the fill and the result.</p>
                <ol className="dc-steps">
                  <li>When an hour ends, its receipts are hashed into one Merkle root, linked to the hour before.</li>
                  <li>The root is published to the receipt registry on Robinhood Chain, <Addr a={RECEIPT_REGISTRY} />. The contract only accepts new hours in order, from one publisher, and has no owner, upgrade or pause.</li>
                  <li>Anyone can prove a receipt belongs to that root. Change one number in the past and the proof fails.</li>
                </ol>
                <p>To check one yourself, open <b>Proofs</b> in the app, type the receipt number and press <b>Check receipt</b>. Your browser reads Robinhood Chain directly, not our server. To keep your own copy of an hour, download its bundle: <code>GET /v1/epochs/&lt;hour&gt;/bundle.json</code> has every receipt with the root and the anchor.</p>
                <p>{stats.data ? <>Right now: {stats.data.epochs.anchored.toLocaleString("en-US")} hours sealed on chain.</> : null} <Link className="dc-link" to="/app/proofs">Browse the proofs</Link></p>
              </Sec>

              <Sec id="passport" t="Agent Passport">
                <p>An agent can have a public identity in the ERC-8004 registry on Robinhood Chain, <Addr a={IDENTITY_REGISTRY} />, shared by thousands of agents across projects. The identity is a token you own, pointing to the agent's registration file: its name, image, rules summary, record and links to its receipts. Your written prompt is never in it.</p>
                <p>Register from the agent's page with one transaction. The link is checked on chain, sealed as a receipt, and re-checked every few hours; a token that is sold or repointed stops counting as verified.</p>
              </Sec>

              <Sec id="journal" t="Lessons journal">
                <p>Once an agent has closed at least three trades that share a pattern, its journal turns them into lessons: stops hit often, exits that came too late, symbols or sessions that keep losing, fees eating the gains. No AI writes the lessons, and each one names the receipts behind it.</p>
                <p>Press <b>Build a smarter version</b> on the agent's page to start a new agent with those lessons in mind. Your own words still win, and the new agent records which lessons it was built from.</p>
              </Sec>

              <Sec id="tiers" t="Tiers and the token">
                <table className="dc-table">
                  <thead><tr><th>Tier</th><th>Tokens held</th><th>Agents at once</th><th>AI builds a day</th></tr></thead>
                  <tbody>
                    <tr><td>Free</td><td>0</td><td>1</td><td>10</td></tr>
                    <tr><td>Holder</td><td>1,000,000</td><td>3</td><td>50</td></tr>
                    <tr><td>Whale</td><td>5,000,000</td><td>10</td><td>50</td></tr>
                  </tbody>
                </table>
                <p>The token launches on a Pons bonding curve; until then everyone is on the free tier. Tiers count whole tokens, not their price. You can also burn 500,000 tokens for one extra agent slot for 30 days. If you sell below your tier, your newest agents pause until slots return. Agents are never deleted.</p>
              </Sec>

              <Sec id="api" t="Public API">
                <p>Everything public is open to read, no key needed. Base URL: <code>{origin}</code></p>
                <table className="dc-table dc-api">
                  <thead><tr><th>Request</th><th>Returns</th></tr></thead>
                  <tbody>
                    <tr><td><code>GET /v1/markets</code></td><td>Every market with its group, source, hours and latest price</td></tr>
                    <tr><td><code>GET /v1/leaderboard</code></td><td>Agents ranked by return</td></tr>
                    <tr><td><code>GET /v1/agents/:id</code></td><td>An agent's rules, limits and account</td></tr>
                    <tr><td><code>GET /v1/agents/:id/receipts</code></td><td>Its receipts</td></tr>
                    <tr><td><code>GET /v1/receipts/:id</code></td><td>One receipt with its Merkle proof and anchor</td></tr>
                    <tr><td><code>GET /v1/epochs</code></td><td>Sealed hours and their roots</td></tr>
                    <tr><td><code>GET /v1/epochs/:hour/bundle.json</code></td><td>All receipts of an hour, ready to check</td></tr>
                    <tr><td><code>GET /v1/agents/:id/journal</code></td><td>The agent's lessons</td></tr>
                    <tr><td><code>GET /v1/agents/:id/registration.json</code></td><td>Its ERC-8004 registration file</td></tr>
                    <tr><td><code>GET /v1/wallets/:address</code></td><td>A wallet's tier, slots and usage</td></tr>
                    <tr><td><code>POST /v1/backtest</code></td><td>Run rules over stored prices, no AI involved</td></tr>
                  </tbody>
                </table>
                <p>Creating and managing agents needs a signed-in session (<code>POST /v1/auth/nonce</code>, then <code>/v1/auth/verify</code>). Requests that write are rate limited per client.</p>
              </Sec>

              <Sec id="faq" t="Questions">
                <dl className="dc-faq">
                  <dt>Is this real money?</dt>
                  <dd>For the house agents stamped Real money, yes: each swaps real tokens on Uniswap from its own wallet, and every swap is on chain with its transaction. Agents you build trade on paper at real prices for now, so their record is just as honest, but no funds move.</dd>
                  <dt>Can you change an agent's past results?</dt>
                  <dd>No. Once an hour is sealed on chain, changing any receipt in it would break its proof, and anyone can check.</dd>
                  <dt>Who can see my strategy?</dt>
                  <dd>Your written words stay private to your wallet. The rules they became are public, so others can trust the record.</dd>
                  <dt>Does it cost anything?</dt>
                  <dd>Building and running agents is free while trading is on paper. Signing in costs no gas; registering a Passport is one small transaction.</dd>
                  <dt>Is the code open?</dt>
                  <dd>Yes. The source is on <a className="dc-link" href="https://github.com/hyalisxyz/hyalis" target="_blank" rel="noreferrer">GitHub</a>: the vault and receipt contracts under the MIT license, the rest under the Business Source License 1.1. Anyone can read it and check a receipt with it.</dd>
                  <dt>Which wallets work?</dt>
                  <dd>Any browser wallet. Sign-in happens on Robinhood Chain, smart-contract wallets included. Real-money runs on crypto without a token on Robinhood Chain (BTC, ARB, LINK, UNI, AAVE) use Arbitrum One, so you need a little ETH there for the one signature.</dd>
                </dl>
              </Sec>
            </article>
          </div>
        </div>
      </main>
      <SiteFooter lastAnchor={stats.data?.lastAnchor} />
    </div>
  );
}
