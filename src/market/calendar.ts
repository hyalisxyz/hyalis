/**
 * Trading calendar for Robinhood stock tokens.
 *
 * The Chainlink equity feeds on Robinhood Chain update 24/5: from Sunday 20:00 to Friday
 * 20:00 New York time, with nothing on Saturday. This was measured from stored rounds on
 * 2026-11-18. Sessions inside that window: overnight 20:00–04:00, pre-market 04:00–09:30,
 * regular 09:30–16:00, after-hours 16:00–20:00.
 *
 * Exchange holidays and early closes follow the NYSE calendar. Conservative choices:
 *  - a full holiday closes the 24 hours before its 20:00 reopening, so the overnight
 *    session leading into the holiday is closed too;
 *  - an early-close day is closed from 13:00 until the 20:00 overnight session.
 * Years missing from the table are reported as unknown, and the gate refuses to trade
 * in them, rather than guessing.
 */

export type Session = "overnight" | "pre" | "regular" | "after" | "closed" | "always";

export interface MarketState {
  open: boolean;
  session: Session;
  /** Why it is closed, for receipts and logs. */
  reason: string | null;
}

/** NYSE full-day closures (ET dates). */
const HOLIDAYS: Record<number, string[]> = {
  2026: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
  2027: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
};

/** NYSE 13:00 early closes (ET dates). */
const EARLY_CLOSES: Record<number, string[]> = {
  2026: ["2026-11-27", "2026-12-24"],
  2027: ["2027-11-26"],
};

export const CALENDAR_YEARS = Object.keys(HOLIDAYS).map(Number);

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface EtTime {
  date: string;
  year: number;
  weekday: number;
  /** Minutes since 00:00 ET. */
  minute: number;
}

export function etTime(unixSec: number): EtTime {
  const p = Object.fromEntries(fmt.formatToParts(new Date(unixSec * 1000)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year),
    weekday: WEEKDAYS[p.weekday!]!,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** The ET calendar date one day after `date` (YYYY-MM-DD). */
function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const isHoliday = (date: string) => HOLIDAYS[Number(date.slice(0, 4))]?.includes(date) ?? false;
const isEarlyClose = (date: string) => EARLY_CLOSES[Number(date.slice(0, 4))]?.includes(date) ?? false;

const H = (h: number, m = 0) => h * 60 + m;

export function marketState(unixSec: number): MarketState {
  const t = etTime(unixSec);
  const closed = (reason: string): MarketState => ({ open: false, session: "closed", reason });

  // The window from 20:00 belongs to the next trading day.
  const evening = t.minute >= H(20);
  const tradingDate = evening ? nextDate(t.date) : t.date;
  const tradingYear = Number(tradingDate.slice(0, 4));
  if (!(tradingYear in HOLIDAYS) || !(t.year in HOLIDAYS)) return closed(`no exchange calendar for ${tradingYear}`);

  const tradingWeekday = evening ? (t.weekday + 1) % 7 : t.weekday;
  if (tradingWeekday === 6 || tradingWeekday === 0) return closed("weekend");
  if (isHoliday(tradingDate)) return closed(`exchange holiday ${tradingDate}`);
  if (!evening && t.minute >= H(13) && isEarlyClose(t.date)) return closed(`early close ${t.date}`);

  if (evening || t.minute < H(4)) return { open: true, session: "overnight", reason: null };
  if (t.minute < H(9, 30)) return { open: true, session: "pre", reason: null };
  if (t.minute < H(16)) return { open: true, session: "regular", reason: null };
  return { open: true, session: "after", reason: null };
}

const ALWAYS: MarketState = { open: true, session: "always", reason: null };

/** Market state for an asset class. Crypto trades every hour of every day. */
export function marketStateFor(assetClass: "equity" | "crypto", unixSec: number): MarketState {
  return assetClass === "crypto" ? ALWAYS : marketState(unixSec);
}

/** Open-hour test for an asset class, for building indicator bars. */
export function hourOpenFor(assetClass: "equity" | "crypto"): (hourEnd: number) => boolean {
  return assetClass === "crypto" ? () => true : hourWasOpen;
}

/** True when the equity market was open at some point during the hour ending at `hourEnd`. */
export function hourWasOpen(hourEnd: number): boolean {
  // Sessions change on whole or half hours; checking the start, middle and last minute of
  // the hour catches an hour that is only partly open (09:00–10:00 around 09:30, 13:00 closes).
  return marketState(hourEnd - 3600).open || marketState(hourEnd - 1800).open || marketState(hourEnd - 60).open;
}
