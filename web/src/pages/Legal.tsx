import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { SiteFooter, SiteHeader } from "../components/Site";
import "./landing.css";
import "./docs.css";

/**
 * Terms of use, privacy notice and risk disclosure. Written in plain words about what the
 * product actually does; the team reviews them with counsel before the beta widens.
 */

const UPDATED = "November 25, 2026";

function Page({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Hyalis`;
    return () => void (document.title = "Hyalis · AI agents that show their receipts");
  }, [title]);
  return (
    <div className="tp dc">
      <SiteHeader />
      <main>
        <section className="dc-hero">
          <div className="tp-wrap">
            <h1 className="tp-h2">{title}</h1>
            <p className="tp-sub">{lede}</p>
          </div>
        </section>
        <div className="tp-paper dc-body">
          <div className="tp-wrap dc-grid">
            <nav className="dc-toc" aria-label="Legal">
              <p>Legal</p>
              <ol>
                <li><Link to="/terms">Terms of use</Link></li>
                <li><Link to="/privacy">Privacy</Link></li>
                <li><Link to="/risk">Risk disclosure</Link></li>
              </ol>
            </nav>
            <article className="dc-text">
              <p className="dc-note">Last updated {UPDATED}. Hyalis is in beta.</p>
              {children}
            </article>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

const H = ({ children }: { children: ReactNode }) => <h2 className="dc-legal-h">{children}</h2>;

export function Terms() {
  return (
    <Page title="Terms of use" lede="The rules for using Hyalis, in plain words.">
      <H>What Hyalis is</H>
      <p>Hyalis lets you describe a trading strategy in words, turns it into exact rules, runs them as an agent, and seals a receipt for every decision on Robinhood Chain. Agents you build trade on paper by default: real prices, no real money. You may also start an agent on a vault of your own, in which case it trades real tokens.</p>
      <H>Your wallet, your vault, your keys</H>
      <p>Hyalis never holds your private keys. A vault you create is a contract owned by your wallet: only your wallet can withdraw from it, and the agent can only swap the tokens you allowed and send funds back to you. You are responsible for your wallet, its keys, and every transaction you sign.</p>
      <H>No advice, no promises</H>
      <p>Nothing on Hyalis is financial, investment, legal or tax advice. Backtests, paper results and other agents' records describe the past; they do not predict or promise future results. You decide what to run and with how much.</p>
      <H>Where you may use it</H>
      <p>You are responsible for making sure that using Hyalis, holding tokenized stocks and trading them is allowed where you live. Tokenized stocks are issued and governed by their issuers, who may limit who can hold them. Do not use Hyalis where it is not permitted.</p>
      <H>Beta</H>
      <p>Hyalis is in beta. Features, limits (such as the most a vault may hold) and supported markets can change, and services can be paused, for example when a price source fails. Smart contracts and the chain they run on can fail in ways nobody foresaw. Read the <Link to="/risk">risk disclosure</Link> before you use real money.</p>
      <H>Fair use</H>
      <p>Do not abuse the service: no attacks, no automated flooding, no attempts to break other users' agents or to manipulate prices or receipts. We may limit or stop access that does.</p>
      <H>Limits of responsibility</H>
      <p>Hyalis is provided as it is. To the fullest extent the law allows, the team is not liable for trading losses, missed trades, failures of third-party services (price feeds, AI providers, swap venues, the chain) or losses from your own wallet's security.</p>
      <H>Changes</H>
      <p>We may update these terms; the date at the top changes when we do. Continuing to use Hyalis after a change means you accept the new terms.</p>
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy" lede="What Hyalis keeps, what is public on chain, and what is never collected.">
      <H>Public by design</H>
      <p>Receipts are public and permanent: an agent's rules, decisions, fills, hourly equity and the wallet that owns it are sealed and published on Robinhood Chain. Anyone can read and verify them. Do not put personal information in an agent's name.</p>
      <H>Private to you</H>
      <p>The words you write to build an agent stay private to your wallet; only their hash is public, so the record can still be checked. Your sign-in session is kept in your browser; the server keeps only a hash of its token.</p>
      <H>What the server keeps</H>
      <ul>
        <li>Your wallet address, when you connect and sign in.</li>
        <li>Your agents, their rules and records, your vaults' addresses, and the swaps you record on the Trade page (already public on chain).</li>
        <li>How many AI builds you used today, to apply your tier's limit.</li>
        <li>Short-lived server logs for running and securing the service.</li>
      </ul>
      <H>What is not collected</H>
      <p>No names, emails or phone numbers are asked for. No advertising or tracking cookies are used; the site stores only your session and display preferences in your own browser.</p>
      <H>Services that see some data</H>
      <p>To work, Hyalis sends: your strategy words to an AI model provider to turn them into rules; public market symbols to price and data providers; signed transactions to Robinhood Chain through RPC providers. These providers process that data under their own terms. Hyalis does not sell data.</p>
      <H>Your choices</H>
      <p>You can disconnect your wallet at any time and pause or stop your agents. Records already sealed on chain cannot be deleted by anyone, including us; that permanence is what makes them trustworthy.</p>
    </Page>
  );
}

export function Risk() {
  return (
    <Page title="Risk disclosure" lede="Trading with an agent can lose money. Here is how, before you put any in.">
      <H>You can lose what you put in</H>
      <p>Prices of tokenized stocks and crypto move fast and can fall sharply. An agent follows its rules, including when they are wrong for the market. Stops limit losses but do not guarantee a price: in a fast move, a sale can fill below the stop.</p>
      <H>Past results are not a forecast</H>
      <p>Backtests replay rules over recent prices, with simplifications listed under every backtest. Paper agents trade without real costs of impact. Both can look better than live trading will.</p>
      <H>Liquidity, fees and slippage</H>
      <p>Swaps run on Uniswap pools on Robinhood Chain. Some pools are thin: a trade can move the price, and the result can differ from the quote within the slippage you allow. Each vault refuses fills worse than 2% below the Chainlink price, which means a trade can also fail and be retried later.</p>
      <H>Prices and markets</H>
      <p>Agents rely on Chainlink feeds and a second source. If a price is stale, halted or disputed, the agent waits; that protects you but can mean missed trades. Stock feeds pause when the stock market is closed, and stock trading stops with them.</p>
      <H>Smart contracts and the chain</H>
      <p>Vaults, the swap router and the token contracts are software. Bugs, upgrades by third parties, or problems with Robinhood Chain itself could cause losses or delays. During the beta each vault holds at most a small amount for this reason.</p>
      <H>The AI can misunderstand you</H>
      <p>The AI turns your words into rules. Always read the rules shown before you start; they, not your words, are what the agent runs.</p>
      <H>Tokenized stocks</H>
      <p>A tokenized stock is a token issued by a third party that tracks a stock's price. Its rights, availability and redemption are set by its issuer, not by Hyalis, and may differ from owning the stock.</p>
    </Page>
  );
}
