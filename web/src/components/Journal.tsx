import { Link } from "react-router-dom";
import type { Journal, Lesson } from "../lib/api";

/**
 * The agent's journal: lessons computed from its own sealed receipts. Each lesson shows the
 * trades behind it and links to their receipts, so every claim can be checked on chain.
 */

const KIND: Record<Lesson["kind"], string> = { risk: "Risk", weakness: "Weakness", strength: "Strength" };

/** One dot per trade in the lesson: filled for a win, hollow for a loss. */
function TradeStrip({ trades, wins }: { trades: number; wins: number }) {
  const shown = Math.min(trades, 24);
  const won = Math.min(wins, shown);
  return (
    <span className="tradestrip" role="img" aria-label={`${wins} of ${trades} trades won`}>
      {Array.from({ length: shown }, (_, i) => <i key={i} className={i < won ? "won" : ""} />)}
    </span>
  );
}

/** `compact` shows only what each lesson says and its trades, for places where the details live elsewhere. */
export function LessonList({ lessons, compact = false }: { lessons: Lesson[]; compact?: boolean }) {
  return (
    <ol className={`lessons ${compact ? "compact" : ""}`} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {lessons.map((l, i) => {
        const shown = l.evidence.slice(0, 8);
        return (
          <li key={l.id} className="lesson" data-kind={l.kind}>
            <span className="lesson-n" aria-hidden="true">{i + 1}</span>
            <div>
              <div className="lesson-head">
                <h3 className="lesson-title">{l.title}</h3>
                {compact ? <TradeStrip trades={l.stats.trades} wins={l.stats.wins} /> : <span className="lesson-meta">{KIND[l.kind]}, {l.confidence} confidence</span>}
              </div>
            </div>
            {compact ? null : (
              <>
                <p className="lesson-detail">{l.detail}</p>
                <div className="lesson-foot">
                  <TradeStrip trades={l.stats.trades} wins={l.stats.wins} />
                  <span className="lesson-figures">{l.stats.wins} of {l.stats.trades} won</span>
                </div>
              </>
            )}
            {compact ? null : <div className="receipt-chips">
              <span className="lesson-figures">Check the receipts:</span>
              {shown.map((id) => (
                <Link key={id} className="receipt-chip" to={`/app/proofs?receipt=${id}`} aria-label={`Receipt ${id}`}>#{id}</Link>
              ))}
              {l.evidence.length > shown.length ? <span className="lesson-figures">and {l.evidence.length - shown.length} more</span> : null}
            </div>}
          </li>
        );
      })}
    </ol>
  );
}

export function JournalPanel({ journal, agentId }: { journal: Journal | null; agentId: string }) {
  return (
    <section className="panel" aria-labelledby="journal-h">
      <div className="panel-h">
        <div>
          <h2 id="journal-h">What its record teaches</h2>
          <p>Found in its own sealed trades, not written by the AI. Every receipt here can be checked on chain.</p>
        </div>
        {journal?.sealed ? (
          <Link className="badge badge-verified" to={`/app/proofs?receipt=${journal.sealed.receipt}`}>
            {journal.sealed.current ? `Sealed in receipt #${journal.sealed.receipt}` : "New lessons, sealing next"}
          </Link>
        ) : null}
      </div>

      {!journal ? (
        <div className="panel-b faint">Reading its receipts…</div>
      ) : (
        <>
          {journal.lessons.length === 0 ? (
            <div className="empty">
              <b>{journal.closedTrades === 0 ? "No closed trades yet" : "No pattern yet"}</b>
              {journal.closedTrades === 0
                ? "When it has closed at least three trades that share a pattern, its first lesson appears here, sealed like everything else."
                : `${journal.closedTrades} closed trade(s) so far. A lesson needs at least three trades that share a pattern.`}
            </div>
          ) : (
            <>
              <LessonList lessons={journal.lessons} />
              <div className="journal-cta">
                <Link className="btn btn-primary btn-sm" to={`/app/new?basedOn=${agentId}`}>Build a smarter version</Link>
                <p>The AI reads these lessons with your strategy. You see the new rules and a backtest before anything runs. Small samples describe what happened, not what will.</p>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
