/** Stats derived from recorded actions. Expected numbers are worked out by hand in the comments. */
import { describe, expect, it } from "vitest";
import { deriveStats, observe, styleLabel, type HandAction, type HandRecord } from "../src/history.js";
import { PRIOR } from "../src/policy.js";

const act = (player: string, street: number, type: HandAction["type"], extra: Partial<HandAction> = {}): HandAction =>
  ({ player, street, type, ...extra });
const hand = (id: string, ts: number, players: string[], actions: HandAction[]): HandRecord => ({
  id, ts, bb: 2, structure: "no_limit", board: [], players: players.map((p) => ({ id: p })), actions,
});

// H1: p raises preflop, q calls; p bets the flop, q folds to it.
const H1 = hand("h1", 1, ["p", "q"], [act("p", 0, "raise"), act("q", 0, "call"), act("p", 1, "bet"), act("q", 1, "fold")]);
// H2: q raises preflop, p folds.
const H2 = hand("h2", 2, ["p", "q"], [act("q", 0, "raise"), act("p", 0, "fold")]);
// H3: p calls preflop, q checks; flop: q bets and p calls; turn: q bets and p raises.
const H3 = hand("h3", 3, ["p", "q"], [
  act("p", 0, "call"), act("q", 0, "check"),
  act("q", 1, "bet"), act("p", 1, "call"), act("q", 2, "bet"), act("p", 2, "raise"),
]);
const FOREVER = { halfLife: 1e12 }; // no recency decay: plain counts

describe("what a single hand says about a player", () => {
  it("counts VPIP, PFR, bets, calls and the bets they faced", () => {
    expect(observe(H1, "p")).toEqual({ vpip: 1, pfr: 1, bets: 1, calls: 0, faced: 0, folded: 0 });
    expect(observe(H1, "q")).toEqual({ vpip: 1, pfr: 0, bets: 0, calls: 0, faced: 1, folded: 1 });
    expect(observe(H2, "p")).toEqual({ vpip: 0, pfr: 0, bets: 0, calls: 0, faced: 0, folded: 0 });
    expect(observe(H3, "p")).toEqual({ vpip: 1, pfr: 0, bets: 1, calls: 1, faced: 2, folded: 0 });
    expect(observe(H3, "q")).toEqual({ vpip: 0, pfr: 0, bets: 2, calls: 0, faced: 0, folded: 0 });
  });

  it("a preflop check (the big blind's option) is not voluntary money", () => {
    expect(observe(H3, "q").vpip).toBe(0);
  });

  it("an all-in counts as aggression", () => {
    const h = hand("x", 1, ["p"], [act("p", 0, "allin"), act("p", 1, "allin")]);
    expect(observe(h, "p")).toMatchObject({ vpip: 1, pfr: 1, bets: 1 });
  });

  it("a player's own bet is never a bet they 'faced' (e.g. a mistyped extra action)", () => {
    const h = hand("x", 1, ["p", "q"], [act("p", 1, "bet"), act("q", 1, "call"), act("p", 1, "fold")]);
    expect(observe(h, "p")).toMatchObject({ bets: 1, faced: 0, folded: 0 });
  });

  it("only a bet by someone else counts as 'faced', and it resets on every street", () => {
    const h = hand("x", 1, ["p", "q"], [act("q", 1, "bet"), act("p", 2, "fold")]); // the bet was on the flop
    expect(observe(h, "p").faced).toBe(0);
  });
});

