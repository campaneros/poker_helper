/** The betting of one hand at a physical table: who sits where, who acts next, what each action means for the pot.
 * The user says who acts first before the flop and what each player does; everything else (button, blinds, the street an
 * action belongs to, the pot, what hero must call, who raised last and by how much) is derived here.
 * Pure and immutable: every step returns a new state. Stacks are not tracked, so side pots are not split (the pot total
 * is still right); an all-in amount is the player's total on that street. */
import type { ActionType } from "./range.js";

export interface TableSetup {
  seats: readonly string[]; // ids in table order (clockwise); "hero" for the user
  first: number; // index in `seats` of the first player to act before the flop
  bb: number;
}
export interface TableAction { who: string; type: ActionType; amount?: number }

/** One recorded step. `amount`: total put in on the street for bet / raise / all-in, chips added for a call. */
interface TableStep { who: string; type: ActionType; amount?: number; street: number; pot_before: number }

export interface TableState {
  seats: readonly string[];
  bb: number;
  button: number;
  smallBlind: number; // seat indexes
  bigBlind: number;
  street: number; // street of the NEXT action (0 preflop .. 3 river)
  current: number; // highest total on this street
  committed: Readonly<Record<string, number>>; // per player, this street
  total: Readonly<Record<string, number>>; // per player, whole hand
  folded: readonly string[];
  allIn: readonly string[];
  acted: readonly string[]; // who has acted since the last bet or raise on this street
  cursor: number; // seat index where the search for the next player starts
  over: null | "fold" | "showdown"; // fold: one player left. showdown: no more betting, cards come out
  lastRaise: null | { who: string; to: number; size: number; street: number };
  raiseSize: number; // size of the last FULL raise on this street: an all-in that falls short does not change it
  steps: readonly TableStep[];
}
export type TableResult = { state: TableState } | { error: string };

export const BOARD_FOR_STREET = [0, 3, 4, 5] as const;
const STREET_NAMES = ["preflop", "flop", "turn", "river"];

const without = <T>(xs: readonly T[], x: T): T[] => xs.filter((y) => y !== x);

/** Seat index of the button for a given first-to-act: heads-up and three-handed it is the first to act itself. */
function buttonFor(n: number, first: number): number {
  return n <= 3 ? first : (((first - 3) % n) + n) % n;
}

export function start(setup: TableSetup): TableResult {
  const n = setup.seats.length;
  if (n < 2 || n > 10) return { error: "al tavolo servono da 2 a 10 giocatori" };
  if (new Set(setup.seats).size !== n) return { error: "giocatori duplicati al tavolo" };
  if (!Number.isInteger(setup.first) || setup.first < 0 || setup.first >= n) return { error: "primo a parlare non valido" };
  if (!(setup.bb > 0)) return { error: "big blind non valido" };
  const button = buttonFor(n, setup.first);
  const smallBlind = n === 2 ? button : (button + 1) % n;
  const bigBlind = (smallBlind + 1) % n;
  const committed: Record<string, number> = Object.fromEntries(setup.seats.map((s) => [s, 0]));
  committed[setup.seats[smallBlind]] = setup.bb / 2;
  committed[setup.seats[bigBlind]] = setup.bb;
  return {
    state: {
      seats: [...setup.seats], bb: setup.bb, button, smallBlind, bigBlind, street: 0, current: setup.bb,
      committed, total: { ...committed }, folded: [], allIn: [], acted: [], cursor: setup.first, over: null,
      lastRaise: null, raiseSize: 0, steps: [],
    },
  };
}

export const pot = (s: TableState): number => Object.values(s.total).reduce((a, b) => a + b, 0);

/** What the player still has to put in to stay in this street. */
export const toCall = (s: TableState, who: string): number => Math.max(0, s.current - (s.committed[who] ?? 0));

/** The next player who must act, or null when the street or the hand is over. */
export function nextToAct(s: TableState): string | null {
  if (s.over) return null;
  const n = s.seats.length;
  for (let k = 0; k < n; k++) {
    const who = s.seats[(s.cursor + k) % n];
    if (s.folded.includes(who) || s.allIn.includes(who)) continue;
    if (!s.acted.includes(who) || toCall(s, who) > 0) return who;
  }
  return null;
}

/** The smallest legal raise-to now (the last full raise on top of the current bet; one big blind if nobody raised). */
export const minRaiseTo = (s: TableState): number => s.current + Math.max(s.raiseSize, s.bb);

/** After a street closes: next street, or the end of the hand. */
function closeStreet(s: TableState): TableState {
  const alive = s.seats.filter((x) => !s.folded.includes(x));
  if (alive.length <= 1) return { ...s, over: "fold" };
  const canBet = alive.filter((x) => !s.allIn.includes(x));
  if (s.street === 3 || canBet.length <= 1) return { ...s, over: "showdown" };
  return {
    ...s, street: s.street + 1, current: 0, raiseSize: 0, acted: [], cursor: (s.button + 1) % s.seats.length,
    committed: Object.fromEntries(s.seats.map((x) => [x, 0])),
  };
}

