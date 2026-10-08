/** Range posterior, known cards and dead cards. Equity is checked against exact enumeration, not another sampler. */
import { describe, expect, it } from "vitest";
import { advise } from "../src/advisor.js";
import { Card, DECK, evaluate, parse } from "../src/cards.js";
import { seededRng, simulate } from "../src/equity.js";
import { PRIOR, rangeFraction } from "../src/policy.js";
import {
  buildPosterior, effectiveFraction, priorRange, topClasses, updateRange, type ActionRecord,
} from "../src/range.js";
import { handPct, pairKey } from "../src/ranges.js";

const c = (...s: string[]): Card[] => s.map(parse);
const set = (...s: string[]) => new Set(c(...s));
const sum = (w: Float64Array) => w.reduce((a, b) => a + b, 0);
const positive = (w: Float64Array) => w.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
const at = (w: Float64Array, a: string, b: string) => w[pairKey(parse(a), parse(b))];

describe("prior range", () => {
  it("excludes blocked cards and sums to 1", () => {
    const w = priorRange(set("Ah", "As", "Kd", "2c", "7d"));
    expect(sum(w)).toBeCloseTo(1, 12);
    expect(positive(w)).toBe((47 * 46) / 2);
    expect(at(w, "Ah", "Kc")).toBe(0);
    expect(at(w, "Qh", "Qs")).toBeGreaterThan(0);
  });

  it("two known cards are one exact holding; one known card keeps only holdings containing it", () => {
    const dead = set("Ah", "As");
    const two = priorRange(dead, c("Kd", "Kc"));
    expect(positive(two)).toBe(1);
    expect(at(two, "Kd", "Kc")).toBe(1);
    const one = priorRange(dead, c("Kd"));
    expect(positive(one)).toBe(49); // 52 - 2 dead - the known card itself
    expect(at(one, "Kd", "7h")).toBeGreaterThan(0);
    expect(at(one, "Qc", "7h")).toBe(0);
  });
});

describe("updating a range with an action", () => {
  const raise: ActionRecord = { street: 0, type: "raise", amount: 6, pot_before: 3 };

  it("fold and check leave the range untouched", () => {
    const w = priorRange(set("Ah", "As"));
    for (const type of ["fold", "check"] as const) {
      const r = updateRange(w, { street: 0, type }, PRIOR, []);
      expect(r.weights).toBe(w);
      expect(r.contradiction).toBe(false);
    }
  });

  it("a preflop raise matches the explicit Bayes formula (soft top-fraction membership)", () => {
    const w = priorRange(set("Ah", "As"));
    const f = rangeFraction(PRIOR, 0, "raise", 6 / 3);
    const expected = new Float64Array(w.length);
    for (let a = 0; a < 52; a++) {
      for (let b = a + 1; b < 52; b++) {
        if (w[pairKey(a, b)] > 0) expected[pairKey(a, b)] = w[pairKey(a, b)] / (1 + Math.exp(-(f - handPct(a, b)) / 0.02));
      }
    }
    const total = sum(expected);
    const got = updateRange(w, raise, PRIOR, []).weights;
    for (let i = 0; i < got.length; i++) expect(got[i]).toBeCloseTo(expected[i] / total, 12);
    expect(sum(got)).toBeCloseTo(1, 12);
  });

  it("favours strong hands and keeps blocked cards at zero", () => {
    const w = updateRange(priorRange(set("Ah", "As")), raise, PRIOR, []).weights;
    expect(at(w, "Kh", "Kd")).toBeGreaterThan(at(w, "7h", "2c") * 1e6);
    expect(at(w, "Ah", "Kd")).toBe(0);
  });

  it("successive actions narrow the range further (preflop raise, then a flop bet)", () => {
    const dead = set("Ah", "As", "2c", "7d", "9h");
    const board = c("2c", "7d", "9h");
    const none = buildPosterior({ stats: PRIOR, actions: [], board, dead });
    const afterRaise = buildPosterior({ stats: PRIOR, actions: [raise], board, dead });
    const afterBet = buildPosterior({
      stats: PRIOR, actions: [raise, { street: 1, type: "bet", amount: 10, pot_before: 20 }], board, dead,
    });
    const width = (p: typeof none) => effectiveFraction(p.weights, p.live);
    expect(width(none)).toBeCloseTo(1, 6);
    expect(width(afterRaise)).toBeLessThan(0.5);
    expect(width(afterBet)).toBeLessThan(width(afterRaise));
  });

  it("an action on a street the board has not reached is ignored", () => {
    const dead = set("Ah", "As");
    const base = buildPosterior({ stats: PRIOR, actions: [], board: [], dead });
    const turnBet = buildPosterior({ stats: PRIOR, actions: [{ street: 2, type: "bet" }], board: c("2c", "7d", "9h"), dead });
    expect(turnBet.weights).toEqual(base.weights);
  });

  it("evidence the model calls impossible keeps the previous range and is flagged, not crashed on", () => {
    const everything = new Set(DECK.filter((x) => x !== parse("7h") && x !== parse("2c")));
    const only72 = priorRange(everything); // a single holding: 7h 2c
    expect(positive(only72)).toBe(1);
    const r = updateRange(only72, raise, PRIOR, []);
    expect(r.contradiction).toBe(true);
    expect(r.weights).toBe(only72);
  });

  it("known cards win over actions", () => {
    const post = buildPosterior({
      stats: PRIOR, actions: [raise], board: [], dead: set("Ah", "As"), known: c("7h", "2c"),
    });
    expect(positive(post.weights)).toBe(1);
    expect(post.contradiction).toBe(false);
  });
});

