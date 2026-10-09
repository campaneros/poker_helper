/** Monte Carlo equity vs range-weighted opponents, plus hero hand-category odds.
 * Same algorithm as the Python reference; the RNG differs, so results match statistically, not bit for bit. */
import { Card, DECK, evaluate, handClass } from "./cards.js";
import { inRange, madeHandPct } from "./ranges.js";

export interface Rng { next(): number } // uniform in [0, 1)

/** mulberry32: tiny, fast, seedable. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

const CLASS_NAMES: Record<number, string> = {
  1: "Scala colore", 2: "Poker", 3: "Full", 4: "Colore", 5: "Scala",
  6: "Tris", 7: "Doppia coppia", 8: "Coppia", 9: "Carta alta",
};

const REJECTION_TRIES = 40;

/** An opponent range with explicit weights over holdings (indexed by pairKey, sums to 1). */
export interface WeightedRange { weights: Float64Array }
/** Either a top-fraction range (legacy) or an explicit weighted range (posterior / known cards). */
export type OppSpec = number | WeightedRange;

export interface Sampler { a: number[]; b: number[]; cum: number[]; total: number }

export function makeSampler(w: Float64Array): Sampler {
  const s: Sampler = { a: [], b: [], cum: [], total: 0 };
  for (let x = 0; x < 52; x++) {
    for (let y = x + 1; y < 52; y++) {
      const v = w[x * 52 + y];
      if (v > 0) { s.a.push(x); s.b.push(y); s.total += v; s.cum.push(s.total); }
    }
  }
  return s;
}

/** Draw a holding proportionally to its weight, avoiding cards already used; null if none is free. */
export function drawWeighted(s: Sampler, rng: Rng, used: Uint8Array): [Card, Card] | null {
  const n = s.cum.length;
  if (!n) return null;
  for (let t = 0; t < REJECTION_TRIES; t++) {
    const u = rng.next() * s.total;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.cum[mid] > u) hi = mid; else lo = mid + 1; }
    if (!used[s.a[lo]] && !used[s.b[lo]]) return [s.a[lo], s.b[lo]];
  }
  const start = Math.floor(rng.next() * n);
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!used[s.a[i]] && !used[s.b[i]]) return [s.a[i], s.b[i]];
  }
  return null;
}

export interface SimResult {
  equity: number;
  win: number;
  sims: number;
  categories: Record<string, number>;
}

export interface SimOptions {
  nSims?: number; budgetMs?: number; rng?: Rng; now?: () => number;
  dead?: readonly Card[]; // cards seen but out of play: removed from the deck (never dealt to anyone)
}

export function simulate(
  hero: readonly Card[], board: readonly Card[], oppFracs: readonly OppSpec[], opts: SimOptions = {},
): SimResult {
  const { nSims = 30000, budgetMs = 800, rng = seededRng(Date.now()), now = () => performance.now() } = opts;
  const known = new Set<Card>([...hero, ...board, ...(opts.dead ?? [])]);
  const deck = DECK.filter((c) => !known.has(c));
  const need = 5 - board.length;
  const made = board.length >= 3 && oppFracs.some((f) => typeof f === "number" && f < 1.0) ? madeHandPct(deck, board) : null;
  const samplers = oppFracs.map((f) => (typeof f === "number" ? null : makeSampler(f.weights)));
  // weighted ranges first: their cards are then marked used before the fraction-based opponents draw
  const order = oppFracs.map((_, i) => i).sort((x, y) => (samplers[x] ? 0 : 1) - (samplers[y] ? 0 : 1));
  const pick = (): Card => deck[Math.floor(rng.next() * deck.length)];
  const used = new Uint8Array(52);
  const full: Card[] = [...board, 0, 0, 0, 0, 0].slice(0, 5);
  const heroCards: Card[] = [hero[0], hero[1], 0, 0, 0, 0, 0];
  const oppCards: Card[] = [0, 0, 0, 0, 0, 0, 0];
  const cats = Array<number>(10).fill(0);
  let shareTotal = 0, wins = 0, done = 0;
  const start = now();

  for (let i = 0; i < nSims; i++) {
    if (i && i % 200 === 0 && now() - start > budgetMs) break;
    used.fill(0);
    const hands: [Card, Card][] = [];
    for (const idx of order) {
      const frac = oppFracs[idx];
      const sampler = samplers[idx];
      let h: [Card, Card] | null = sampler ? drawWeighted(sampler, rng, used) : null;
      for (let t = 0; typeof frac === "number" && t < REJECTION_TRIES && !h; t++) {
        const a = pick(), b = pick();
        if (a === b || used[a] || used[b]) continue;
        if (inRange(a, b, frac, made)) h = [a, b];
      }
      while (!h) { // range too narrow for the remaining deck: fall back to any free hand
        const a = pick(), b = pick();
        if (a !== b && !used[a] && !used[b]) h = [a, b];
      }
      used[h[0]] = 1; used[h[1]] = 1;
      hands.push(h);
    }
    for (let k = 0; k < need;) {
      const c = pick();
      if (!used[c]) { used[c] = 1; full[board.length + k] = c; k++; }
    }
    for (let k = 0; k < 5; k++) heroCards[2 + k] = full[k];
    const heroScore = evaluate(heroCards, 7);
    cats[handClass(heroScore)]++;
    let best = -1, ties = 0;
    for (const h of hands) {
      oppCards[0] = h[0]; oppCards[1] = h[1];
      for (let k = 0; k < 5; k++) oppCards[2 + k] = full[k];
      const s = evaluate(oppCards, 7);
      if (s > best) { best = s; ties = 1; } else if (s === best) ties++;
    }
    if (heroScore > best) { shareTotal += 1; wins++; } else if (heroScore === best) shareTotal += 1 / (ties + 1);
    done++;
  }
  const categories: Record<string, number> = {};
  for (let k = 1; k <= 9; k++) categories[CLASS_NAMES[k]] = cats[k] / done;
  return { equity: shareTotal / done, win: wins / done, sims: done, categories };
}
