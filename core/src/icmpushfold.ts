/** Push/fold equilibrium with the ICM, for a heads-up decision inside a tournament (everybody else has folded).
 *
 * The chip-EV table (pushfold.ts) cannot cover this: with the ICM the payoffs depend on EVERY remaining stack and on
 * the payouts, so each spot is a different game and is solved here, on the device, from the class-vs-class equities.
 * Payoffs are tournament equity in prize units. Because the other players gain or lose when the two clash, the game is
 * not zero-sum; regret matching is run on each player's own payoff and the result is judged by the Nash gap: how much
 * either player would gain by deviating. A gap near zero means an equilibrium; a large one is reported, never hidden.
 * With two players left and a winner-take-all prize the ICM is linear in chips and this reduces to the chip-EV table. */
import { Card, RANKS } from "./cards.js";
import { icmEquity } from "./icm.js";
import { detectSpot, startingHandClass, type PushFoldAdvice, type SpotContext } from "./pushfold.js";

export interface EquityMatrix {
  version: number;
  scale: number; // equities are stored as integers: equity = equity_e4 / scale
  classes: string[]; // 169 labels, in the order of the matrix
  equity_e4: number[][]; // [a][b]: class a's all-in equity against class b
}

export interface IcmSpot {
  stacks: readonly number[]; // chips of everybody still in the tournament, before the blinds
  payouts: readonly number[];
  sb: number; // index of the small blind in `stacks`
  bb: number; // index of the big blind
  blind: number; // big blind in chips (the small blind is half)
}

export interface IcmSolution {
  shove: Float64Array; // per class: probability the small blind shoves
  call: Float64Array; // per class: probability the big blind calls
  gap: number; // Nash gap in prize units
  gapRelative: number; // gap / total prize pool
  iterations: number;
  classes: string[];
}

export interface IcmOptions {
  maxIterations?: number;
  tolerance?: number;
  /** Do not solve: only measure the Nash gap of these given strategies (used to check the gap itself). */
  evaluate?: { shove: ArrayLike<number>; call: ArrayLike<number> };
}
const DEFAULTS = { maxIterations: 3000, tolerance: 1e-4 }; // tolerance is relative to the prize pool
const BLOCK = 250;
export const MIN_DEPTH_BB = 2;
export const MAX_DEPTH_BB = 25;

// ---------- the 169 classes and the exact card-removal counts ----------
interface Structure {
  n: number;
  eq: Float64Array; // n*n
  joint: Float64Array; // n*n: probability that the small blind holds class a and the big blind class b
  jointEq: Float64Array; // joint * eq
  row: Float64Array; // P(small blind holds a)
}
const cache = new WeakMap<EquityMatrix, Structure>();

function combosOf(label: string): [number, number][] {
  const hi = RANKS.indexOf(label[0]), lo = RANKS.indexOf(label[1]);
  const out: [number, number][] = [];
  if (hi === lo) {
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) out.push([hi * 4 + s1, lo * 4 + s2]);
  } else {
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = 0; s2 < 4; s2++) if ((s1 === s2) === (label[2] === "s")) out.push([hi * 4 + s1, lo * 4 + s2]);
    }
  }
  return out;
}

function structureOf(m: EquityMatrix): Structure {
  const hit = cache.get(m);
  if (hit) return hit;
  const n = m.classes.length;
  const combos = m.classes.map(combosOf);
  const eq = new Float64Array(n * n), joint = new Float64Array(n * n);
  let total = 0;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      eq[a * n + b] = m.equity_e4[a][b] / m.scale;
      let pairs = 0;
      for (const x of combos[a]) for (const y of combos[b]) if (x[0] !== y[0] && x[0] !== y[1] && x[1] !== y[0] && x[1] !== y[1]) pairs++;
      joint[a * n + b] = pairs;
      total += pairs;
    }
  }
  const jointEq = new Float64Array(n * n), row = new Float64Array(n);
  for (let i = 0; i < n * n; i++) {
    joint[i] /= total;
    jointEq[i] = joint[i] * eq[i];
    row[Math.floor(i / n)] += joint[i];
  }
  const s: Structure = { n, eq, joint, jointEq, row };
  cache.set(m, s);
  return s;
}

