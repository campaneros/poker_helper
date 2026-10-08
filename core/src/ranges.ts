/** Starting-hand percentile table (Chen score), used to model opponent ranges. */
import { Card, evaluate, rankOf, suitOf } from "./cards.js";

const HIGH_POINTS: Record<number, number> = { 12: 10, 11: 8, 10: 7, 9: 6 }; // A K Q J
const GAP_PENALTY: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 4 };

function chen(hi: number, lo: number, suited: boolean): number {
  const pts = HIGH_POINTS[hi] ?? (hi + 2) / 2;
  if (hi === lo) return Math.max(5, 2 * pts);
  let score = pts + (suited ? 2 : 0);
  const gap = hi - lo - 1;
  score -= GAP_PENALTY[gap] ?? 5;
  if (gap <= 1 && hi < 10) score += 1;
  return score;
}

const classKey = (hi: number, lo: number, suited: boolean): number => (hi * 13 + lo) * 2 + (suited ? 1 : 0);

function buildClassPct(): Map<number, number> {
  const classes: { score: number; hi: number; lo: number; suited: boolean; combos: number }[] = [];
  for (let hi = 0; hi < 13; hi++) {
    for (let lo = 0; lo <= hi; lo++) {
      for (const suited of hi === lo ? [false] : [false, true]) {
        const combos = hi === lo ? 6 : suited ? 4 : 12;
        classes.push({ score: chen(hi, lo, suited), hi, lo, suited, combos });
      }
    }
  }
  classes.sort((a, b) => b.score - a.score || b.hi - a.hi || b.lo - a.lo);
  const pct = new Map<number, number>();
  let cum = 0;
  for (const c of classes) {
    cum += c.combos;
    pct.set(classKey(c.hi, c.lo, c.suited), cum / 1326);
  }
  return pct;
}

const CLASS_PCT = buildClassPct();

/** Fraction of all hands at least as strong as (a, b); ~0.0045 = AA. */
export function handPct(a: Card, b: Card): number {
  const ra = rankOf(a), rb = rankOf(b);
  const suited = suitOf(a) === suitOf(b) && ra !== rb;
  return CLASS_PCT.get(classKey(Math.max(ra, rb), Math.min(ra, rb), suited)) as number;
}

/** Postflop, hands in the top 25% of the range preflop always stay (draws, overpairs). */
export const PREFLOP_KEEP = 0.25;
export const pairKey = (a: Card, b: Card): number => (a < b ? a * 52 + b : b * 52 + a);

/** Percentile of every possible holding by made-hand strength on the current board (ties share the upper bound). */
export function madeHandPct(deck: readonly Card[], board: readonly Card[]): Float64Array {
  const cards = [...board, 0, 0];
  const scored: { score: number; key: number }[] = [];
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      cards[board.length] = deck[i]; cards[board.length + 1] = deck[j];
      scored.push({ score: evaluate(cards), key: pairKey(deck[i], deck[j]) });
    }
  }
  scored.sort((x, y) => y.score - x.score); // best first
  const table = new Float64Array(52 * 52);
  const n = scored.length;
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && scored[j].score === scored[i].score) j++;
    for (let k = i; k < j; k++) table[scored[k].key] = j / n;
    i = j;
  }
  return table;
}

/** Is the holding inside a top-`frac` range? Preflop by Chen percentile, postflop by made-hand strength. */
export function inRange(a: Card, b: Card, frac: number, made: Float64Array | null): boolean {
  if (frac >= 1.0) return true;
  if (made === null) return handPct(a, b) <= frac;
  return made[pairKey(a, b)] <= frac || handPct(a, b) <= frac * PREFLOP_KEEP;
}