describe("range summaries", () => {
  it("effective fraction: ~1 for a uniform range, the hand's own percentile (floored) for a single holding", () => {
    const uniform = priorRange(new Set());
    expect(effectiveFraction(uniform, positive(uniform))).toBeCloseTo(1, 9);
    const one = priorRange(set(), c("7h", "2c"));
    expect(effectiveFraction(one, 1)).toBeCloseTo(handPct(parse("7h"), parse("2c")), 9);
    const aces = priorRange(set(), c("Ah", "As"));
    expect(effectiveFraction(aces, 1)).toBe(0.04); // AA is better than the floor
  });

  it("topClasses lists strong classes first, in descending order, and never a trash hand", () => {
    const w = updateRange(priorRange(set()), { street: 0, type: "raise", amount: 6, pot_before: 3 }, PRIOR, []).weights;
    const top = topClasses(w, 5);
    expect(top.length).toBe(5);
    expect(top.map((t) => t.pct)).toEqual([...top.map((t) => t.pct)].sort((a, b) => b - a));
    expect(top.reduce((s, t) => s + t.pct, 0)).toBeLessThanOrEqual(100.5);
    expect(top.map((t) => t.hand)).not.toContain("72o");
    expect(top[0].pct).toBeGreaterThan(3);
    expect(topClasses(priorRange(set(), c("Ah")), 3).every((t) => t.hand.includes("A"))).toBe(true);
  });
});

// ---------- equity against exact enumeration ----------
/** Exact equity of `hero` vs one opponent whose holding is uniform over `holdings`, on a 4-card board. */
function exactTurnEquity(hero: Card[], board: Card[], holdings: [Card, Card][], dead: Card[] = []): number {
  let total = 0, n = 0;
  for (const [a, b] of holdings) {
    const taken = new Set([...hero, ...board, ...dead, a, b]);
    if (taken.size !== hero.length + board.length + dead.length + 2) continue;
    for (const river of DECK) {
      if (taken.has(river)) continue;
      const hs = evaluate([...board, river, ...hero]), os = evaluate([...board, river, a, b]);
      total += hs > os ? 1 : hs === os ? 0.5 : 0;
      n++;
    }
  }
  return total / n;
}
const allHoldings = (): [Card, Card][] => DECK.flatMap((a) => DECK.filter((b) => b > a).map((b) => [a, b] as [Card, Card]));
const tol = (p: number, n: number) => 4 * Math.sqrt((p * (1 - p)) / n) + 1e-3;
const N = 30000;
const run = (hero: Card[], board: Card[], opp: Parameters<typeof simulate>[2], dead: Card[] = []) =>
  simulate(hero, board, opp, { nSims: N, budgetMs: 1e9, rng: seededRng(11), dead });

