/** Hand history and the player statistics derived from it. Stats come from recorded actions, weighted toward
 * recent hands, and blend with a prior (the player's assigned style or the default player) that fades as
 * evidence accumulates. */
import { PRIOR, foldToBet, type OppStats } from "./policy.js";
import type { ActionType } from "./range.js";

export interface HandAction {
  player: string; // player id, or "anon:N" for someone who is not saved
  street: number; // 0 preflop .. 3 river
  type: ActionType;
  amount?: number;
  pot_before?: number;
}

export interface HandRecord {
  id: string;
  ts: number; // creation time, ms since epoch: orders hands for recency weighting
  bb: number;
  structure: "no_limit" | "pot_limit";
  board: string[];
  hero?: string[];
  players: { id: string; known?: string[] }[]; // known = cards that player showed
  actions: HandAction[]; // in order of play
}

/** Counters from before the action log existed (or from the quick manual recorder). */
export interface LegacyCounts { hands: number; vpip: number; pfr: number; bets: number; calls: number }

export interface DerivedStats extends OppStats {
  ftb: number;
  style: string;
  hands: number; // hands on record (including legacy counters)
  effectiveHands: number; // after recency weighting
}

export interface StatsOptions {
  halfLife?: number; // a hand this many hands old counts half
  priorHands?: number; // weight of the prior, in hands
  priorCalls?: number; // pseudo-calls behind the prior aggression factor
  priorOpportunities?: number; // pseudo-bets faced behind the prior fold-to-bet
}
const DEFAULTS = { halfLife: 50, priorHands: 20, priorCalls: 10, priorOpportunities: 10 };

const isAggressive = (t: ActionType): boolean => t === "bet" || t === "raise" || t === "allin";

interface Observation { vpip: number; pfr: number; bets: number; calls: number; faced: number; folded: number }

/** What one hand says about one player. */
export function observe(hand: HandRecord, playerId: string): Observation {
  const o: Observation = { vpip: 0, pfr: 0, bets: 0, calls: 0, faced: 0, folded: 0 };
  let street = -1;
  let outstanding: string | null = null; // who made the bet currently waiting for an answer
  for (const a of hand.actions) {
    if (a.street !== street) { street = a.street; outstanding = null; }
    if (a.player === playerId) {
      if (a.street === 0) {
        if (a.type === "call" || isAggressive(a.type)) o.vpip = 1;
        if (isAggressive(a.type)) o.pfr = 1;
      } else {
        if (isAggressive(a.type)) o.bets++;
        else if (a.type === "call") o.calls++;
        if (outstanding !== null && outstanding !== playerId) {
          o.faced++;
          if (a.type === "fold") o.folded++;
        }
      }
    }
    if (isAggressive(a.type)) outstanding = a.player;
  }
  return o;
}

export function styleLabel(vpip: number, af: number): string {
  return (vpip > 0.35 ? "loose" : vpip < 0.2 ? "tight" : "medio") + (af > 2 ? "-aggressivo" : af < 1 ? "-passivo" : "");
}

export function deriveStats(
  playerId: string, hands: readonly HandRecord[], prior: OppStats = PRIOR,
  legacy: LegacyCounts = { hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0 }, options: StatsOptions = {},
): DerivedStats {
  const { halfLife, priorHands, priorCalls, priorOpportunities } = { ...DEFAULTS, ...options };
  const mine = hands.filter((h) => h.players.some((p) => p.id === playerId)).sort((a, b) => a.ts - b.ts);
  const sum = { n: 0, vpip: 0, pfr: 0, bets: 0, calls: 0, faced: 0, folded: 0 };
  mine.forEach((hand, i) => {
    const w = Math.pow(0.5, (mine.length - 1 - i) / halfLife);
    const o = observe(hand, playerId);
    sum.n += w; sum.vpip += w * o.vpip; sum.pfr += w * o.pfr;
    sum.bets += w * o.bets; sum.calls += w * o.calls; sum.faced += w * o.faced; sum.folded += w * o.folded;
  });
  const n = sum.n + legacy.hands + priorHands;
  const vpip = (sum.vpip + legacy.vpip + prior.vpip * priorHands) / n;
  const pfr = Math.min((sum.pfr + legacy.pfr + prior.pfr * priorHands) / n, vpip);
  const af = (sum.bets + legacy.bets + prior.af * priorCalls) / (sum.calls + legacy.calls + priorCalls);
  const ftb = (sum.folded + foldToBet(prior) * priorOpportunities) / (sum.faced + priorOpportunities);
  return {
    vpip, pfr, af, ftb, style: styleLabel(vpip, af),
    hands: mine.length + legacy.hands, effectiveHands: sum.n + legacy.hands,
  };
}