describe("derived stats (default prior: vpip .28, pfr .15, af 1.5; prior weights 20 hands / 10 calls / 10 bets)", () => {
  const all = [H1, H2, H3];

  it("blends observed counts with the prior", () => {
    // p over 3 hands: vpip 2, pfr 1, bets 2, calls 1, faced 2, folded 0
    const s = deriveStats("p", all, PRIOR, undefined, FOREVER);
    expect(s.vpip).toBeCloseTo((2 + 0.28 * 20) / 23, 9); // 7.6/23
    expect(s.pfr).toBeCloseTo((1 + 0.15 * 20) / 23, 9); // 4/23
    expect(s.af).toBeCloseTo((2 + 1.5 * 10) / (1 + 10), 9); // 17/11
    expect(s.ftb).toBeCloseTo((0 + 0.28 * 10) / (2 + 10), 9); // prior fold-to-bet 0.28
    expect(s.hands).toBe(3);
    expect(s.effectiveHands).toBeCloseTo(3, 6);
  });

  it("q: faced one bet and folded it", () => {
    // q over 3 hands: vpip 2 (h1 call, h2 raise), pfr 1, bets 2, calls 0, faced 1, folded 1
    const s = deriveStats("q", all, PRIOR, undefined, FOREVER);
    expect(s.af).toBeCloseTo((2 + 15) / (0 + 10), 9); // 1.7
    expect(s.ftb).toBeCloseTo((1 + 2.8) / (1 + 10), 9); // 3.8/11
  });

  it("recent hands weigh more than old ones (half-life of one hand)", () => {
    // p's hands are 2, 1 and 0 hands old: weights .25, .5, 1
    const s = deriveStats("p", all, PRIOR, undefined, { halfLife: 1 });
    expect(s.effectiveHands).toBeCloseTo(1.75, 9);
    expect(s.vpip).toBeCloseTo((0.25 + 1 + 0.28 * 20) / (1.75 + 20), 9); // h1 and h3 voluntary: 1.25
    expect(s.af).toBeCloseTo((0.25 + 1 + 15) / (1 + 10), 9);
  });

  it("does not depend on the order hands are given in", () => {
    const a = deriveStats("p", [H3, H1, H2], PRIOR, undefined, { halfLife: 1 });
    const b = deriveStats("p", [H1, H2, H3], PRIOR, undefined, { halfLife: 1 });
    expect(a).toEqual(b);
  });

  it("ignores hands the player was not in, and works for unsaved 'anon:N' players", () => {
    const other = hand("o", 4, ["z"], [act("z", 0, "raise")]);
    expect(deriveStats("p", [...all, other], PRIOR, undefined, FOREVER).hands).toBe(3);
    const anon = hand("a", 1, ["anon:1"], [act("anon:1", 0, "raise")]);
    expect(deriveStats("anon:1", [anon], PRIOR, undefined, FOREVER).pfr).toBeCloseTo((1 + 3) / 21, 9);
  });

  it("with no history it is exactly the prior", () => {
    const style = { vpip: 0.5, pfr: 0.3, af: 3 };
    const s = deriveStats("nobody", [], style);
    expect(s.vpip).toBeCloseTo(0.5, 12);
    expect(s.pfr).toBeCloseTo(0.3, 12);
    expect(s.af).toBeCloseTo(3, 12);
    expect(s.ftb).toBeCloseTo(0.52 - 0.75 * 0.5 - 0.02 * 3, 12); // 0.085
    expect(s.hands).toBe(0);
  });

  it("evidence overrides the assigned style as hands accumulate (a 'maniac' who never plays)", () => {
    const maniac = { vpip: 0.7, pfr: 0.45, af: 4 };
    const folds = (n: number) => Array.from({ length: n }, (_, i) => hand(`f${i}`, i, ["p"], [act("p", 0, "fold")]));
    const early = deriveStats("p", folds(5), maniac, undefined, FOREVER).vpip;
    const late = deriveStats("p", folds(100), maniac, undefined, FOREVER).vpip;
    expect(early).toBeCloseTo((0.7 * 20) / 25, 9); // 0.56: still mostly the prior
    expect(late).toBeCloseTo((0.7 * 20) / 120, 9); // 0.1167: now mostly the evidence
    expect(late).toBeLessThan(early);
  });

  it("recency lets a player's style change: old tight play fades behind new loose play", () => {
    const tight = Array.from({ length: 60 }, (_, i) => hand(`t${i}`, i, ["p"], [act("p", 0, "fold")]));
    const loose = Array.from({ length: 30 }, (_, i) => hand(`l${i}`, 100 + i, ["p"], [act("p", 0, "raise")]));
    const withDecay = deriveStats("p", [...tight, ...loose], PRIOR).vpip;
    const noDecay = deriveStats("p", [...tight, ...loose], PRIOR, undefined, FOREVER).vpip;
    expect(withDecay).toBeGreaterThan(noDecay + 0.05); // the exact value is checked below
    let weighted = 0, total = 0; // by hand: the 30 loose hands weigh 0.5^(k/50), k = 0..29
    for (let k = 0; k < 30; k++) weighted += Math.pow(0.5, k / 50);
    for (let k = 0; k < 90; k++) total += Math.pow(0.5, k / 50);
    expect(withDecay).toBeCloseTo((weighted + 0.28 * 20) / (total + 20), 9);
  });

  it("legacy counters (quick manual recorder / old store) are added as plain observations", () => {
    const s = deriveStats("x", [], PRIOR, { hands: 10, vpip: 5, pfr: 2, bets: 8, calls: 4 }, FOREVER);
    expect(s.vpip).toBeCloseTo((5 + 5.6) / 30, 9);
    expect(s.pfr).toBeCloseTo((2 + 3) / 30, 9);
    expect(s.af).toBeCloseTo((8 + 15) / (4 + 10), 9);
    expect(s.hands).toBe(10);
  });

  it("PFR can never exceed VPIP", () => {
    const pure = Array.from({ length: 40 }, (_, i) => hand(`r${i}`, i, ["p"], [act("p", 0, "raise")]));
    const s = deriveStats("p", pure, { vpip: 0.1, pfr: 0.9, af: 1 });
    expect(s.pfr).toBeLessThanOrEqual(s.vpip);
  });
});

describe("style labels", () => {
  it("name loose/tight and aggressive/passive", () => {
    expect(styleLabel(0.4, 1.5)).toBe("loose");
    expect(styleLabel(0.1, 3)).toBe("tight-aggressivo");
    expect(styleLabel(0.28, 0.5)).toBe("medio-passivo");
    expect(styleLabel(0.28, 1.5)).toBe("medio");
  });
});