const mulVec = (m: Float64Array, v: Float64Array, out: Float64Array, n: number) => {
  for (let a = 0; a < n; a++) { let s = 0; for (let b = 0; b < n; b++) s += m[a * n + b] * v[b]; out[a] = s; }
};
const mulVecT = (m: Float64Array, v: Float64Array, out: Float64Array, n: number) => {
  out.fill(0);
  for (let a = 0; a < n; a++) { const va = v[a]; if (va === 0) continue; for (let b = 0; b < n; b++) out[b] += m[a * n + b] * va; }
};

/** Tournament equity of the two players after each possible outcome of the hand. */
function outcomes(spot: IcmSpot) {
  const { stacks, payouts, sb, bb, blind } = spot;
  const half = blind / 2, e = Math.min(stacks[sb], stacks[bb]);
  const after = (dsb: number, dbb: number) => {
    const s = [...stacks]; s[sb] += dsb; s[bb] += dbb;
    const eq = icmEquity(s, payouts);
    return { sb: eq[sb], bb: eq[bb] };
  };
  return {
    fold: after(-half, half), // the small blind gives up the blind
    shoveFold: after(blind, -blind), // shove, the big blind folds: the small blind wins the big blind
    win: after(e, -e), // called, the small blind wins the all-in
    lose: after(-e, e),
  };
}

export function solveIcmPushFold(matrix: EquityMatrix, spot: IcmSpot, options: IcmOptions = {}): IcmSolution {
  const { maxIterations, tolerance } = { ...DEFAULTS, ...options };
  const { n, joint, jointEq, row } = structureOf(matrix);
  const o = outcomes(spot);
  const prize = spot.payouts.reduce((a, b) => a + b, 0) || 1;
  const dWinSb = o.win.sb - o.lose.sb, dWinBb = o.win.bb - o.lose.bb;

  const x = new Float64Array(n), y = new Float64Array(n);
  const rSbShove = new Float64Array(n), rSbFold = new Float64Array(n), rBbCall = new Float64Array(n), rBbFold = new Float64Array(n);
  const sumX = new Float64Array(n), sumY = new Float64Array(n);
  const py = new Float64Array(n), pey = new Float64Array(n), px = new Float64Array(n), pex = new Float64Array(n);
  const uShove = new Float64Array(n), uFold = new Float64Array(n), uCall = new Float64Array(n), uFoldB = new Float64Array(n);
  let weight = 0;

  /** Utilities of every action against the opponent's current strategy (x for the small blind, y for the big blind). */
  const utilities = (xs: Float64Array, ys: Float64Array) => {
    mulVec(joint, ys, py, n); mulVec(jointEq, ys, pey, n);
    mulVecT(joint, xs, px, n); mulVecT(jointEq, xs, pex, n);
    for (let a = 0; a < n; a++) {
      uShove[a] = o.shoveFold.sb * (row[a] - py[a]) + o.lose.sb * py[a] + dWinSb * pey[a];
      uFold[a] = o.fold.sb * row[a];
      uCall[a] = o.lose.bb * px[a] + dWinBb * pex[a];
      uFoldB[a] = o.shoveFold.bb * px[a];
    }
  };
  const nashGap = (xs: Float64Array, ys: Float64Array): number => {
    utilities(xs, ys);
    let gap = 0;
    for (let a = 0; a < n; a++) {
      gap += Math.max(uShove[a], uFold[a]) - (xs[a] * uShove[a] + (1 - xs[a]) * uFold[a]);
      gap += Math.max(uCall[a], uFoldB[a]) - (ys[a] * uCall[a] + (1 - ys[a]) * uFoldB[a]);
    }
    return gap;
  };
  const second = (r1: number, r2: number): number => (r1 + r2 > 0 ? r2 / (r1 + r2) : 0.5);

  if (options.evaluate) {
    const xs = Float64Array.from(options.evaluate.shove), ys = Float64Array.from(options.evaluate.call);
    const gap = nashGap(xs, ys);
    return { shove: xs, call: ys, gap, gapRelative: gap / prize, iterations: 0, classes: matrix.classes };
  }
  let iterations = 0;
  let result: { shove: Float64Array; call: Float64Array; gap: number } | null = null;
  while (iterations < maxIterations) {
    for (let k = 0; k < BLOCK && iterations < maxIterations; k++) {
      iterations++;
      for (let a = 0; a < n; a++) { x[a] = second(rSbFold[a], rSbShove[a]); y[a] = second(rBbFold[a], rBbCall[a]); }
      utilities(x, y);
      for (let a = 0; a < n; a++) {
        const vSb = x[a] * uShove[a] + (1 - x[a]) * uFold[a], vBb = y[a] * uCall[a] + (1 - y[a]) * uFoldB[a];
        rSbShove[a] = Math.max(rSbShove[a] + uShove[a] - vSb, 0);
        rSbFold[a] = Math.max(rSbFold[a] + uFold[a] - vSb, 0);
        rBbCall[a] = Math.max(rBbCall[a] + uCall[a] - vBb, 0);
        rBbFold[a] = Math.max(rBbFold[a] + uFoldB[a] - vBb, 0);
        sumX[a] += iterations * x[a]; sumY[a] += iterations * y[a];
      }
      weight += iterations; // linear averaging: later iterations count more
    }
    const shove = sumX.map((v) => v / weight), call = sumY.map((v) => v / weight);
    result = { shove, call, gap: nashGap(shove, call) };
    if (result.gap / prize < tolerance) break;
  }
  const r = result as { shove: Float64Array; call: Float64Array; gap: number };
  return { ...r, gapRelative: r.gap / prize, iterations, classes: matrix.classes };
}

