/** The Nash push/fold table in the app: it must be the Python solution, and used only in the spots it covers. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advise } from "../src/advisor.js";
import { parse } from "../src/cards.js";
import { seededRng } from "../src/equity.js";
import { lookup, pushFoldAdvice, startingHandClass, type PushFoldTable, type SpotContext } from "../src/pushfold.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const table = read("../pushfold.json") as PushFoldTable;
const nash = read("../../bench/data/pushfold_nash.json");
const hand = (a: string, b: string): [number, number] => [parse(a), parse(b)];
const col = (label: string) => table.classes.indexOf(label);

/** Small blind to act at `bbs` effective big blinds (blinds 1/2, so bb = 2). */
const smallBlind = (bbs: number, extra: Partial<SpotContext> = {}): SpotContext =>
  ({ bb: 2, pot: 3, to_call: 1, stack: bbs * 2 - 1, structure: "no_limit", tournament: false, ...extra });
/** Big blind facing a shove that covers it: the villain put in `bbs` big blinds in total. */
const bigBlind = (bbs: number, extra: Partial<SpotContext> = {}): SpotContext =>
  ({ bb: 2, pot: bbs * 2 + 2, to_call: bbs * 2 - 2, stack: bbs * 2 - 2, structure: "no_limit", tournament: false, ...extra });

describe("the table", () => {
  it("has the solved range, all 169 classes, and probabilities", () => {
    expect(table.depths[0]).toBe(2);
    expect(table.depths[table.depths.length - 1]).toBe(25);
    expect(table.depths.length).toBe(47);
    expect(table.classes.length).toBe(169);
    for (const rows of [table.shove, table.call]) {
      expect(rows.length).toBe(47);
      for (const row of rows) {
        expect(row.length).toBe(169);
        expect(row.every((p) => p >= 0 && p <= 1)).toBe(true);
      }
    }
  });

  it("is the Python solution (same depths, classes and probabilities up to the 3-decimal rounding)", () => {
    expect(table.depths).toEqual(nash.depths);
    expect(table.classes).toEqual(nash.classes);
    let worst = 0;
    for (let k = 0; k < table.depths.length; k++) {
      for (let j = 0; j < 169; j++) {
        worst = Math.max(worst, Math.abs(table.shove[k][j] - nash.shove[k][j]), Math.abs(table.call[k][j] - nash.call[k][j]));
      }
    }
    expect(worst).toBeLessThan(6e-4);
  });
});

describe("starting-hand classes", () => {
  it("every one of the 1326 holdings lands in exactly one class, with 6 / 4 / 12 combos per class", () => {
    const counts = new Map<string, number>();
    for (let a = 0; a < 52; a++) {
      for (let b = a + 1; b < 52; b++) counts.set(startingHandClass(a, b), (counts.get(startingHandClass(a, b)) ?? 0) + 1);
    }
    expect(counts.size).toBe(169);
    expect([...counts.keys()].sort()).toEqual([...table.classes].sort());
    for (const [label, n] of counts) expect(n, label).toBe(label[0] === label[1] ? 6 : label.endsWith("s") ? 4 : 12);
  });

  it("names the usual hands", () => {
    expect(startingHandClass(...hand("Ah", "Kh"))).toBe("AKs");
    expect(startingHandClass(...hand("Kd", "Ah"))).toBe("AKo");
    expect(startingHandClass(...hand("7c", "7d"))).toBe("77");
    expect(startingHandClass(...hand("2c", "Td"))).toBe("T2o");
  });
});

describe("lookup", () => {
  it("returns the table values on the solved depths and interpolates linearly in between", () => {
    // the sharpest change between two neighbouring depths anywhere in the table, so interpolation is observable
    let k = 0, j = 0, best = 0;
    for (let a = 0; a < table.depths.length - 1; a++) {
      for (let b = 0; b < 169; b++) {
        const change = Math.abs(table.shove[a][b] - table.shove[a + 1][b]);
        if (change > best) { best = change; k = a; j = b; }
      }
    }
    expect(best).toBeGreaterThan(0.2);
    const label = table.classes[j];
    const lo = table.depths[k], hi = table.depths[k + 1];
    expect(lookup(table, "small_blind", label, lo)).toBeCloseTo(table.shove[k][j], 12);
    expect(lookup(table, "small_blind", label, hi)).toBeCloseTo(table.shove[k + 1][j], 12);
    const mid = lookup(table, "small_blind", label, (lo + hi) / 2) as number;
    expect(mid).toBeCloseTo((table.shove[k][j] + table.shove[k + 1][j]) / 2, 12);
    const quarter = lookup(table, "small_blind", label, lo + (hi - lo) / 4) as number;
    expect(quarter).toBeCloseTo(0.75 * table.shove[k][j] + 0.25 * table.shove[k + 1][j], 12);
    expect(lookup(table, "big_blind", label, lo)).toBeCloseTo(table.call[k][j], 12);
  });

  it("covers exactly 2 to 25 big blinds and known classes", () => {
    expect(lookup(table, "small_blind", "AA", 2)).not.toBeNull();
    expect(lookup(table, "small_blind", "AA", 25)).not.toBeNull();
    expect(lookup(table, "small_blind", "AA", 1.99)).toBeNull();
    expect(lookup(table, "small_blind", "AA", 25.01)).toBeNull();
    expect(lookup(table, "small_blind", "XX", 10)).toBeNull();
    expect(lookup(table, "small_blind", "AA", NaN)).toBeNull();
  });
});

