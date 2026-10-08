/** Parity of the TypeScript core with the Python reference, using the frozen golden vectors.
 * Decisions must be identical ("zero different choices"); floating-point values within stated tolerances. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advise, argmax, forward, label, predict, type Weights } from "../src/advisor.js";
import { evaluate, fromTreys, handClass, parse } from "../src/cards.js";
import { seededRng, simulate } from "../src/equity.js";
import { bubbleFactor, icmEquity } from "../src/icm.js";
import { actionMask, features, teacher, teacherProbs, type State } from "../src/policy.js";
import { handPct } from "../src/ranges.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const V = read("../../tests/golden/vectors.json");
const W = read("../weights.json") as Weights;

const FLOAT64 = 1e-9; // same IEEE doubles as Python; only exp() may differ in the last bit
const FLOAT32 = 1e-4; // the Python net runs in float32, the core in float64
const nums = (xs: (number | null)[]) => xs.map((x) => (x === null ? -Infinity : x));
const close = (a: number[], b: number[], tol: number) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => (x === b[i] ? undefined : expect(Math.abs(x - b[i])).toBeLessThan(tol)));
};
const states: State[] = V.teacher.map((c: { state: State }) => c.state);

describe("weights", () => {
  it("are exactly the ones the vectors were generated with", () => {
    expect(W.sha256).toBe(V.weights_sha256);
  });
});

describe("teacher policy", () => {
  it("features, EVs, probabilities and size match the reference", () => {
    V.teacher.forEach((c: any, i: number) => {
      const s = states[i];
      close(features(s), c.features, FLOAT64);
      const t = teacher(s);
      close(t.evs, nums(c.evs), FLOAT64);
      expect(t.size_frac).toBe(c.size_frac);
      close(teacherProbs(t.evs, actionMask(s), s.pot), c.probs, FLOAT64);
    });
  });
});

describe("network", () => {
  it("forward pass matches float32 torch within tolerance", () => {
    for (const c of V.mlp) {
      const { logits, size } = forward(W, c.features);
      close(logits, c.logits, FLOAT32);
      expect(Math.abs(size - c.size)).toBeLessThan(FLOAT32);
    }
  });

  it("makes the identical decision (class, action, amount) on every vector", () => {
    const mismatches: string[] = [];
    V.predict.forEach((p: any, i: number) => {
      const s = states[i];
      const pred = predict(s, W);
      close(pred.probs, p.probs, FLOAT32);
      const cls = argmax(pred.probs);
      const [action, amount] = label(s, cls, pred.size_frac);
      if (cls !== argmax(p.probs) || action !== p.action || Math.abs(amount - p.amount) > 1e-9) {
        mismatches.push(`#${i}: ts=${action} ${amount} py=${p.action} ${p.amount}`);
      }
    });
    expect(mismatches).toEqual([]);
  });
});

describe("hand evaluator", () => {
  it("orders 7-card hands exactly like treys and reports the same class", () => {
    const bad: number[] = [];
    V.eval.forEach((c: any, i: number) => {
      const a = c.a.map(parse), b = c.b.map(parse);
      const sa = evaluate(a), sb = evaluate(b);
      if (Math.sign(sa - sb) !== c.cmp || handClass(sa) !== c.class_a) bad.push(i);
    });
    expect(bad).toEqual([]);
  });
});

describe("action labelling", () => {
  it("amounts match Python's round-half-to-even, including exact .5 cases and the all-in threshold", () => {
    const bad: string[] = [];
    V.label.forEach((c: any, i: number) => {
      const [action, amount] = label(c.state, 2, c.frac);
      if (action !== c.action || amount !== c.amount) bad.push(`#${i}: ts=${action} ${amount} py=${c.action} ${c.amount}`);
    });
    expect(bad).toEqual([]);
  });
});

describe("ICM", () => {
  it("equities and bubble factors match to 1e-9", () => {
    for (const c of V.icm) {
      close(icmEquity(c.stacks, c.payouts), c.equity, FLOAT64);
      expect(Math.abs(bubbleFactor(c.stacks, c.payouts, 0, c.risk) - c.bf)).toBeLessThan(FLOAT64);
    }
  });
});

describe("range percentiles", () => {
  it("match the Chen-score table", () => {
    for (const c of V.range) {
      expect(Math.abs(handPct(fromTreys(c.cards[0]), fromTreys(c.cards[1])) - c.pct)).toBeLessThan(1e-12);
    }
  });
});

describe("Monte Carlo equity", () => {
  it("agrees with the reference within statistical error (different RNG)", () => {
    for (const c of V.equity) {
      const r = simulate(c.hero.map(parse), c.board.map(parse), c.fracs, {
        nSims: c.n_sims, budgetMs: 1e9, rng: seededRng(c.seed),
      });
      const tol = (p: number) => 4 * Math.sqrt((2 * p * (1 - p)) / c.n_sims) + 1e-3;
      expect(Math.abs(r.equity - c.equity), `${c.hero} ${c.board}`).toBeLessThan(tol(c.equity));
      for (const [name, p] of Object.entries(c.categories as Record<string, number>)) {
        expect(Math.abs(r.categories[name] - p), `${c.hero} ${c.board} ${name}`).toBeLessThan(tol(p));
      }
    }
  });

  it("is deterministic for a given seed", () => {
    const run = () => simulate([parse("Ah"), parse("Kh")], [], [0.3, 0.5], { nSims: 3000, budgetMs: 1e9, rng: seededRng(7) });
    expect(run()).toEqual(run());
  });

  it("6-max, range-filtered, postflop stays well under a second", () => {
    const t = performance.now();
    simulate([parse("Ah"), parse("Kh")], ["2h", "7h", "Jc"].map(parse), [0.2, 0.3, 0.4, 0.15, 0.5], { nSims: 30000, budgetMs: 1e9 });
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("advise (end to end)", () => {
  it("AA facing a raise at 6-max raises", () => {
    const r = advise({
      hero: ["Ah", "As"], board: [], structure: "no_limit", bb: 2, pot: 6, to_call: 4, stack: 200, position: 0.8,
      opponents: [{ action: "raise" }], budgetMs: 500,
    }, W, seededRng(1));
    expect(["raise", "all-in"]).toContain(r.advice.action);
  });

  it("rejects duplicate cards and malformed boards", () => {
    const base = { structure: "no_limit" as const, bb: 2, pot: 6, to_call: 0, stack: 200, position: 0.5, opponents: [{}] };
    expect(() => advise({ ...base, hero: ["Ah", "Ah"], board: [] }, W)).toThrow();
    expect(() => advise({ ...base, hero: ["Ah", "Kh"], board: ["2c", "3c"] }, W)).toThrow();
  });
});
