/** Multiway open-shove layer. No oracle exists for the spot, so it is checked three ways: against an independent
 * computation built from the already-tested equity code, against closed-form limits, and by monotonicity invariants. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advise } from "../src/advisor.js";
import { parse } from "../src/cards.js";
import { seededRng, simulate } from "../src/equity.js";
import {
  callFraction, callRange, multiwayPushAdvice, nashCallWidth, type MultiwayOpp,
} from "../src/multiway.js";
import { priorRange } from "../src/range.js";
import { startingHandClass, type PushFoldTable, type SpotContext } from "../src/pushfold.js";

const table = JSON.parse(readFileSync(new URL("../pushfold.json", import.meta.url), "utf8")) as PushFoldTable;
const hand = (a: string, b: string): [number, number] => [parse(a), parse(b)];

/** Small blind (blinds 1/2, so bb = 2) with `bbs` big blinds behind; the table's pot is blinds only. */
const spot = (bbs: number, extra: Partial<SpotContext> = {}): SpotContext =>
  ({ bb: 2, pot: 3, to_call: 1, stack: bbs * 2, structure: "no_limit", tournament: false, ...extra });
const players = (n: number, vpip?: number): MultiwayOpp[] =>
  Array.from({ length: n }, () => (vpip === undefined ? {} : { stats: { vpip } }));
const run = (h: [number, number], bbs: number, opps: MultiwayOpp[], seed = 1, nSims = 20000) =>
  multiwayPushAdvice(table, h, spot(bbs), opps, 0, [], undefined, { rng: seededRng(seed), nSims, budgetMs: 60_000 });

describe("which spots it covers", () => {
  const h = hand("As", "Ah");
  it("answers the open shove with two or more opponents, preflop, up to 15 bb", () => {
    expect(run(h, 10, players(2), 1, 2000)).not.toBeNull();
    expect(run(h, 15, players(4), 1, 2000)).not.toBeNull();
    expect(run(h, 2, players(3), 1, 2000)).not.toBeNull();
  });
  it("stays silent everywhere else", () => {
    const go = (ctx: SpotContext, opps = players(3), board = 0) =>
      multiwayPushAdvice(table, h, ctx, opps, board, [], undefined, { rng: seededRng(1), nSims: 500 });
    expect(go(spot(10), players(1))).toBeNull(); // heads-up belongs to the exact Nash table
    expect(go(spot(10), [])).toBeNull();
    expect(go(spot(10), players(9))).toBeNull();
    expect(go(spot(10), players(3), 3)).toBeNull(); // postflop
    expect(go(spot(16))).toBeNull(); // too deep
    expect(go(spot(1.9))).toBeNull(); // too shallow
    expect(go(spot(10, { to_call: 0 }))).toBeNull(); // checking is free: not a shove-or-fold spot
    expect(go(spot(10, { to_call: 6, pot: 9 }))).toBeNull(); // facing a raise
    expect(go(spot(10, { structure: "pot_limit" }))).toBeNull();
    expect(go(spot(10), [{ known: [parse("2c"), parse("3c"), parse("4c")] }, {}])).toBeNull();
  });
});

describe("the calling width", () => {
  it("is the heads-up Nash width at 9 bb (about 43%) and shrinks with depth", () => {
    expect(nashCallWidth(table, 9)!).toBeGreaterThan(0.4);
    expect(nashCallWidth(table, 9)!).toBeLessThan(0.45);
    expect(nashCallWidth(table, 15)!).toBeLessThan(nashCallWidth(table, 6)!);
  });
  it("tightens with the number of opponents and follows the player's style", () => {
    const base = 0.4;
    expect(callFraction(base, 2)).toBeGreaterThan(callFraction(base, 3));
    expect(callFraction(base, 3)).toBeGreaterThan(callFraction(base, 6));
    expect(callFraction(base, 3, 0.5)).toBeGreaterThan(callFraction(base, 3, 0.28));
    expect(callFraction(base, 3, 0.1)).toBeLessThan(callFraction(base, 3, 0.28));
    expect(callFraction(0.9, 2, 0.6)).toBeLessThanOrEqual(0.8); // never "calls everything"
    expect(callFraction(0.001, 6, 0.1)).toBeGreaterThanOrEqual(0.03);
  });
});

