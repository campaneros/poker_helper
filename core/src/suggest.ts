/** Suggest a style that fits how a player really plays, from his recorded hands.
 * The observed numbers are VPIP, PFR and aggression computed from the history alone (the assigned style is NOT blended
 * in: that would only echo it back). A style is suggested when there is enough evidence and it is clearly closer to
 * the observed play than the one he has now. */
import { deriveStats, type HandRecord, type LegacyCounts } from "./history.js";
import { PRIOR, type OppStats } from "./policy.js";

export interface StyleLike extends OppStats { id: string; name: string }
export interface StyleSuggestion {
  style_id: string;
  name: string;
  hands: number; // hands the observation rests on
  observed: { vpip: number; pfr: number; af: number };
  distance: number; // of the suggested style from the observed play
  current_distance: number; // of the style he has now (or the average player)
}

export const MIN_HANDS = 15; // below this the numbers move too much to say anything
export const MARGIN = 0.5; // the suggestion must be this much closer, in the units of `distance`
// distance scales: a gap of this size in each stat counts as 1
const SCALE = { vpip: 0.12, pfr: 0.08, af: 1.2 };
const AF_CAP = 6;
const PSEUDO_CALLS = 2; // aggression is shrunk toward the average player (AF 1.5) with the weight of 2 calls: finite even for a player who never calls

export const styleDistance = (a: OppStats, b: OppStats): number =>
  Math.hypot(
    (a.vpip - b.vpip) / SCALE.vpip, (a.pfr - b.pfr) / SCALE.pfr,
    (Math.min(a.af, AF_CAP) - Math.min(b.af, AF_CAP)) / SCALE.af,
  );

export function observedPlay(
  playerId: string, hands: readonly HandRecord[], legacy?: LegacyCounts,
): { vpip: number; pfr: number; af: number; hands: number } {
  const s = deriveStats(playerId, hands, PRIOR, legacy, { priorHands: 0, priorCalls: PSEUDO_CALLS, priorOpportunities: 1 });
  return { vpip: s.vpip, pfr: s.pfr, af: s.af, hands: s.hands };
}

export function suggestStyle(
  playerId: string, hands: readonly HandRecord[], styles: readonly StyleLike[], currentStyleId: string | null,
  legacy?: LegacyCounts,
): StyleSuggestion | null {
  const seen = observedPlay(playerId, hands, legacy);
  if (seen.hands < MIN_HANDS || styles.length === 0) return null;
  const current = styles.find((s) => s.id === currentStyleId) ?? PRIOR;
  const currentDistance = styleDistance(seen, current);
  let best: StyleLike | null = null, bestDistance = Infinity;
  for (const s of styles) {
    const d = styleDistance(seen, s);
    if (d < bestDistance) { best = s; bestDistance = d; } // the first of equals wins: the order of the list is the tie-break
  }
  if (!best || best.id === currentStyleId || bestDistance + MARGIN >= currentDistance) return null;
  return {
    style_id: best.id, name: best.name, hands: seen.hands, observed: { vpip: seen.vpip, pfr: seen.pfr, af: seen.af },
    distance: bestDistance, current_distance: currentDistance,
  };
}