describe("advice in the two covered spots", () => {
  it("small blind at 10 bb: aces shove, seven-deuce folds", () => {
    const aa = pushFoldAdvice(table, hand("Ah", "As"), smallBlind(10), 1, 0);
    expect(aa).toMatchObject({ role: "small_blind", hand: "AA", depth: 10, decision: "shove" });
    expect(aa?.probability).toBeGreaterThan(0.99);
    const trash = pushFoldAdvice(table, hand("7c", "2d"), smallBlind(10), 1, 0);
    expect(trash).toMatchObject({ hand: "72o", decision: "fold" });
    expect(trash?.probability).toBeLessThan(0.01);
  });

  it("big blind facing an all-in at 10 bb: aces call, seven-deuce folds", () => {
    expect(pushFoldAdvice(table, hand("Ah", "As"), bigBlind(10), 1, 0)).toMatchObject({ role: "big_blind", depth: 10, decision: "call" });
    expect(pushFoldAdvice(table, hand("7c", "2d"), bigBlind(10), 1, 0)).toMatchObject({ role: "big_blind", decision: "fold" });
  });

  it("the decision flips at one half, using the probability the table gives", () => {
    // mixed strategies exist only on the boundary hands: find one on each side of 0.5 anywhere in the table
    const find = (lo: number, hi: number) => {
      for (let k = 0; k < table.depths.length; k++) {
        for (let j = 0; j < 169; j++) if (table.shove[k][j] > lo && table.shove[k][j] < hi) return { k, j };
      }
      return null;
    };
    const cardsFor = (label: string): [number, number] => (label[0] === label[1]
      ? hand(label[0] + "h", label[1] + "d") : hand(label[0] + "h", label[1] + (label.endsWith("s") ? "h" : "d")));
    for (const [lo, hi, decision] of [[0.55, 0.85, "shove"], [0.15, 0.45, "fold"]] as const) {
      const spot = find(lo, hi);
      expect(spot, `no hand with a shove probability in (${lo}, ${hi}) in the whole table`).not.toBeNull();
      const { k, j } = spot as { k: number; j: number };
      const r = pushFoldAdvice(table, cardsFor(table.classes[j]), smallBlind(table.depths[k]), 1, 0);
      expect(r?.probability).toBeCloseTo(table.shove[k][j], 12);
      expect(r?.decision).toBe(decision);
    }
  });

  it("works at stacks between the solved depths", () => {
    const r = pushFoldAdvice(table, hand("Kh", "9h"), smallBlind(10.25), 1, 0);
    expect(r?.depth).toBe(10.25);
    const a = lookup(table, "small_blind", "K9s", 10.25);
    expect(r?.probability).toBeCloseTo(a as number, 12);
  });

  it("flags a tournament spot: the table is chip-EV and ignores the ICM", () => {
    expect(pushFoldAdvice(table, hand("Ah", "As"), smallBlind(10, { tournament: true }), 1, 0)?.caveat).toBe("icm");
    expect(pushFoldAdvice(table, hand("Ah", "As"), smallBlind(10), 1, 0)?.caveat).toBeUndefined();
  });
});

describe("advice stays silent outside what it covers", () => {
  const aces = hand("Ah", "As");
  it("not heads-up, not preflop, not no-limit", () => {
    expect(pushFoldAdvice(table, aces, smallBlind(10), 2, 0)).toBeNull();
    expect(pushFoldAdvice(table, aces, smallBlind(10), 1, 3)).toBeNull();
    expect(pushFoldAdvice(table, aces, smallBlind(10, { structure: "pot_limit" }), 1, 0)).toBeNull();
  });

  it("stacks outside 2 to 25 big blinds", () => {
    expect(pushFoldAdvice(table, aces, smallBlind(40), 1, 0)).toBeNull();
    expect(pushFoldAdvice(table, aces, smallBlind(1.5), 1, 0)).toBeNull();
    expect(pushFoldAdvice(table, aces, bigBlind(40), 1, 0)).toBeNull();
  });

  it("spots that are neither the small blind's first decision nor a call that puts the big blind all-in", () => {
    expect(pushFoldAdvice(table, aces, { bb: 2, pot: 3, to_call: 0, stack: 19, structure: "no_limit", tournament: false }, 1, 0)).toBeNull();
    expect(pushFoldAdvice(table, aces, { bb: 2, pot: 12, to_call: 6, stack: 90, structure: "no_limit", tournament: false }, 1, 0)).toBeNull();
    expect(pushFoldAdvice(table, aces, { bb: 2, pot: 3, to_call: 1, stack: 19, structure: "no_limit", tournament: false }, 1, 0)).not.toBeNull();
  });
});

