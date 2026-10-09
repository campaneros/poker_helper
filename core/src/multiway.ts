/** Open-shove advice for multiway short-stack spots (2+ opponents, preflop, up to 15 big blinds).
 *
 * APPROXIMATE, not an equilibrium. The network never shoves here, and no solver covers the spot, so this prices the
 * shove directly: every opponent calls with a top-fraction range (anchored on the exact heads-up Nash calling width at
 * this depth, tightened with the number of opponents and scaled by that player's VPIP), calls are independent, and the
 * equity against every possible set of callers comes from one shared Monte Carlo pass. EV is in chips relative to
 * folding. In a tournament the chips risked are weighted by the bubble factor, like the network does.
 * Not modelled: side pots between callers with different stacks, opponents' actions in this hand, positions behind. */
import { Card, DECK, evaluate } from "./cards.js";
import { drawWeighted, makeSampler, seededRng, type Rng } from "./equity.js";
import { bubbleFactor } from "./icm.js";
import { PRIOR, type OppStats } from "./policy.js";
import { COMBOS_PER_CLASS, TOLERANCE_BB, lookup, startingHandClass, type PushFoldTable, type SpotContext } from "./pushfold.js";
import { priorRange } from "./range.js";
import { handPct, pairKey } from "./ranges.js";

const MAX_DEPTH_BB = 15;
const MIN_DEPTH_BB = 2;
export const MAX_OPPONENTS = 8;
const TIGHTENING_PER_EXTRA_OPPONENT = 0.85; // each caller must also fear the others behind it
const STYLE_MIN = 0.6, STYLE_MAX = 1.6; // VPIP relative to the average player scales the calling width
const CALL_MIN = 0.03, CALL_MAX = 0.8;

export interface MultiwayOpp { stats?: Partial<OppStats>; known?: readonly Card[] }
export interface MultiwayOptions { rng?: Rng; nSims?: number; budgetMs?: number; now?: () => number }

export interface MultiwayAdvice {
  hand: string;
  depth: number; // hero's stack in big blinds
  decision: "shove" | "no_shove";
  ev: number; // chips, relative to folding
  ev_bb: number;
  se_bb: number; // Monte Carlo standard error of ev_bb
  call_probs: number[]; // per opponent: chance they call a shove
  nobody_calls: number;
  bubble_factor: number;
  sims: number;
  approximate: true;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Top-fraction an opponent calls a shove with: the heads-up width, tightened for `opponents`, scaled by VPIP. */
export const callFraction = (base: number, opponents: number, vpip: number = PRIOR.vpip): number =>
  clamp(base * TIGHTENING_PER_EXTRA_OPPONENT ** (opponents - 1) * clamp(vpip / PRIOR.vpip, STYLE_MIN, STYLE_MAX),
    CALL_MIN, CALL_MAX);

/** Share of all hands the big blind calls with at this depth in the heads-up Nash solution. */
export function nashCallWidth(table: PushFoldTable, depth: number): number | null {
  let mass = 0;
  for (const label of table.classes) {
    const p = lookup(table, "big_blind", label, depth);
    if (p === null) return null;
    mass += p * COMBOS_PER_CLASS(label);
  }
  return mass / 1326;
}

/** A top-`frac` calling range among the holdings still possible, and the chance a random such holding is inside it. */
export function callRange(frac: number, blocked: ReadonlySet<Card>, known: readonly Card[]): { weights: Float64Array; prob: number } {
  const universe = priorRange(blocked, known);
  const weights = new Float64Array(universe.length);
  let total = 0, inside = 0;
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      const key = pairKey(a, b), v = universe[key];
      if (v <= 0) continue;
      total += v;
      if (handPct(a, b) <= frac) { weights[key] = v; inside += v; }
    }
  }
  if (inside <= 0) return { weights: universe, prob: 0 }; // never called, but the sampler must not be empty
  for (let i = 0; i < weights.length; i++) weights[i] /= inside;
  return { weights, prob: total > 0 ? inside / total : 0 };
}