// ---------- advice for the app ----------
export interface TournamentContext {
  stacks: readonly number[]; // hero first
  payouts: readonly number[];
  villain?: number; // index in `stacks` of the opponent in the hand; default: the largest other stack
}

export function icmPushFoldAdvice(
  matrix: EquityMatrix, hero: readonly [Card, Card], ctx: SpotContext, tournament: TournamentContext,
  opponents: number, boardCards: number, options?: IcmOptions,
): PushFoldAdvice | null {
  if (opponents !== 1 || boardCards !== 0 || ctx.structure !== "no_limit") return null;
  const { stacks } = tournament;
  if (stacks.length < 2 || !stacks.every((s) => Number.isFinite(s) && s > 0)) return null;
  let villain = tournament.villain;
  if (villain === undefined) {
    villain = 1;
    for (let i = 2; i < stacks.length; i++) if (stacks[i] > stacks[villain]) villain = i;
  }
  if (!Number.isInteger(villain) || villain < 1 || villain >= stacks.length) return null;
  const spot = detectSpot(ctx);
  if (!spot) return null;
  const heroIsSb = spot.role === "small_blind";
  const depth = Math.min(stacks[0], stacks[villain]) / ctx.bb;
  if (!(depth >= MIN_DEPTH_BB && depth <= MAX_DEPTH_BB)) return null;
  const solution = solveIcmPushFold(matrix, {
    stacks, payouts: tournament.payouts, sb: heroIsSb ? 0 : villain, bb: heroIsSb ? villain : 0, blind: ctx.bb,
  }, options);
  const hand = startingHandClass(hero[0], hero[1]);
  const col = solution.classes.indexOf(hand);
  if (col < 0) return null;
  const probability = (heroIsSb ? solution.shove : solution.call)[col];
  const act = probability >= 0.5;
  return {
    role: spot.role, hand, depth: Math.round(depth * 100) / 100, probability,
    decision: heroIsSb ? (act ? "shove" : "fold") : (act ? "call" : "fold"),
    icm: true, gap: solution.gapRelative,
  };
}