describe("in advise()", () => {
  const base = {
    hero: ["Ah", "As"] as [string, string], board: [] as string[], structure: "no_limit" as const,
    bb: 2, pot: 3, to_call: 1, stack: 19, position: 0.95, opponents: [{}], budgetMs: 200,
  };

  it("adds the Nash advice next to the normal one when a table is given", () => {
    const r = advise(base, undefined, seededRng(1), table);
    expect(r.pushfold).toMatchObject({ role: "small_blind", decision: "shove", depth: 10 });
    expect(r.advice.action).toBeTruthy(); // the normal advice is still there
  });

  it("is absent without a table, with more than one opponent, or on a later street", () => {
    expect(advise(base, undefined, seededRng(1)).pushfold).toBeUndefined();
    expect(advise({ ...base, opponents: [{}, {}] }, undefined, seededRng(1), table).pushfold).toBeUndefined();
    expect(advise({ ...base, board: ["2c", "7d", "9h"] }, undefined, seededRng(1), table).pushfold).toBeUndefined();
  });

  it("marks a tournament spot", () => {
    const r = advise({ ...base, tournament: { stacks: [20, 30, 50], payouts: [50, 30, 20] } }, undefined, seededRng(1), table);
    expect(r.pushfold?.caveat).toBe("icm");
  });
});

describe("the exact answer is THE answer where it applies (cash, heads-up, short stack)", () => {
  const spot = {
    hero: ["Ah", "As"] as [string, string], board: [] as string[], structure: "no_limit" as const,
    bb: 2, pot: 3, to_call: 1, stack: 19, position: 0.95, opponents: [{}], budgetMs: 200,
  };
  const ask = (extra: object = {}, withTable = true) =>
    advise({ ...spot, ...extra } as typeof spot, undefined, seededRng(1), withTable ? table : undefined);

  it("small blind: aces shove all-in, seven-deuce folds, and the probabilities are the table's", () => {
    const aces = ask().advice;
    expect(aces).toMatchObject({ action: "all-in", amount: 19, source: "nash", bubble_factor: 1 });
    expect(aces.probs.raise).toBeGreaterThan(0.99);
    expect(aces.probs.call).toBe(0);
    const trash = ask({ hero: ["7c", "2d"] }).advice;
    expect(trash).toMatchObject({ action: "fold", amount: 0, source: "nash" });
    expect(trash.probs.fold_check).toBeGreaterThan(0.99);
  });

  it("big blind facing an all-in: aces call for what is left, seven-deuce folds", () => {
    const facing = { pot: 22, to_call: 18, stack: 18 };
    const aces = ask(facing).advice;
    expect(aces).toMatchObject({ action: "call", amount: 18, source: "nash" });
    expect(aces.probs.call).toBeGreaterThan(0.99); // a call, not a raise: the big blind cannot raise an all-in
    expect(aces.probs.raise).toBe(0);
    const trash = ask({ ...facing, hero: ["7c", "2d"] }).advice;
    expect(trash).toMatchObject({ action: "fold", amount: 0, source: "nash" });
    expect(trash.probs.fold_check).toBeGreaterThan(0.99);
    expect(trash.probs.call).toBeLessThan(0.01);
  });

  it("a mixed hand reports the table's probability, not 0 or 1", () => {
    let spotAt: { k: number; j: number } | null = null;
    for (let k = 0; k < table.depths.length && !spotAt; k++) {
      for (let j = 0; j < 169; j++) if (table.shove[k][j] > 0.3 && table.shove[k][j] < 0.7) { spotAt = { k, j }; break; }
    }
    expect(spotAt, "no mixed hand in the table").not.toBeNull();
    const { k, j } = spotAt as { k: number; j: number };
    const label = table.classes[j];
    const cards: [string, string] = label[0] === label[1] ? [label[0] + "h", label[1] + "d"]
      : [label[0] + "h", label[1] + (label.endsWith("s") ? "h" : "d")];
    const advice = ask({ hero: cards, stack: table.depths[k] * 2 - 1 }).advice;
    expect(advice.probs.raise).toBeCloseTo(table.shove[k][j], 12);
    expect(advice.probs.fold_check).toBeCloseTo(1 - table.shove[k][j], 12);
  });

  it("is not used in a tournament (the table ignores the ICM), without a table, multiway, or deep-stacked", () => {
    const t = ask({ tournament: { stacks: [20, 30, 50], payouts: [50, 30, 20] } });
    expect(t.advice.source).not.toBe("nash");
    expect(t.pushfold?.caveat).toBe("icm"); // but the note is still there
    expect(ask({}, false).advice.source).not.toBe("nash");
    expect(ask({ opponents: [{}, {}] }).advice.source).not.toBe("nash");
    expect(ask({ stack: 199 }).advice.source).not.toBe("nash");
  });
});
