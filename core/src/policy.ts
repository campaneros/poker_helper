/** State, feature encoding, the EV-based teacher policy, and opponent-stat formulas.
 * Field names are snake_case on purpose: they mirror the Python reference and the golden vectors. */

export const SIZES = [0.33, 0.5, 0.75, 1.0, 1.5] as const; // bet size as fraction of (pot + call)
export const FOLD_OR_CHECK = 0, CALL = 1, RAISE = 2;
export const N_FEATURES = 21;
const TEMPERATURE = 0.08; // softmax temperature, in units of pot

export interface State {
  equity: number;
  pot: number; // chips in the middle, including opponents' current bets
  to_call: number;
  stack: number; // hero chips behind
  bb: number;
  n_opp: number;
  street: number; // 0 pre, 1 flop, 2 turn, 3 river
  position: number; // 0 = first to act ... 1 = button
  opp_range: number; // mean top-fraction of opponents' ranges
  opp_aggr: number; // mean aggression factor
  bf: number; // ICM bubble factor (1 = cash game)
  pot_limit: boolean;
  opp_ranges: readonly number[]; // per opponent; [] = use opp_range for all
  opp_aggrs: readonly number[];
  opp_folds: readonly number[]; // per-opponent fold-to-bet; [] = derived from the ranges
}

export type TeacherResult = { evs: [number, number, number]; size_frac: number };

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export function defaultFolds(s: State): number[] {
  const ranges = s.opp_ranges.length ? s.opp_ranges : Array<number>(Math.max(s.n_opp, 1)).fill(s.opp_range);
  return ranges.map((r) => 0.42 * (1 - r));
}

export function features(s: State): number[] {
  const stack = Math.max(s.stack, 1e-9);
  const pot = Math.max(s.pot, 1e-9);
  const street = [0, 1, 2, 3].map((i) => (s.street === i ? 1 : 0));
  const tightest = s.opp_ranges.length ? Math.min(...s.opp_ranges) : s.opp_range;
  const wildest = s.opp_aggrs.length ? Math.max(...s.opp_aggrs) : s.opp_aggr;
  const folds = s.opp_folds.length ? s.opp_folds : defaultFolds(s);
  return [
    s.equity,
    s.to_call / (pot + s.to_call),
    Math.min(stack / pot, 20) / 20,
    Math.min(s.to_call / stack, 1.0),
    Math.min(pot / s.bb, 200) / 200,
    Math.min(stack / s.bb, 200) / 200,
    s.n_opp / 8,
    ...street,
    s.position,
    s.opp_range,
    Math.min(s.opp_aggr, 5) / 5,
    (s.bf - 1) / 3,
    s.pot_limit ? 1 : 0,
    s.to_call <= 0 ? 1 : 0,
    tightest,
    Math.min(wildest, 5) / 5,
    sum(folds) / folds.length,
    Math.min(...folds),
  ];
}

/** Chips added on top of the call for a raise of `frac` x (pot + call). */
export function betAmount(s: State, frac: number): number {
  const call = Math.min(s.to_call, s.stack);
  let b = frac * (s.pot + call);
  if (s.pot_limit) b = Math.min(b, s.pot + call);
  return Math.max(Math.min(b, s.stack - call), Math.min(s.bb, s.stack - call));
}

export function actionMask(s: State): [boolean, boolean, boolean] {
  return [true, s.to_call > 0, s.stack > Math.min(s.to_call, s.stack)];
}

/** EV (chips, relative to folding) of each action; picks the best raise size. */
export function teacher(s: State): TeacherResult {
  const call = Math.min(s.to_call, s.stack);
  const eq = s.equity * (0.9 + 0.1 * s.position); // position realization
  const m = s.bf;
  let ev0: number, evCall: number;
  if (call > 0) {
    ev0 = 0;
    evCall = eq * (s.pot + call) - m * call;
  } else {
    ev0 = eq * s.pot;
    evCall = -Infinity;
  }
  let evRaise = -Infinity, bestFrac: number = SIZES[1];
  const folds = s.opp_folds.length ? s.opp_folds : defaultFolds(s);
  if (actionMask(s)[RAISE]) {
    for (const f of SIZES) {
      if (s.pot_limit && f > 1.0) continue;
      const b = betAmount(s, f);
      const eff = s.pot + call > 0 ? b / (s.pot + call) : f;
      const sizeFactor = eff / (eff + 0.6) / 0.524; // 1.0 at a 2/3-pot bet
      let fe = 1.0; // everybody must fold: product of each opponent's own fold chance
      for (const fold of folds) fe *= Math.max(0.0, Math.min(0.85, fold * sizeFactor));
      const ev = fe * s.pot + (1 - fe) * (eq * (s.pot + call + 2 * b) - m * (call + b));
      if (ev > evRaise) { evRaise = ev; bestFrac = f; }
    }
  }
  return { evs: [ev0, evCall, evRaise], size_frac: bestFrac };
}

export function teacherProbs(evs: readonly number[], mask: readonly boolean[], pot: number): number[] {
  const t = Math.max(TEMPERATURE * pot, 1e-9);
  const valid = evs.map((e, i) => (mask[i] ? e / t : -Infinity));
  const top = Math.max(...valid);
  const exps = valid.map((v) => (v > -Infinity ? Math.exp(v - top) : 0));
  const z = sum(exps);
  return exps.map((e) => e / z);
}

// ---------- opponent stats ----------
export interface OppStats { vpip: number; pfr: number; af: number; ftb?: number } // ftb: observed fold-to-bet
export const PRIOR: OppStats = { vpip: 0.28, pfr: 0.15, af: 1.5 };
export type OppAction = "none" | "call" | "bet" | "raise";

/** How often this player folds to a ~2/3-pot bet, estimated from VPIP and aggression. */
export const foldToBet = (st: OppStats): number =>
  st.ftb ?? Math.max(0.03, Math.min(0.8, 0.52 - 0.75 * st.vpip - 0.02 * st.af)); // average player ~0.28

/** Top-fraction of starting hands this opponent plausibly holds given their action. */
export function rangeFraction(st: OppStats, street: number, action: OppAction, betFrac = 0.6): number {
  let f: number;
  if (action === "none") f = street === 0 ? st.vpip : Math.min(1.0, st.vpip * 1.4);
  else if (action === "call") f = st.vpip * 0.85;
  else {
    const base = street === 0 ? st.pfr : st.pfr + (st.vpip - st.pfr) * 0.4;
    f = base * (1.2 - 0.35 * Math.min(betFrac, 1.5)) * (0.8 + 0.1 * Math.min(st.af, 4));
  }
  return Math.max(0.04, Math.min(1.0, f));
}