describe("the EV against an independent computation", () => {
  const h = hand("Ks", "Qd");
  const bbs = 8, stack = bbs * 2, pot = 3;
  // two opponents with known calling ranges; the equity of each set of callers comes from simulate()
  it("matches the sum over caller sets priced with simulate()", () => {
    const base = nashCallWidth(table, bbs)!;
    const frac = callFraction(base, 2);
    const blocked = new Set(h);
    const r = callRange(frac, blocked, []);
    const p = r.prob;
    const eqOne = simulate(h, [], [{ weights: r.weights }], { nSims: 40000, budgetMs: 60_000, rng: seededRng(7) }).equity;
    const eqTwo = simulate(h, [], [{ weights: r.weights }, { weights: r.weights }], { nSims: 40000, budgetMs: 60_000, rng: seededRng(8) }).equity;
    const expected = (1 - p) ** 2 * pot
      + 2 * p * (1 - p) * (eqOne * (pot + 2 * stack) - stack)
      + p * p * (eqTwo * (pot + 3 * stack) - stack);
    const got = run(h, bbs, players(2), 3, 40000)!;
    expect(got.call_probs[0]).toBeCloseTo(p, 10);
    expect(Math.abs(got.ev - expected)).toBeLessThan(0.05 * 2); // 0.05 bb
  });

  it("reduces to the heads-up formula when the second opponent can never call", () => {
    const base = nashCallWidth(table, bbs)!;
    const frac = callFraction(base, 2);
    const sleeper = [parse("7c"), parse("2d")]; // 72o: far outside any calling range
    const r = callRange(frac, new Set([...h, ...sleeper]), []);
    const eq = simulate(h, [], [{ weights: r.weights }], {
      nSims: 60000, budgetMs: 60_000, rng: seededRng(5), dead: sleeper,
    }).equity;
    const expected = (1 - r.prob) * pot + r.prob * (eq * (pot + 2 * stack) - stack);
    const got = multiwayPushAdvice(table, h, spot(bbs), [{}, { known: sleeper }], 0, [], undefined,
      { rng: seededRng(9), nSims: 60000, budgetMs: 60_000 })!;
    expect(got.call_probs[1]).toBe(0);
    expect(Math.abs(got.ev - expected)).toBeLessThan(0.05 * 2);
  });

  it("is exactly the pot when nobody can call, and loses the stack when called by a better hand", () => {
    const a = parse("7c"), b = parse("2d"), c = parse("8h"), d = parse("3s");
    const walk = multiwayPushAdvice(table, h, spot(bbs), [{ known: [a, b] }, { known: [c, d] }], 0, [], undefined,
      { rng: seededRng(2), nSims: 2000 })!;
    expect(walk.nobody_calls).toBe(1);
    expect(walk.ev).toBeCloseTo(pot, 10);
    expect(walk.decision).toBe("shove");
    // two aces that certainly call against 32o: the shove is a coin flip dominated, EV must be negative
    const trap = multiwayPushAdvice(table, hand("3s", "2c"), spot(bbs),
      [{ known: [parse("As"), parse("Ah")] }, { known: [parse("Ks"), parse("Kh")] }], 0, [], undefined,
      { rng: seededRng(2), nSims: 4000 })!;
    expect(trap.call_probs).toEqual([1, 1]);
    expect(trap.ev).toBeLessThan(-0.5 * stack);
    expect(trap.decision).toBe("no_shove");
  });
});

describe("showdowns between known hands", () => {
  // all three players are known and certain to call, so the EV is a closed form around simulate()'s equity
  const threeWay = (heroCards: [number, number], a: [number, number], b: [number, number]) => {
    const bbs = 8, stack = bbs * 2, pot = 3;
    const eq = simulate(heroCards, [], [
      { weights: priorRange(new Set([...heroCards, ...a, ...b].filter((c) => !a.includes(c))), a) },
      { weights: priorRange(new Set([...heroCards, ...a, ...b].filter((c) => !b.includes(c))), b) },
    ], { nSims: 120000, budgetMs: 60_000, rng: seededRng(21) }).equity;
    const got = multiwayPushAdvice(table, heroCards, spot(bbs), [{ known: a }, { known: b }], 0, [], undefined,
      { rng: seededRng(22), nSims: 120000, budgetMs: 60_000 })!;
    expect(got.call_probs).toEqual([1, 1]);
    return { got, expected: eq * (pot + 3 * stack) - stack, eq };
  };
  it("splits the pot evenly among identical hands (ties among the opponents count)", () => {
    const { got, expected, eq } = threeWay(hand("Ah", "Kh"), hand("Ac", "Kc"), hand("Ad", "Kd"));
    expect(eq).toBeGreaterThan(0.3); // flushes aside, the pot is split three ways
    expect(eq).toBeLessThan(0.36);
    expect(Math.abs(got.ev - expected)).toBeLessThan(0.1);
  });
  it("never deals an opponent's shown card to the board", () => {
    const { got, expected } = threeWay(hand("Kh", "Ks"), hand("As", "Ah"), hand("Ad", "Ac"));
    expect(Math.abs(got.ev - expected)).toBeLessThan(0.1);
  });
});

