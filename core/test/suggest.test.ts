/** Style suggestion from the recorded history. Expected numbers come from closed forms (identical hands, known weights). */
import { describe, expect, it } from "vitest";
import type { HandRecord } from "../src/history.js";
import { MARGIN, MIN_HANDS, observedPlay, styleDistance, suggestStyle, type StyleLike } from "../src/suggest.js";

const STYLES: StyleLike[] = [
  { id: "builtin:nit", name: "Nit", vpip: 0.15, pfr: 0.12, af: 2.0 },
  { id: "builtin:tag", name: "TAG", vpip: 0.22, pfr: 0.17, af: 2.5 },
  { id: "builtin:lag", name: "LAG", vpip: 0.4, pfr: 0.3, af: 3.0 },
  { id: "builtin:fish", name: "Fish", vpip: 0.55, pfr: 0.06, af: 0.6 },
  { id: "builtin:maniac", name: "Maniac", vpip: 0.7, pfr: 0.45, af: 4.0 },
];
type A = HandRecord["actions"][number];
const hand = (i: number, actions: A[]): HandRecord => ({
  id: "h" + i, ts: 1000 + i, bb: 2, structure: "no_limit", board: ["2c", "7d", "9h"], players: [{ id: "P" }], actions,
});
const act = (type: A["type"], street = 0): A => ({ player: "P", street, type, ...(type === "raise" || type === "bet" ? { amount: 6 } : {}) });
const many = (n: number, actions: A[]): HandRecord[] => Array.from({ length: n }, (_, i) => hand(i, actions));
/** Sum of the recency weights of n hands (half-life 50 hands), as the stats use them. */
const weightSum = (n: number): number => Array.from({ length: n }, (_, i) => 0.5 ** ((n - 1 - i) / 50)).reduce((a, b) => a + b, 0);

describe("what is observed", () => {
  it("one hand, by hand: raise before the flop, a bet and a call after it", () => {
    const o = observedPlay("P", [hand(0, [act("raise"), act("bet", 1), act("call", 2)])]);
    expect(o).toEqual({ vpip: 1, pfr: 1, af: (1 + 1.5 * 2) / (1 + 2), hands: 1 }); // (bets + 2 pseudo-calls at AF 1.5) / (calls + 2)
  });
  it("identical hands give the same VPIP and PFR whatever their weights", () => {
    const o = observedPlay("P", many(30, [act("raise"), act("bet", 1)]));
    expect(o.vpip).toBeCloseTo(1, 12);
    expect(o.pfr).toBeCloseTo(1, 12);
    expect(o.af).toBeCloseTo((weightSum(30) + 3) / 2, 9); // W bets, no calls
  });
  it("a player who only folds before the flop has no VPIP", () => {
    expect(observedPlay("P", many(20, [act("fold")]))).toMatchObject({ vpip: 0, pfr: 0, hands: 20 });
  });
  it("is NOT pulled toward the style he is assigned (that would only echo it back)", () => {
    expect(observedPlay("P", many(20, [act("raise")])).vpip).toBeCloseTo(1, 12);
  });
  it("counts the old quick counters as hands", () => {
    const o = observedPlay("P", [], { hands: 20, vpip: 15, pfr: 10, bets: 20, calls: 10 });
    expect(o).toEqual({ vpip: 0.75, pfr: 0.5, af: (20 + 3) / (10 + 2), hands: 20 });
  });
});

