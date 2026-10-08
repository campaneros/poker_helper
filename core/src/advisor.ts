/** MLP inference, masked prediction, action labelling and the end-to-end `advise` entry point. */
import { parse } from "./cards.js";
import { simulate, type OppSpec, type Rng, type SimResult } from "./equity.js";
import { bubbleFactor } from "./icm.js";
import {
  CALL, PRIOR, RAISE, SIZES, actionMask, betAmount, features, foldToBet, rangeFraction, teacher, teacherProbs,
  type OppAction, type OppStats, type State, type TeacherResult,
} from "./policy.js";
import { buildPosterior, effectiveFraction, fractionRange, topClasses, type ActionRecord } from "./range.js";

export interface Weights {
  sha256: string;
  n_features: number;
  layers: { w: number[][]; b: number[] }[]; // body.0, body.2, head
}

const SIZE_LO = SIZES[0];
const SIZE_HI = SIZES[SIZES.length - 1];

const dense = (w: number[][], b: number[], x: readonly number[]): number[] =>
  w.map((row, i) => row.reduce((acc, wij, j) => acc + wij * x[j], b[i]));
const relu = (xs: number[]): number[] => xs.map((v) => (v > 0 ? v : 0));

export function forward(weights: Weights, x: readonly number[]): { logits: number[]; size: number } {
  const [l0, l1, head] = weights.layers;
  const out = dense(head.w, head.b, relu(dense(l1.w, l1.b, relu(dense(l0.w, l0.b, x)))));
  return { logits: out.slice(0, 3), size: SIZE_LO + (SIZE_HI - SIZE_LO) / (1 + Math.exp(-out[3])) };
}

export interface Prediction {
  probs: number[];
  size_frac: number;
  source: "net" | "teacher";
  teacher: TeacherResult;
}

/** Network probabilities (masked) + size; falls back to the teacher if no weights are given. */
export function predict(s: State, weights?: Weights): Prediction {
  const t = teacher(s);
  const mask = actionMask(s);
  if (!weights) return { probs: teacherProbs(t.evs, mask, s.pot), size_frac: t.size_frac, source: "teacher", teacher: t };
  const { logits, size } = forward(weights, features(s));
  const masked = logits.map((l, i) => (mask[i] ? l : -1e9));
  const top = Math.max(...masked);
  const exps = masked.map((l) => Math.exp(l - top));
  const z = exps.reduce((a, b) => a + b, 0);
  return { probs: exps.map((e) => e / z), size_frac: size, source: "net", teacher: t };
}

