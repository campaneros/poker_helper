/** Heads-up push/fold advice from the exact Nash table (bench/pushfold.py, CFR+).
 * Covers two spots, preflop, 2 to 25 big blinds: the small blind first to act (shove or fold) and the big blind
 * facing an all-in (call or fold). The table comes from chip-EV solving, so in a tournament it ignores the ICM. */
import { Card, RANKS, rankOf, suitOf } from "./cards.js";

export interface PushFoldTable {
  version: number;
  depths: number[]; // effective stacks in big blinds, ascending
  classes: string[]; // "AA", "AKs", "AKo", ...
  shove: number[][]; // [depth][class] small blind: probability of shoving
  call: number[][]; // [depth][class] big blind: probability of calling a shove
}

export type PushFoldRole = "small_blind" | "big_blind";
export interface PushFoldAdvice {
  role: PushFoldRole;
  hand: string; // the starting-hand class, e.g. "AKs"
  depth: number; // effective stack in big blinds
  probability: number; // of shoving (small blind) or calling (big blind)
  decision: "shove" | "call" | "fold";
  caveat?: "icm"; // chip-EV table used in a tournament
  icm?: boolean; // true when solved WITH the ICM for this exact spot (icmpushfold.ts)
  gap?: number; // ICM solutions only: Nash gap as a share of the prize pool (0 = exact equilibrium)
}

export interface SpotContext {
  bb: number;
  pot: number;
  to_call: number;
  stack: number; // chips hero still has behind
  structure: "no_limit" | "pot_limit";
  tournament: boolean;
}

export const TOLERANCE_BB = 0.01; // amounts are typed by hand: accept a hundredth of a big blind of slack

/** Combinations of a class: 6 for a pair, 4 suited, 12 offsuit. */
export const COMBOS_PER_CLASS = (label: string): number => (label.length === 2 ? 6 : label[2] === "s" ? 4 : 12);

/** "AKs", "T9o", "77": the 169-class label of two hole cards. */
export function startingHandClass(a: Card, b: Card): string {
  const hi = Math.max(rankOf(a), rankOf(b)), lo = Math.min(rankOf(a), rankOf(b));
  if (hi === lo) return RANKS[hi] + RANKS[lo];
  return RANKS[hi] + RANKS[lo] + (suitOf(a) === suitOf(b) ? "s" : "o");
}

/** Probability for a class at an effective stack, interpolated linearly between the two nearest solved depths.
 * null outside the solved range. */
export function lookup(table: PushFoldTable, role: PushFoldRole, hand: string, depth: number): number | null {
  const col = table.classes.indexOf(hand);
  const { depths } = table;
  if (col < 0 || !(depth >= depths[0] && depth <= depths[depths.length - 1])) return null;
  const rows = role === "small_blind" ? table.shove : table.call;
  let i = 0;
  while (i < depths.length - 2 && depth > depths[i + 1]) i++;
  const span = depths[i + 1] - depths[i];
  const t = span > 0 ? (depth - depths[i]) / span : 0;
  return rows[i][col] * (1 - t) + rows[i + 1][col] * t;
}

/** Which of the two spots this is, and at what effective stack; null when it is neither. */
export function detectSpot(ctx: SpotContext): { role: PushFoldRole; depth: number } | null {
  const near = (x: number, bbs: number) => Math.abs(x - bbs * ctx.bb) <= TOLERANCE_BB * ctx.bb;
  // small blind to act: has posted half a big blind, must put in another half to complete
  if (near(ctx.pot, 1.5) && near(ctx.to_call, 0.5)) return { role: "small_blind", depth: (ctx.stack + 0.5 * ctx.bb) / ctx.bb };
  // big blind facing a bet that covers what is left: calling is an all-in
  if (ctx.to_call > 0 && ctx.to_call >= ctx.stack - TOLERANCE_BB * ctx.bb) {
    return { role: "big_blind", depth: (ctx.stack + ctx.bb) / ctx.bb };
  }
  return null;
}

export function pushFoldAdvice(
  table: PushFoldTable, hero: readonly [Card, Card], ctx: SpotContext, opponents: number, boardCards: number,
): PushFoldAdvice | null {
  if (opponents !== 1 || boardCards !== 0 || ctx.structure !== "no_limit") return null;
  const spot = detectSpot(ctx);
  if (!spot) return null;
  const hand = startingHandClass(hero[0], hero[1]);
  const probability = lookup(table, spot.role, hand, spot.depth);
  if (probability === null) return null;
  const act = probability >= 0.5;
  return {
    role: spot.role, hand, depth: Math.round(spot.depth * 100) / 100, probability,
    decision: spot.role === "small_blind" ? (act ? "shove" : "fold") : (act ? "call" : "fold"),
    ...(ctx.tournament ? { caveat: "icm" as const } : {}),
  };
}
