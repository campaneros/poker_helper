/** Push/fold with the ICM, solved on the device. The strongest oracle: with two players and a winner-take-all prize the
 * ICM is linear in chips, so the solver must reproduce the exact chip-EV table that was validated against Python. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advise } from "../src/advisor.js";
import { parse } from "../src/cards.js";
import { seededRng } from "../src/equity.js";
import { icmPushFoldAdvice, solveIcmPushFold, type EquityMatrix, type IcmSpot, type TournamentContext } from "../src/icmpushfold.js";
import type { PushFoldTable, SpotContext } from "../src/pushfold.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const matrix = read("../equity169.json") as EquityMatrix;
const chip = read("../pushfold.json") as PushFoldTable;
const python = read("../../bench/data/equity_matrix.json");
const hand = (a: string, b: string): [number, number] => [parse(a), parse(b)];
const combos = (label: string) => (label[0] === label[1] ? 6 : label.endsWith("s") ? 4 : 12);
const share = (p: ArrayLike<number>) => matrix.classes.reduce((s, l, j) => s + p[j] * combos(l), 0) / 1326;
const chipShare = (rows: number[][], bbs: number) => share(rows[chip.depths.indexOf(bbs)]);
const heads = (sb: number, bb: number, payouts = [1], blind = 2): IcmSpot => ({ stacks: [sb, bb], payouts, sb: 0, bb: 1, blind });

describe("the equity matrix shipped with the app", () => {
  it("is the Python matrix, to within the integer rounding", () => {
    expect(matrix.classes).toEqual(python.classes);
    expect(matrix.classes.length).toBe(169);
    let worst = 0;
    for (let a = 0; a < 169; a++) for (let b = 0; b < 169; b++) worst = Math.max(worst, Math.abs(matrix.equity_e4[a][b] / matrix.scale - python.equity[a][b]));
    expect(worst).toBeLessThan(5.1e-5);
  });

  it("is antisymmetric (a's equity against b plus b's against a is 1)", () => {
    for (let a = 0; a < 169; a++) for (let b = 0; b < 169; b++) expect(Math.abs(matrix.equity_e4[a][b] + matrix.equity_e4[b][a] - matrix.scale)).toBeLessThanOrEqual(1);
  });
});

describe("oracle: two players, winner takes all = the chip-EV Nash table", () => {
  for (const bbs of [4, 6, 8, 10, 12, 15, 20]) {
    it(`${bbs} bb each`, () => {
      const sol = solveIcmPushFold(matrix, heads(bbs * 2, bbs * 2));
      const k = chip.depths.indexOf(bbs);
      let shoveDiff = 0, callDiff = 0, shoveFlips = 0, callFlips = 0;
      for (let j = 0; j < 169; j++) {
        shoveDiff += Math.abs(sol.shove[j] - chip.shove[k][j]); callDiff += Math.abs(sol.call[j] - chip.call[k][j]);
        shoveFlips += (sol.shove[j] > 0.5) !== (chip.shove[k][j] > 0.5) ? 1 : 0;
        callFlips += (sol.call[j] > 0.5) !== (chip.call[k][j] > 0.5) ? 1 : 0;
      }
      expect(shoveDiff / 169).toBeLessThan(0.02);
      expect(callDiff / 169).toBeLessThan(0.02);
      expect(shoveFlips).toBeLessThanOrEqual(3); // only boundary hands, where the two solutions are within noise of each other
      expect(callFlips).toBeLessThanOrEqual(3);
      expect(sol.gapRelative).toBeLessThan(1e-4);
    });
  }

  it("unequal stacks: the effective stack is the shorter one", () => {
    // small blind 20 bb against a big blind of 10 bb: only 10 bb can be won or lost
    const sol = solveIcmPushFold(matrix, heads(40, 20));
    expect(Math.abs(share(sol.shove) - chipShare(chip.shove, 10))).toBeLessThan(0.02);
    expect(Math.abs(share(sol.call) - chipShare(chip.call, 10))).toBeLessThan(0.02);
    // and the other way round: a short small blind against a deep big blind
    const flipped = solveIcmPushFold(matrix, heads(20, 40));
    expect(Math.abs(share(flipped.shove) - chipShare(chip.shove, 10))).toBeLessThan(0.02);
  });
});

describe("what the ICM changes (well-known bubble behaviour)", () => {
  // three players, two paid equally: busting is the only way to lose everything
  const bubble: IcmSpot = { stacks: [20, 20, 10], payouts: [1, 1, 0], sb: 0, bb: 1, blind: 2 };

  it("the big blind calls far less than in chips, the small blind shoves at least as wide", () => {
    const sol = solveIcmPushFold(matrix, bubble);
    expect(share(sol.call)).toBeLessThan(chipShare(chip.call, 10) * 0.3);
    expect(share(sol.shove)).toBeGreaterThanOrEqual(chipShare(chip.shove, 10));
    const aa = matrix.classes.indexOf("AA"), trash = matrix.classes.indexOf("72o");
    expect(sol.call[aa]).toBeGreaterThan(0.99); // still calls with aces
    expect(sol.call[trash]).toBeLessThan(0.01);
  });

  it("is an equilibrium: the Nash gap is tiny, and it is deterministic", () => {
    const a = solveIcmPushFold(matrix, bubble), b = solveIcmPushFold(matrix, bubble);
    expect(a.gapRelative).toBeLessThan(1e-4);
    expect(Array.from(a.shove)).toEqual(Array.from(b.shove));
    for (const p of [...a.shove, ...a.call]) expect(p >= 0 && p <= 1).toBe(true);
  });

  it("a pay jump below changes the answer: the same stacks with a winner-take-all prize play like chips", () => {
    const wta = solveIcmPushFold(matrix, { ...bubble, payouts: [1, 0, 0] });
    const bubbleSol = solveIcmPushFold(matrix, bubble);
    expect(share(wta.call)).toBeGreaterThan(share(bubbleSol.call) + 0.05);
  });

  it("equal payouts: nothing is at stake, no NaN, zero gap", () => {
    const sol = solveIcmPushFold(matrix, { stacks: [20, 20], payouts: [1, 1], sb: 0, bb: 1, blind: 2 });
    expect(sol.gap).toBeLessThan(1e-9);
    expect(Array.from(sol.shove).every(Number.isFinite)).toBe(true);
    expect(Array.from(sol.call).every(Number.isFinite)).toBe(true);
  });

  it("the Nash gap really measures deviation gains: wrong strategies score a larger gap, on either side", () => {
    const sol = solveIcmPushFold(matrix, bubble);
    const aa = matrix.classes.indexOf("AA");
    const measure = (shove: ArrayLike<number>, call: ArrayLike<number>) =>
      solveIcmPushFold(matrix, bubble, { evaluate: { shove, call } }).gapRelative;
    const best = measure(sol.shove, sol.call);
    expect(best).toBeLessThan(1e-4); // the solution itself
    // one wrong hand (aces are 0.45% of all hands, so the loss is small but clearly above the solution's gap)
    const badSb = Float64Array.from(sol.shove); badSb[aa] = 0; // the small blind folds aces
    const badBb = Float64Array.from(sol.call); badBb[aa] = 0; // the big blind folds aces to a shove
    expect(measure(badSb, sol.call)).toBeGreaterThan(best * 10);
    expect(measure(sol.shove, badBb)).toBeGreaterThan(best * 10);
    // gross errors: a gap of tens of percent of the prize pool
    expect(measure(sol.shove, new Float64Array(169).fill(1))).toBeGreaterThan(0.1); // the big blind calls everything
    expect(measure(new Float64Array(169), sol.call)).toBeGreaterThan(5e-3); // the small blind never shoves
  });

  it("a nine-handed table is solved in well under two seconds", () => {
    const t0 = performance.now();
    const sol = solveIcmPushFold(matrix, { stacks: [30, 25, 20, 18, 15, 12, 40, 22, 10], payouts: [40, 25, 15, 10, 6, 4], sb: 4, bb: 5, blind: 2 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(sol.gapRelative).toBeLessThan(1e-3);
  });
});

describe("advice for the app", () => {
  const sb: SpotContext = { bb: 2, pot: 3, to_call: 1, stack: 19, structure: "no_limit", tournament: true };
  const bbFacing: SpotContext = { bb: 2, pot: 22, to_call: 18, stack: 18, structure: "no_limit", tournament: true };
  const bubble: TournamentContext = { stacks: [20, 20, 10], payouts: [1, 1, 0] };

  it("small blind on the bubble: aces shove; big blind facing the shove calls only with the best hands", () => {
    expect(icmPushFoldAdvice(matrix, hand("Ah", "As"), sb, bubble, 1, 0)).toMatchObject({ role: "small_blind", icm: true, decision: "shove", hand: "AA" });
    expect(icmPushFoldAdvice(matrix, hand("Ah", "As"), bbFacing, bubble, 1, 0)).toMatchObject({ role: "big_blind", decision: "call", icm: true });
    expect(icmPushFoldAdvice(matrix, hand("Kc", "Td"), bbFacing, bubble, 1, 0)?.decision).toBe("fold"); // a call in chips, a fold here
    expect(icmPushFoldAdvice(matrix, hand("Kc", "Td"), bbFacing, { stacks: [20, 20], payouts: [1] }, 1, 0)?.decision).toBe("call");
  });

  it("reports how close to an equilibrium it got, so a poor solution is never presented as exact", () => {
    const good = icmPushFoldAdvice(matrix, hand("Ah", "As"), sb, bubble, 1, 0);
    expect(good?.gap).toBeLessThan(1e-4);
    const rushed = icmPushFoldAdvice(matrix, hand("Ah", "As"), sb, bubble, 1, 0, { maxIterations: 5, tolerance: 0 });
    expect(rushed?.gap).toBeGreaterThan(good?.gap as number);
  });

  it("the opponent defaults to the largest other stack, and can be chosen", () => {
    const stacks = [20, 12, 30];
    const defaultVillain = icmPushFoldAdvice(matrix, hand("Kc", "Td"), bbFacing, { stacks, payouts: [50, 30, 20] }, 1, 0);
    const explicit = icmPushFoldAdvice(matrix, hand("Kc", "Td"), bbFacing, { stacks, payouts: [50, 30, 20], villain: 2 }, 1, 0);
    expect(defaultVillain).toEqual(explicit);
    const other = icmPushFoldAdvice(matrix, hand("Kc", "Td"), bbFacing, { stacks, payouts: [50, 30, 20], villain: 1 }, 1, 0);
    expect(other?.depth).toBe(6); // 12 chips = 6 big blinds: the shorter stack sets the depth
    expect(defaultVillain?.depth).toBe(10);
  });

  it("hero as small blind and as big blind are different games: the roles are mapped to the right seats", () => {
    const stacks = [14, 30, 10], payouts = [50, 30, 20];
    const asSb = solveIcmPushFold(matrix, { stacks, payouts, sb: 0, bb: 1, blind: 2 });
    const asBb = solveIcmPushFold(matrix, { stacks, payouts, sb: 1, bb: 0, blind: 2 });
    const swapped = solveIcmPushFold(matrix, { stacks, payouts, sb: 1, bb: 0, blind: 2 }); // what a wrong mapping would use for hero-SB
    // non-vacuous: the two seatings genuinely differ for at least one hand
    const differs = matrix.classes.some((_, j) => Math.abs(asSb.shove[j] - swapped.shove[j]) > 0.05);
    expect(differs).toBe(true);
    for (const label of ["K9o", "A5s", "T8s", "Q6o", "J3s"]) {
      const j = matrix.classes.indexOf(label);
      const cards: [number, number] = hand(label[0] + "h", label[1] + (label.endsWith("s") ? "h" : "d"));
      const sbAdvice = icmPushFoldAdvice(matrix, cards, sb, { stacks, payouts }, 1, 0);
      expect(sbAdvice?.probability, `${label} as small blind`).toBeCloseTo(asSb.shove[j], 9);
      const bbAdvice = icmPushFoldAdvice(matrix, cards, bbFacing, { stacks, payouts }, 1, 0);
      expect(bbAdvice?.probability, `${label} as big blind`).toBeCloseTo(asBb.call[j], 9);
    }
  });

  it("stays silent outside what it covers", () => {
    const aces = hand("Ah", "As");
    expect(icmPushFoldAdvice(matrix, aces, sb, bubble, 2, 0)).toBeNull(); // multiway
    expect(icmPushFoldAdvice(matrix, aces, sb, bubble, 1, 3)).toBeNull(); // postflop
    expect(icmPushFoldAdvice(matrix, aces, { ...sb, structure: "pot_limit" }, bubble, 1, 0)).toBeNull();
    expect(icmPushFoldAdvice(matrix, aces, sb, { stacks: [200, 200, 100], payouts: [1, 1, 0] }, 1, 0)).toBeNull(); // 100 bb: not a push/fold spot
    expect(icmPushFoldAdvice(matrix, aces, sb, { stacks: [3, 3, 3], payouts: [1, 1, 0] }, 1, 0)).toBeNull(); // 1.5 bb: below the covered range
    expect(icmPushFoldAdvice(matrix, aces, { ...sb, to_call: 0 }, bubble, 1, 0)).toBeNull(); // not the small blind's first decision
    for (const villain of [0, 3, -1, 1.5]) expect(icmPushFoldAdvice(matrix, aces, sb, { ...bubble, villain }, 1, 0)).toBeNull();
    for (const stacks of [[20], [20, 0, 10], [20, NaN, 10], [20, Infinity, 10]]) expect(icmPushFoldAdvice(matrix, aces, sb, { stacks, payouts: [1, 1, 0] }, 1, 0)).toBeNull();
  });
});

describe("in advise()", () => {
  const base = {
    hero: ["Ah", "As"] as [string, string], board: [] as string[], structure: "no_limit" as const,
    bb: 2, pot: 3, to_call: 1, stack: 19, position: 0.95, opponents: [{}], budgetMs: 200,
    tournament: { stacks: [20, 20, 10], payouts: [1, 1, 0] },
  };
  const ask = (extra: object = {}, icm = true) =>
    advise({ ...base, ...extra } as typeof base, undefined, seededRng(1), chip, icm ? matrix : undefined);

  it("the ICM solution is the main advice in a tournament, with the bubble factor kept for information", () => {
    const r = ask();
    expect(r.advice).toMatchObject({ action: "all-in", amount: 19, source: "nash_icm" });
    expect(r.advice.bubble_factor).toBeGreaterThan(1);
    expect(r.pushfold).toMatchObject({ icm: true, decision: "shove" });
    expect(r.pushfold?.caveat).toBeUndefined();
  });

  it("changes the answer where the ICM matters: a call that chips would make is a fold on the bubble", () => {
    const facing = { pot: 22, to_call: 18, stack: 18, hero: ["Kc", "Td"] };
    expect(ask(facing).advice).toMatchObject({ action: "fold", source: "nash_icm" });
    expect(ask({ ...facing, tournament: { stacks: [20, 20], payouts: [1] } }).advice).toMatchObject({ action: "call", source: "nash_icm" });
  });

  it("falls back to the chip-EV table with its caveat when no ICM matrix is available, and to the network elsewhere", () => {
    const noMatrix = ask({}, false);
    expect(noMatrix.pushfold).toMatchObject({ caveat: "icm" });
    expect(noMatrix.advice.source).not.toBe("nash_icm");
    expect(noMatrix.advice.source).not.toBe("nash");
    expect(ask({ opponents: [{}, {}] }).advice.source).not.toBe("nash_icm");
    expect(ask({ stack: 199, tournament: { stacks: [200, 200, 100], payouts: [1, 1, 0] } }).advice.source).not.toBe("nash_icm");
  });

  it("a cash game never uses the ICM solver", () => {
    const r = advise({ ...base, tournament: undefined } as unknown as typeof base, undefined, seededRng(1), chip, matrix);
    expect(r.advice.source).toBe("nash");
  });
});