describe("equity vs exact enumeration", () => {
  const hero = c("Ah", "As"), board = c("2c", "7d", "9h", "Js");

  it("opponent shows both cards", () => {
    const known = c("Kd", "Kc");
    const post = buildPosterior({ stats: PRIOR, actions: [], board, dead: new Set([...hero, ...board]), known });
    const exact = exactTurnEquity(hero, board, [[known[0], known[1]]]);
    const got = run(hero, board, [{ weights: post.weights }], known).equity; // known cards are out of the deck
    expect(Math.abs(got - exact)).toBeLessThan(tol(exact, N));
  });

  it("opponent shows only one card: the other comes from the whole remaining deck", () => {
    const kd = parse("Kd");
    const post = buildPosterior({ stats: PRIOR, actions: [], board, dead: new Set([...hero, ...board]), known: [kd] });
    const holdings = allHoldings().filter(([a, b]) => a === kd || b === kd);
    const exact = exactTurnEquity(hero, board, holdings);
    const got = run(hero, board, [{ weights: post.weights }], [kd]).equity;
    expect(Math.abs(got - exact)).toBeLessThan(tol(exact, N));
  });

  it("dead cards are never dealt to anyone", () => {
    const dead = c("Kd", "Kc", "Kh", "Ks");
    const exact = exactTurnEquity(hero, board, allHoldings(), dead);
    const withDead = run(hero, board, [1.0], dead).equity;
    expect(Math.abs(withDead - exact)).toBeLessThan(tol(exact, N));
  });

  it("respects unequal weights, not just which holdings are possible", () => {
    // 90% kings (hero crushes them), 10% jacks (a set on this board: hero is a big underdog)
    const kk = c("Kd", "Kc"), jj = c("Jd", "Jc");
    const weights = new Float64Array(52 * 52);
    weights[pairKey(kk[0], kk[1])] = 0.9;
    weights[pairKey(jj[0], jj[1])] = 0.1;
    const exact = 0.9 * exactTurnEquity(hero, board, [[kk[0], kk[1]]]) + 0.1 * exactTurnEquity(hero, board, [[jj[0], jj[1]]]);
    const uniform = 0.5 * exactTurnEquity(hero, board, [[kk[0], kk[1]]]) + 0.5 * exactTurnEquity(hero, board, [[jj[0], jj[1]]]);
    expect(exact - uniform).toBeGreaterThan(0.2); // the test can tell the two apart
    const got = run(hero, board, [{ weights }], [...kk, ...jj]).equity;
    expect(Math.abs(got - exact)).toBeLessThan(tol(exact, N));
  });

  it("a fully determined showdown is decided exactly", () => {
    const river = c("2c", "3d", "9h", "Js", "5s");
    const known = c("Ac", "Ad"); // pair of aces beats 7-2 on this board
    const post = buildPosterior({ stats: PRIOR, actions: [], board: river, dead: new Set([...c("7h", "2d"), ...river]), known });
    const r = run(c("7h", "2d"), river, [{ weights: post.weights }], known);
    expect(r.equity).toBe(0);
    expect(r.win).toBe(0);
  });

  it("opponents holding shown cards and a fraction range are dealt consistently", () => {
    const k1 = c("Kd", "Kc"), k2 = c("Qd", "Qc");
    const w = (known: Card[]) => buildPosterior({ stats: PRIOR, actions: [], board: [], dead: new Set(hero), known }).weights;
    const r = simulate(hero, [], [{ weights: w(k1) }, { weights: w(k2) }, 0.3], {
      nSims: 4000, budgetMs: 1e9, rng: seededRng(5), dead: [...k1, ...k2],
    });
    expect(r.equity).toBeGreaterThan(0.5); // aces vs kings, queens and a 30% range
    expect(r.equity).toBeLessThan(0.85);
  });
});

describe("advise with actions, shown cards and dead cards", () => {
  const base = {
    hero: ["Ah", "As"] as [string, string], board: [] as string[], structure: "no_limit" as const,
    bb: 2, pot: 12, to_call: 6, stack: 200, position: 0.8, budgetMs: 1e9,
  };

  it("shown cards pin the opponent's holding and report it as the likeliest hand", () => {
    const r = advise({ ...base, opponents: [{ known: ["Kd", "Kc"] }] }, undefined, seededRng(1));
    expect(r.opponents[0].top[0]).toEqual({ hand: "KK", pct: 100 });
    expect(r.equity).toBeGreaterThan(0.78);
    expect(r.equity).toBeLessThan(0.86);
  });

  it("recorded actions narrow the range shown to the user", () => {
    const r = advise({
      ...base, opponents: [{ actions: [{ street: 0, type: "raise", amount: 6, pot_before: 3 }] }],
    }, undefined, seededRng(1));
    expect(r.opponents[0].range_pct).toBeLessThan(40);
    expect(r.opponents[0].top.length).toBe(5);
  });

  it("rejects a card that appears twice across hero, board, dead and shown cards", () => {
    const bad = [
      { ...base, dead: ["Ah"], opponents: [{}] },
      { ...base, opponents: [{ known: ["As", "Kd"] }] },
      { ...base, opponents: [{ known: ["Kd"] }, { known: ["Kd"] }] },
      { ...base, dead: ["Kd"], opponents: [{ known: ["Kd"] }] },
      { ...base, opponents: [{ known: ["Kd", "Kc", "Kh"] }] },
    ];
    for (const req of bad) expect(() => advise(req, undefined, seededRng(1))).toThrow();
  });
});