describe("the suggestion", () => {
  const maniac = many(20, [act("raise"), act("bet", 1), act("bet", 2)]);
  it("names the closest style when the play does not match the assigned one", () => {
    const s = suggestStyle("P", maniac, STYLES, "builtin:nit");
    expect(s).toMatchObject({ style_id: "builtin:maniac", name: "Maniac", hands: 20 });
    expect(s!.observed.vpip).toBeCloseTo(1, 12);
    expect(s!.distance).toBeLessThan(s!.current_distance - MARGIN);
  });
  it("also works for a player who has no style yet", () => {
    expect(suggestStyle("P", maniac, STYLES, null)?.style_id).toBe("builtin:maniac");
  });
  it("says nothing with too little evidence", () => {
    expect(suggestStyle("P", maniac.slice(0, MIN_HANDS - 1), STYLES, "builtin:nit")).toBeNull();
    expect(suggestStyle("P", maniac.slice(0, MIN_HANDS), STYLES, "builtin:nit")).not.toBeNull();
  });
  it("says nothing when he already has the best style, or there are no styles, or no hands of his", () => {
    expect(suggestStyle("P", maniac, STYLES, "builtin:maniac")).toBeNull();
    expect(suggestStyle("P", maniac, [], null)).toBeNull();
    expect(suggestStyle("nobody", maniac, STYLES, null)).toBeNull();
  });
  it("needs the better style to be clearly closer: a near miss is not worth a suggestion", () => {
    const seen = observedPlay("P", maniac);
    const exact: StyleLike = { id: "exact", name: "Esatto", ...seen };
    const near: StyleLike = { ...exact, id: "near", name: "Quasi", vpip: seen.vpip - 0.3 * 0.12 };
    const far: StyleLike = { ...exact, id: "far", name: "Lontano", vpip: seen.vpip - 1.0 * 0.12 };
    expect(suggestStyle("P", maniac, [near, exact], "near")).toBeNull(); // 0.3 away: below the margin
    expect(suggestStyle("P", maniac, [far, exact], "far")?.style_id).toBe("exact"); // 1.0 away: worth it
  });
  it("considers the user's own styles, and the first of two equal styles wins", () => {
    const mine: StyleLike = { id: "s_mio", name: "Il fish del giovedì", vpip: 0.95, pfr: 0.95, af: 6 };
    expect(suggestStyle("P", maniac, [...STYLES, mine], "builtin:nit")?.style_id).toBe("s_mio");
    const twin: StyleLike = { ...mine, id: "s_gemello", name: "Gemello" };
    expect(suggestStyle("P", maniac, [...STYLES, mine, twin], "builtin:nit")?.style_id).toBe("s_mio");
    expect(suggestStyle("P", maniac, [...STYLES, twin, mine], "builtin:nit")?.style_id).toBe("s_gemello");
  });
  it("with no style assigned he is compared with the average player: playing like one is not worth a suggestion", () => {
    const average = { hands: 100, vpip: 28, pfr: 15, bets: 30, calls: 20 }; // exactly VPIP 28%, PFR 15%, AF 1.5
    expect(observedPlay("P", [], average)).toMatchObject({ vpip: 0.28, pfr: 0.15, af: 1.5 });
    expect(suggestStyle("P", [], [...STYLES].reverse(), null, average)).toBeNull(); // the first style listed is a far one
  });
  it("a passive loose player is a fish, not a maniac", () => {
    const fish = many(20, [act("call"), act("call", 1), act("call", 2)]);
    expect(suggestStyle("P", fish, STYLES, "builtin:tag")?.style_id).toBe("builtin:fish");
  });
});

describe("the distance", () => {
  it("is zero for the same play, symmetric, and counts each stat in its own units", () => {
    const a = { vpip: 0.3, pfr: 0.2, af: 2 };
    expect(styleDistance(a, a)).toBe(0);
    expect(styleDistance(a, { ...a, vpip: 0.42 })).toBeCloseTo(1, 12);
    expect(styleDistance(a, { ...a, pfr: 0.28 })).toBeCloseTo(1, 12);
    expect(styleDistance(a, { ...a, af: 3.2 })).toBeCloseTo(1, 12);
    expect(styleDistance(a, { vpip: 0.42, pfr: 0.28, af: 3.2 })).toBeCloseTo(Math.sqrt(3), 12);
    expect(styleDistance({ ...a, vpip: 0.5 }, a)).toBe(styleDistance(a, { ...a, vpip: 0.5 }));
  });
  it("does not let an extreme aggression factor run away", () => {
    expect(styleDistance({ vpip: 0, pfr: 0, af: 6 }, { vpip: 0, pfr: 0, af: 60 })).toBe(0);
  });
});