/** Python's round(): halves go to the even neighbour. Amounts must match the reference exactly. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export function label(s: State, cls: number, frac: number): [string, number] {
  const call = Math.min(s.to_call, s.stack);
  if (cls === RAISE) {
    const total = call + betAmount(s, frac);
    if (total >= s.stack * 0.9) return ["all-in", s.stack];
    return [s.to_call > 0 ? "raise" : "bet", roundHalfEven(total)];
  }
  if (cls === CALL) return ["call", call];
  return [s.to_call > 0 ? "fold" : "check", 0];
}

export const argmax = (xs: readonly number[]): number => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

// ---------- end to end ----------
export interface OppInput {
  stats?: Partial<OppStats>;
  action?: OppAction; // last action only (quick mode); superseded by `actions` when given
  bet_frac?: number;
  known?: string[]; // cards this opponent showed (one or two)
  actions?: ActionRecord[]; // what this opponent did in the current hand, in order
}

export interface AdviseRequest {
  hero: [string, string];
  board: string[];
  structure: "no_limit" | "pot_limit";
  bb: number;
  pot: number;
  to_call: number;
  stack: number;
  position: number;
  opponents: OppInput[];
  dead?: string[]; // cards seen but out of play (mucked, flashed)
  tournament?: { stacks: number[]; payouts: number[] };
  budgetMs?: number;
}

export interface AdviseResult extends SimResult {
  advice: {
    action: string;
    amount: number;
    probs: { fold_check: number; call: number; raise: number };
    evs: (number | null)[];
    source: "net" | "teacher";
    bubble_factor: number;
  };
  opponents: { range_pct: number; top: { hand: string; pct: number }[]; contradiction?: boolean }[];
}

const STREET_BY_BOARD: Record<number, number> = { 0: 0, 3: 1, 4: 2, 5: 3 };

export function advise(req: AdviseRequest, weights?: Weights, rng?: Rng): AdviseResult {
  const hero = req.hero.map(parse);
  const board = req.board.map(parse);
  const street = STREET_BY_BOARD[board.length];
  if (street === undefined || hero.length !== 2) throw new Error("servono 2 carte hero e board di 0, 3, 4 o 5 carte");
  if (new Set([...hero, ...board]).size !== hero.length + board.length) throw new Error("carte duplicate");

  const deadCards = (req.dead ?? []).map(parse);
  const knownBy = req.opponents.map((o) => (o.known ?? []).map(parse));
  if (knownBy.some((k) => k.length > 2)) throw new Error("al massimo due carte mostrate per avversario");
  const everyCard = [...hero, ...board, ...deadCards, ...knownBy.flat()];
  if (new Set(everyCard).size !== everyCard.length) throw new Error("carte duplicate");
  const table = new Set([...hero, ...board, ...deadCards]);

  const fracs: number[] = [], aggrs: number[] = [], folds: number[] = [];
  const specs: OppSpec[] = [], tops: { hand: string; pct: number }[][] = [], contradictions: boolean[] = [];
  req.opponents.forEach((o, i) => {
    const st = { ...PRIOR, ...o.stats };
    st.pfr = Math.min(st.pfr, st.vpip);
    const blocked = new Set([...table, ...knownBy.filter((_, j) => j !== i).flat()]);
    let frac: number, spec: OppSpec, shape: Float64Array, contradiction = false;
    if (o.actions?.length || knownBy[i].length) { // posterior from this hand's actions and any shown cards
      const post = buildPosterior({ stats: st, actions: o.actions ?? [], board, dead: blocked, known: knownBy[i] });
      frac = effectiveFraction(post.weights, post.live);
      spec = { weights: post.weights };
      shape = post.weights;
      contradiction = post.contradiction;
    } else { // quick mode: a top-fraction range from the last action
      frac = rangeFraction(st, street, o.action ?? "none", o.bet_frac ?? 0.6);
      spec = frac;
      shape = fractionRange(frac, board, blocked);
    }
    fracs.push(frac); specs.push(spec); contradictions.push(contradiction);
    tops.push(topClasses(shape));
    aggrs.push(st.af);
    folds.push(foldToBet(st));
  });
  const sim = simulate(hero, board, specs, {
    budgetMs: req.budgetMs ?? 800, rng, dead: [...deadCards, ...knownBy.flat()],
  });
  const t = req.tournament;
  const bf = t ? bubbleFactor(t.stacks, t.payouts, 0, Math.min(req.to_call, req.stack) || req.stack) : 1;
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const s: State = {
    equity: sim.equity, pot: req.pot, to_call: req.to_call, stack: req.stack, bb: req.bb,
    n_opp: fracs.length, street, position: req.position, opp_range: mean(fracs), opp_aggr: mean(aggrs), bf,
    pot_limit: req.structure === "pot_limit", opp_ranges: fracs, opp_aggrs: aggrs, opp_folds: folds,
  };
  const pred = predict(s, weights);
  const [action, amount] = label(s, argmax(pred.probs), pred.size_frac);
  return {
    ...sim,
    advice: {
      action, amount,
      probs: { fold_check: pred.probs[0], call: pred.probs[1], raise: pred.probs[2] },
      evs: pred.teacher.evs.map((e) => (Number.isFinite(e) ? e : null)),
      source: pred.source, bubble_factor: bf,
    },
    opponents: fracs.map((f, i) => ({
      range_pct: Math.round(f * 1000) / 10, top: tops[i], ...(contradictions[i] ? { contradiction: true } : {}),
    })),
  };
}