describe("invariants", () => {
  const shoveSet = (bbs: number, n: number, vpip?: number): Set<string> => {
    const out = new Set<string>();
    const seen = new Set<string>();
    const ranks = "AKQJT98765432";
    for (let i = 0; i < 13; i++) {
      for (let j = i; j < 13; j++) {
        for (const suited of i === j ? [false] : [false, true]) {
          const a = parse(ranks[i] + "s"), b = parse(ranks[j] + (suited ? "s" : "h"));
          const label = startingHandClass(a, b);
          if (seen.has(label)) continue;
          seen.add(label);
          if (run([a, b], bbs, players(n, vpip), 11, 3000)!.decision === "shove") out.add(label);
        }
      }
    }
    return out;
  };
  const wider = (small: Set<string>, big: Set<string>): string[] => [...big].filter((x) => !small.has(x));

  it("shoves premium hands and never dominated trash at 10 bb with three opponents", () => {
    const s = shoveSet(10, 3);
    for (const strong of ["AA", "KK", "AKs"]) expect(s.has(strong)).toBe(true);
    for (const trash of ["72o", "83o", "32o"]) expect(s.has(trash)).toBe(false);
  });
  it("never widens when more opponents are behind", () => {
    const two = shoveSet(10, 2), four = shoveSet(10, 4);
    // allow a hand or two on the edge to flip by Monte Carlo noise, but not systematic widening
    expect(wider(two, four).length).toBeLessThanOrEqual(2);
    expect(four.size).toBeLessThanOrEqual(two.size);
  });
  it("never widens when the stack is deeper", () => {
    const shallow = shoveSet(6, 3), deep = shoveSet(14, 3);
    expect(wider(shallow, deep).length).toBeLessThanOrEqual(2);
    expect(deep.size).toBeLessThanOrEqual(shallow.size);
  });
  it("shoves more against tight players than against loose ones", () => {
    expect(shoveSet(10, 3, 0.12).size).toBeGreaterThan(shoveSet(10, 3, 0.55).size);
  });
});

describe("tournaments price the risk", () => {
  it("shoves less on the bubble than in chips", () => {
    const h = hand("Kc", "Jd");
    const chips = multiwayPushAdvice(table, h, spot(10), players(3), 0, [], undefined, { rng: seededRng(4), nSims: 8000 })!;
    const bubble = multiwayPushAdvice(table, h, spot(10), players(3), 0, [],
      { stacks: [20, 30, 30, 20], payouts: [60, 40] }, { rng: seededRng(4), nSims: 8000 })!;
    expect(bubble.bubble_factor).toBeGreaterThan(1);
    expect(bubble.ev).toBeLessThan(chips.ev);
  });
});

describe("advise", () => {
  const req = (cards: [string, string], bbs: number, opps: number, extra = {}) => ({
    hero: cards, board: [], structure: "no_limit" as const, bb: 2, pot: 3, to_call: 1, stack: bbs * 2, position: 0.3,
    opponents: Array.from({ length: opps }, () => ({})), budgetMs: 60_000, ...extra,
  });
  it("proposes the all-in with a premium hand where the network never shoves", () => {
    const r = advise(req(["As", "Ah"], 10, 3), undefined, seededRng(3), table);
    expect(r.multiway?.decision).toBe("shove");
    expect(r.advice.action).toBe("all-in");
    expect(r.advice.amount).toBe(20);
    expect(r.advice.source).toBe("multiway");
  });
  it("leaves the usual advice when the shove does not pay, and still reports the numbers", () => {
    const without = advise(req(["7c", "2d"], 10, 3), undefined, seededRng(3));
    const withTable = advise(req(["7c", "2d"], 10, 3), undefined, seededRng(3), table);
    expect(withTable.multiway?.decision).toBe("no_shove");
    expect(withTable.advice).toEqual(without.advice);
  });
  it("changes nothing without the table, heads-up, or outside the covered depth", () => {
    expect(advise(req(["As", "Ah"], 10, 3), undefined, seededRng(3)).multiway).toBeUndefined();
    expect(advise(req(["As", "Ah"], 10, 1), undefined, seededRng(3), table).multiway).toBeUndefined();
    expect(advise(req(["As", "Ah"], 40, 3), undefined, seededRng(3), table).multiway).toBeUndefined();
    expect(advise(req(["As", "Ah"], 40, 3), undefined, seededRng(3), table).advice.source).not.toBe("multiway");
  });
});
