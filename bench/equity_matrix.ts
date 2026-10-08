/** Preflop all-in equity between the 169 starting-hand classes, with exact card-removal counts.
 * Built with the TypeScript core (it is ~100x faster than the Python evaluator). From the project root:
 *   (cd mobile && npx esbuild ../bench/equity_matrix.ts --bundle --platform=node --format=esm --outfile=/tmp/equity_matrix.mjs)
 *   node /tmp/equity_matrix.mjs [sims-per-pair]
 * Output: bench/data/equity_matrix.json { sims, classes, counts, equity[a][b] = a's equity vs b,
 * pairs[a][b] = number of disjoint (combo of a, combo of b) pairs }. */
import { mkdirSync, writeFileSync } from "node:fs";
import { evaluate, RANKS } from "../core/src/cards.js";
import { seededRng } from "../core/src/equity.js";

type Combo = [number, number];
interface HandClass { label: string; combos: Combo[] }

function buildClasses(): HandClass[] {
  const out: HandClass[] = [];
  const card = (rank: number, suit: number) => rank * 4 + suit;
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi; lo >= 0; lo--) {
      if (hi === lo) {
        const combos: Combo[] = [];
        for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) combos.push([card(hi, s1), card(lo, s2)]);
        out.push({ label: RANKS[hi] + RANKS[lo], combos });
        continue;
      }
      const suited: Combo[] = [], offsuit: Combo[] = [];
      for (let s1 = 0; s1 < 4; s1++) {
        for (let s2 = 0; s2 < 4; s2++) (s1 === s2 ? suited : offsuit).push([card(hi, s1), card(lo, s2)]);
      }
      out.push({ label: RANKS[hi] + RANKS[lo] + "o", combos: offsuit });
      out.push({ label: RANKS[hi] + RANKS[lo] + "s", combos: suited });
    }
  }
  return out;
}

const disjoint = (x: Combo, y: Combo): boolean => x[0] !== y[0] && x[0] !== y[1] && x[1] !== y[0] && x[1] !== y[1];

const sims = Number(process.argv[2] ?? 12000);
const classes = buildClasses();
const n = classes.length;
if (n !== 169) throw new Error(`expected 169 classes, got ${n}`);
const rng = seededRng(2024);
const equity = Array.from({ length: n }, () => new Array<number>(n).fill(0.5));
const pairs = Array.from({ length: n }, () => new Array<number>(n).fill(0));

const deck = Array.from({ length: 52 }, (_, i) => i);
const cards = [0, 0, 0, 0, 0, 0, 0];
const other = [0, 0, 0, 0, 0, 0, 0];
const pool = deck.slice();
const started = Date.now();

for (let a = 0; a < n; a++) {
  for (let b = a; b < n; b++) {
    const valid: [Combo, Combo][] = [];
    for (const x of classes[a].combos) for (const y of classes[b].combos) if (disjoint(x, y)) valid.push([x, y]);
    pairs[a][b] = pairs[b][a] = valid.length;
    if (a === b || valid.length === 0) continue; // same class: symmetric, 0.5 by construction
    let share = 0;
    for (let i = 0; i < sims; i++) {
      const [x, y] = valid[Math.floor(rng.next() * valid.length)];
      // five board cards from the 48 left: partial Fisher-Yates over a pool without the four hole cards
      let m = 0;
      for (const c of deck) if (c !== x[0] && c !== x[1] && c !== y[0] && c !== y[1]) pool[m++] = c;
      for (let k = 0; k < 5; k++) {
        const j = k + Math.floor(rng.next() * (m - k));
        const t = pool[k]; pool[k] = pool[j]; pool[j] = t;
        cards[2 + k] = other[2 + k] = pool[k];
      }
      cards[0] = x[0]; cards[1] = x[1]; other[0] = y[0]; other[1] = y[1];
      const s1 = evaluate(cards, 7), s2 = evaluate(other, 7);
      share += s1 > s2 ? 1 : s1 === s2 ? 0.5 : 0;
    }
    equity[a][b] = share / sims;
    equity[b][a] = 1 - equity[a][b];
  }
  if (a % 20 === 0) console.log(`class ${a}/169  ${(Date.now() - started) / 1000}s`);
}

mkdirSync("bench/data", { recursive: true });
const out = "bench/data/equity_matrix.json";
writeFileSync(out, JSON.stringify({ sims, classes: classes.map((c) => c.label), counts: classes.map((c) => c.combos.length), equity, pairs }));
console.log(`written ${out} in ${(Date.now() - started) / 1000}s`);