export function multiwayPushAdvice(
  table: PushFoldTable, hero: readonly [Card, Card], ctx: SpotContext, opponents: readonly MultiwayOpp[],
  boardCards: number, dead: readonly Card[] = [], tournament?: { stacks: readonly number[]; payouts: readonly number[] },
  options: MultiwayOptions = {},
): MultiwayAdvice | null {
  const k = opponents.length;
  if (boardCards !== 0 || ctx.structure !== "no_limit" || k < 2 || k > MAX_OPPONENTS || !(ctx.bb > 0)) return null;
  // the hero must put chips in to continue (blind to complete or a limped pot) and nobody has raised
  if (!(ctx.to_call > 0) || ctx.to_call > ctx.bb * (1 + TOLERANCE_BB) || !(ctx.stack > 0)) return null;
  const depth = ctx.stack / ctx.bb;
  if (!(depth >= MIN_DEPTH_BB && depth <= MAX_DEPTH_BB)) return null;
  const base = nashCallWidth(table, depth);
  if (base === null) return null;
  const { rng = seededRng(Date.now()), nSims = 20000, budgetMs = 500, now = () => performance.now() } = options;

  const stack = ctx.stack, pot = ctx.pot;
  const known = opponents.map((o) => [...(o.known ?? [])]);
  if (known.some((c) => c.length > 2)) return null;
  const heroSet = new Set<Card>([...hero, ...dead]);
  const ranges = opponents.map((o, i) => {
    const vpip = o.stats?.vpip ?? PRIOR.vpip;
    const frac = callFraction(base, k, vpip);
    const blocked = new Set<Card>([...heroSet, ...known.filter((_, j) => j !== i).flat()]);
    return callRange(frac, blocked, known[i]);
  });
  const callers = ranges.map((r) => r.prob);
  const contributes = opponents.map((_, i) =>
    tournament && tournament.stacks.length === k + 1 ? Math.min(stack, tournament.stacks[i + 1]) : stack);
  const bf = tournament ? bubbleFactor(tournament.stacks, tournament.payouts, 0, stack) : 1;

  // every set of callers: its probability, what hero wins if ahead, and what he loses if behind
  const sets: { mask: number; prob: number; win: number; lose: number }[] = [];
  let nobody = 0;
  for (let mask = 0; mask < 1 << k; mask++) {
    let prob = 1, win = pot, risk = 0;
    for (let i = 0; i < k; i++) {
      if ((mask >> i) & 1) { prob *= callers[i]; win += contributes[i]; risk = Math.max(risk, contributes[i]); }
      else prob *= 1 - callers[i];
    }
    if (mask === 0) nobody = prob;
    if (prob > 1e-12) sets.push({ mask, prob, win, lose: risk * bf });
  }
  const walkover = nobody * pot;

  const samplers = ranges.map((r) => makeSampler(r.weights));
  const held = new Set<Card>([...hero, ...dead, ...known.flat()]);
  const deck = DECK.filter((c) => !held.has(c));
  const used = new Uint8Array(52);
  const cards: Card[] = [0, 0, 0, 0, 0, 0, 0];
  const scores = new Array<number>(k).fill(0);
  const best = new Float64Array(1 << k), ties = new Int32Array(1 << k);
  let sum = 0, sumSq = 0, done = 0;
  const start = now();

  for (let i = 0; i < nSims; i++) {
    if (i && i % 200 === 0 && now() - start > budgetMs) break;
    used.fill(0);
    const hands: [Card, Card][] = [];
    for (let j = 0; j < k; j++) {
      let h = drawWeighted(samplers[j], rng, used);
      while (!h) { // no free holding left: any free hand keeps the sample valid
        const a = deck[Math.floor(rng.next() * deck.length)], b = deck[Math.floor(rng.next() * deck.length)];
        if (a !== b && !used[a] && !used[b]) h = [a, b];
      }
      used[h[0]] = 1; used[h[1]] = 1;
      hands.push(h);
    }
    for (let n = 0; n < 5;) {
      const c = deck[Math.floor(rng.next() * deck.length)];
      if (!used[c]) { used[c] = 1; cards[2 + n] = c; n++; }
    }
    cards[0] = hero[0]; cards[1] = hero[1];
    const heroScore = evaluate(cards, 7);
    for (let j = 0; j < k; j++) { cards[0] = hands[j][0]; cards[1] = hands[j][1]; scores[j] = evaluate(cards, 7); }
    best[0] = -1; ties[0] = 0;
    for (let mask = 1; mask < 1 << k; mask++) { // best opposing score and its multiplicity within each set of callers
      const j = 31 - Math.clz32(mask & -mask), rest = mask & (mask - 1);
      if (rest === 0 || scores[j] > best[rest]) { best[mask] = scores[j]; ties[mask] = 1; }
      else if (scores[j] === best[rest]) { best[mask] = best[rest]; ties[mask] = ties[rest] + 1; }
      else { best[mask] = best[rest]; ties[mask] = ties[rest]; }
    }
    let value = walkover;
    for (const s of sets) {
      if (s.mask === 0) continue;
      const share = heroScore > best[s.mask] ? 1 : heroScore === best[s.mask] ? 1 / (ties[s.mask] + 1) : 0;
      value += s.prob * (share * s.win - (1 - share) * s.lose);
    }
    sum += value; sumSq += value * value; done++;
  }
  const ev = sum / done;
  const variance = Math.max(0, sumSq / done - ev * ev);
  return {
    hand: startingHandClass(hero[0], hero[1]), depth: Math.round(depth * 100) / 100,
    decision: ev > 0 ? "shove" : "no_shove", ev, ev_bb: ev / ctx.bb, se_bb: Math.sqrt(variance / done) / ctx.bb,
    call_probs: callers, nobody_calls: nobody, bubble_factor: bf, sims: done, approximate: true,
  };
}