export function apply(s: TableState, a: TableAction): TableResult {
  if (s.over) return { error: "la mano è finita" };
  const expected = nextToAct(s);
  if (expected === null) return { error: "la mano è finita" };
  if (a.who !== expected) return { error: `ora tocca a ${expected}` };
  const mine = s.committed[a.who], owe = toCall(s, a.who);
  const amount = a.amount;
  let next: TableState;
  let recorded: number | undefined;
  const pushed = (to: number, raised: boolean): TableState => {
    const added = to - mine;
    const committed = { ...s.committed, [a.who]: to };
    const total = { ...s.total, [a.who]: s.total[a.who] + added };
    const acted = raised ? [a.who] : [...s.acted, a.who];
    const size = to - s.current;
    const lastRaise = raised ? { who: a.who, to, size, street: s.street } : s.lastRaise;
    const raiseSize = raised && size >= Math.max(s.raiseSize, s.bb) ? size : s.raiseSize;
    return { ...s, committed, total, acted, current: raised ? to : s.current, lastRaise, raiseSize };
  };
  switch (a.type) {
    case "fold":
      next = { ...s, folded: [...s.folded, a.who], acted: without(s.acted, a.who) };
      break;
    case "check":
      if (owe > 0) return { error: "non puoi fare check: c'è una puntata da chiamare" };
      next = { ...s, acted: [...s.acted, a.who] };
      break;
    case "call":
      if (owe <= 0) return { error: "niente da chiamare: usa check" };
      recorded = owe;
      next = pushed(s.current, false);
      break;
    case "bet":
      if (s.current > 0) return { error: "c'è già una puntata: usa raise" };
      if (!(amount !== undefined && amount > 0)) return { error: "inserisci l'importo della puntata" };
      recorded = amount;
      next = pushed(amount, true);
      break;
    case "raise":
      if (s.current <= 0) return { error: "nessuna puntata da rilanciare: usa bet" };
      if (!(amount !== undefined && amount > s.current)) return { error: `il rilancio deve superare ${s.current}` };
      recorded = amount;
      next = pushed(amount, true);
      break;
    case "allin": {
      if (!(amount !== undefined && amount > mine)) return { error: "inserisci il totale dell'all-in" };
      recorded = amount;
      next = { ...pushed(amount, amount > s.current), allIn: [...s.allIn, a.who] };
      break;
    }
    default:
      return { error: "azione non valida" };
  }
  const step: TableStep = {
    who: a.who, type: a.type, ...(recorded !== undefined ? { amount: recorded } : {}), street: s.street, pot_before: pot(s),
  };
  next = { ...next, steps: [...s.steps, step], cursor: (s.seats.indexOf(a.who) + 1) % s.seats.length };
  // a fold that leaves one player ends the hand at once; otherwise the street closes when nobody is left to act
  if (next.seats.filter((x) => !next.folded.includes(x)).length <= 1) return { state: { ...next, over: "fold" } };
  return { state: nextToAct(next) === null ? closeStreet(next) : next };
}

/** Actions that must have happened for `who` to be the one acting now: players skipped over folded (or checked if free). */
export function skippedBefore(s: TableState, who: string): TableAction[] | { error: string } {
  const out: TableAction[] = [];
  let cur = s;
  for (let guard = 0; guard < s.seats.length; guard++) {
    const expected = nextToAct(cur);
    if (expected === null) return { error: "la mano è finita" };
    if (expected === who) return out;
    const act: TableAction = { who: expected, type: toCall(cur, expected) > 0 ? "fold" : "check" };
    const r = apply(cur, act);
    if ("error" in r) return r;
    out.push(act);
    cur = r.state;
  }
  return { error: `${who} non può agire ora` };
}

/** Apply a list of actions from the start. On failure: the reason and the index of the offending action. */
export function replay(setup: TableSetup, actions: readonly TableAction[]): { state: TableState } | { error: string; at: number } {
  const begun = start(setup);
  if ("error" in begun) return { error: begun.error, at: -1 };
  let state = begun.state;
  for (let i = 0; i < actions.length; i++) {
    const r = apply(state, actions[i]);
    if ("error" in r) return { error: r.error, at: i };
    state = r.state;
  }
  return { state };
}

/** Position of a seat as the advisor wants it: 0 = first to act after the flop ... 1 = the button. */
export function positionOf(s: TableState, who: string): number {
  const n = s.seats.length;
  const idx = s.seats.indexOf(who);
  if (idx < 0 || n < 2) return 0.5;
  const fromSmallBlind = (((idx - (s.button + 1)) % n) + n) % n; // 0 = first after the button, n-1 = the button
  return fromSmallBlind / (n - 1);
}

export const streetName = (street: number): string => STREET_NAMES[street] ?? "?";
