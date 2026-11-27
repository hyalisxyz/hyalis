import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Activity } from "../lib/api";
import { decisionLine, money, plain, sealedHour, short, sourceName } from "../lib/format";
import { prefersReduced } from "../lib/motion";

/** "Nov 25, 09:41 UTC": receipts carry chain time, the same for every reader. */
export function utcStamp(sec: number): string {
  const d = new Date(sec * 1000);
  const day = d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${d.toISOString().slice(11, 16)} UTC`;
}

const qty = (q: number) => (q >= 100 ? q.toFixed(2) : q >= 1 ? q.toFixed(3) : q.toPrecision(3));
const signed = (n: number) => `${n < 0 ? "−" : "+"}${money(Math.abs(n), 2)}`;

/** One decision, printed the way the record has it. */
export function Receipt({ a, fresh = false }: { a: Activity; fresh?: boolean }) {
  const r = a.record ?? {};
  const d = decisionLine(r);
  const f = r.fill;
  const pnl: number | null = f && f.action !== "open" && typeof f.pnl === "number" ? f.pnl : null;
  return (
    <div className={`rc-feed${fresh ? " fresh" : ""}`}>
      <Link to={`/app/proofs?receipt=${a.id}`} className="rc" aria-label={`Receipt ${a.id}: check it`}>
        <div className="rc-in">
          <div className="rc-row dim"><span>Receipt {a.id}</span><span>{utcStamp(a.createdAt)}</span></div>
          <div className="rc-agent">{a.agentName}</div>
          <div className={`rc-act${d.side === "short" ? " short" : ""}`}>{d.verb} {d.symbol}</div>
          {f ? (
            <>
              <div className="rc-row"><span>{qty(f.qty)} at</span><span>{money(f.price)}</span></div>
              <div className="rc-row"><span>Notional</span><span>{money(f.notional, 2)}</span></div>
              {pnl !== null ? <div className={`rc-row strong${pnl < 0 ? " red" : ""}`}><span>Profit</span><span>{signed(pnl)}</span></div> : null}
            </>
          ) : (
            <div className="rc-row"><span>Outcome</span><span>{String(r.outcome ?? "recorded")}</span></div>
          )}
          {r.decision?.reason ? <div className="rc-why">Why: {plain(String(r.decision.reason))}</div> : null}
          {r.gate?.secondSource ? (
            <div className="rc-row dim"><span>Price check</span><span>{r.gate.gapBps} bps from {sourceName(String(r.gate.secondSource))}</span></div>
          ) : null}
          <div className="rc-cut" aria-hidden />
          <div className="rc-row dim"><span>Leaf</span><span>{short(a.leaf, 6, 4)}</span></div>
          <div className="rc-row dim"><span>Sealed in</span><span>{sealedHour(a.epoch)}</span></div>
          {a.anchorTx ? <div className="rc-row dim"><span>On chain</span><span>tx {short(a.anchorTx, 6, 4)}</span></div> : null}
          {a.anchored ? (
            <div className="rc-stamp" role="img" aria-label="Sealed on Robinhood Chain">
              <b>Sealed</b>
              <span>Robinhood Chain</span>
            </div>
          ) : (
            <div className="rc-pending">Seals at the top of the hour</div>
          )}
        </div>
      </Link>
    </div>
  );
}

/**
 * The latest decisions coming out of a receipt printer. The newest one prints when the page opens
 * (and whenever a new decision arrives while it is open); the rest of the tape hangs below it.
 */
export function Printer({ activity }: { activity: Activity[] }) {
  const items = useMemo(() => activity.filter((a) => a.record?.decision || a.record?.fill).slice(0, 5), [activity]);
  const seen = useRef<Set<number>>(new Set());
  const [fresh, setFresh] = useState<number | null>(null);
  useEffect(() => {
    const top = items[0];
    if (!top) return;
    if (!seen.current.has(top.id) && !prefersReduced()) setFresh(top.id);
    for (const i of items) seen.current.add(i.id);
  }, [items]);

  // Printing moves the whole roll down out of the slot by the new receipt's height. It is done
  // with a transform, so nothing on the page is laid out again while it prints.
  const roll = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    if (fresh === null) return;
    setLift((roll.current?.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0);
  }, [fresh]);

  return (
    <div className="tp-printer" role="region" aria-label="Latest decisions, printed as receipts">
      <div className="tp-printer-head" aria-hidden>
        <i />
      </div>
      <div className="tp-tape">
        <div ref={roll} key={fresh ?? "still"} className={`tp-roll${lift && fresh !== null ? " feeding" : ""}`} style={{ ["--lift" as any]: `${lift}px` }}>
        {items.length ? (
          items.map((a) => <Receipt key={a.id} a={a} fresh={a.id === fresh} />)
        ) : (
          <div className="rc-feed">
            <div className="rc">
              <div className="rc-in">
                <div className="rc-row dim"><span>Loading the latest decisions</span></div>
                <div className="rc-agent">&nbsp;</div>
                <div className="rc-act">&nbsp;</div>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
