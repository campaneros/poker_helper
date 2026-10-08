/** Per-opponent range posterior: weights over all two-card holdings, narrowed by each recorded action.
 * Weights are indexed by pairKey (only a<b entries used) and sum to 1. Known cards and dead cards are exact:
 * a holding containing a dead card has weight 0, and a known card forces every surviving holding to contain it. */
import { Card, DECK, RANKS, rankOf, suitOf } from "./cards.js";
import { OppAction, OppStats, rangeFraction } from "./policy.js";
import { PREFLOP_KEEP, handPct, inRange, madeHandPct, pairKey } from "./ranges.js";

export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";
export interface ActionRecord { street: number; type: ActionType; amount?: number; pot_before?: number }

const TAU = 0.02; // softness of the range boundary: a hard "top f%" cut would make one odd action impossible
const BOARD_LEN = [0, 3, 4, 5];
const DEFAULT_BET_FRAC = 0.6;
// Actions that narrow the range. A check says nothing about strength and a fold removes the player.
const NARROWING: Partial<Record<ActionType, OppAction>> = { call: "call", bet: "bet", raise: "raise", allin: "raise" };

const soft = (x: number): number => 1 / (1 + Math.exp(-x / TAU));

function normalized(w: Float64Array): Float64Array {
  let sum = 0;
  for (let i = 0; i < w.length; i++) sum += w[i];
  if (sum > 0) for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
}

const count = (w: Float64Array): number => w.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);

/** Every holding not blocked by dead cards; with known cards, only those that contain all of them. */
export function priorRange(dead: ReadonlySet<Card>, known: readonly Card[] = []): Float64Array {
  const w = new Float64Array(52 * 52);
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      if (!dead.has(a) && !dead.has(b) && known.every((k) => k === a || k === b)) w[pairKey(a, b)] = 1;
    }
  }
  return normalized(w);
}

export interface UpdateResult { weights: Float64Array; contradiction: boolean }

/** Bayes-style update of one range by one action seen on `board` (the cards visible on that street). */
export function updateRange(
  w: Float64Array, action: ActionRecord, stats: OppStats, board: readonly Card[],
): UpdateResult {
  const kind = NARROWING[action.type];
  if (!kind) return { weights: w, contradiction: false };
  const betFrac = action.amount !== undefined && action.pot_before ? action.amount / action.pot_before : DEFAULT_BET_FRAC;
  const f = rangeFraction(stats, action.street, kind, betFrac);
  const onBoard = new Set(board);
  const made = action.street > 0 && board.length >= 3
    ? madeHandPct(DECK.filter((c) => !onBoard.has(c)), board) : null;
  const out = new Float64Array(w.length);
  let sum = 0;
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      const idx = pairKey(a, b);
      if (w[idx] <= 0) continue;
      const member = made === null
        ? soft(f - handPct(a, b))
        : Math.max(soft(f - made[idx]), soft(f * PREFLOP_KEEP - handPct(a, b)));
      out[idx] = w[idx] * member;
      sum += out[idx];
    }
  }
  // inconsistent evidence (e.g. a bet the model says this player never makes): keep what we knew, flag it
  if (sum < 1e-12) return { weights: w, contradiction: true };
  return { weights: normalized(out), contradiction: false };
}

export interface PosteriorInput {
  stats: OppStats;
  actions: readonly ActionRecord[];
  board: readonly Card[];
  dead: ReadonlySet<Card>;
  known?: readonly Card[];
}
export interface Posterior { weights: Float64Array; contradiction: boolean; live: number }

export function buildPosterior(input: PosteriorInput): Posterior {
  const known = input.known ?? [];
  let weights = priorRange(input.dead, known);
  const live = count(weights);
  let contradiction = false;
  if (known.length < 2) {
    for (const action of input.actions) {
      const need = BOARD_LEN[action.street];
      if (need === undefined || input.board.length < need) continue; // street not reached on this board
      const r = updateRange(weights, action, input.stats, input.board.slice(0, need));
      weights = r.weights;
      contradiction = contradiction || r.contradiction;
    }
  }
  return { weights, contradiction, live };
}

/** A top-`frac` range as explicit weights (the legacy fraction model, used to show likely hands). */
export function fractionRange(frac: number, board: readonly Card[], dead: ReadonlySet<Card>): Float64Array {
  const onBoard = new Set(board);
  const made = board.length >= 3 && frac < 1 ? madeHandPct(DECK.filter((c) => !onBoard.has(c) && !dead.has(c)), board) : null;
  const w = new Float64Array(52 * 52);
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      if (!dead.has(a) && !dead.has(b) && inRange(a, b, frac, made)) w[pairKey(a, b)] = 1;
    }
  }
  return normalized(w);
}

/** How wide the range is, as a top-fraction equivalent: participation ratio over the unblocked holdings. */
export function effectiveFraction(w: Float64Array, live: number): number {
  let sumSq = 0, n = 0, only = -1;
  for (let i = 0; i < w.length; i++) {
    if (w[i] > 0) { sumSq += w[i] * w[i]; n++; only = i; }
  }
  if (n === 0 || live === 0) return 1;
  if (n === 1) return Math.max(0.04, handPct(Math.floor(only / 52), only % 52)); // one exact holding
  return Math.max(0.04, Math.min(1, 1 / sumSq / live));
}

const label = (a: Card, b: Card): string => {
  const hi = Math.max(rankOf(a), rankOf(b)), lo = Math.min(rankOf(a), rankOf(b));
  return RANKS[hi] + RANKS[lo] + (hi === lo ? "" : suitOf(a) === suitOf(b) ? "s" : "o");
};

/** The most likely hand classes (AA, AKs, QJo...) with their probability share. */
export function topClasses(w: Float64Array, n = 5): { hand: string; pct: number }[] {
  const byClass = new Map<string, number>();
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      const v = w[pairKey(a, b)];
      if (v > 0) byClass.set(label(a, b), (byClass.get(label(a, b)) ?? 0) + v);
    }
  }
  return [...byClass.entries()].sort((x, y) => y[1] - x[1]).slice(0, n)
    .map(([hand, v]) => ({ hand, pct: Math.round(v * 1000) / 10 }));
}
