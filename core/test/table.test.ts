/** The betting engine: turns, blinds, streets, pot, what hero owes and who raised last. Every expected number below is
 * worked out by hand from the rules of the game, not copied from the engine's output. */
import { describe, expect, it } from "vitest";
import {
  apply, minRaiseTo, nextToAct, pot, positionOf, replay, skippedBefore, start, toCall,
  type TableAction, type TableSetup, type TableState,
} from "../src/table.js";

const setup = (seats: string[], first: number, bb = 2): TableSetup => ({ seats, first, bb });
const run = (s: TableSetup, actions: TableAction[]): TableState => {
  const r = replay(s, actions);
  if ("error" in r) throw new Error(`${r.error} (azione ${r.at})`);
  return r.state;
};
const begin = (s: TableSetup): TableState => {
  const r = start(s);
  if ("error" in r) throw new Error(r.error);
  return r.state;
};
const act = (who: string, type: TableAction["type"], amount?: number): TableAction => ({ who, type, ...(amount !== undefined ? { amount } : {}) });

describe("the start of a hand", () => {
  it("six-handed: the first to act is under the gun, so the button is three seats before him", () => {
    const s = begin(setup(["A", "B", "C", "D", "E", "F"], 3)); // D is first to act
    expect([s.button, s.smallBlind, s.bigBlind]).toEqual([0, 1, 2]);
    expect(s.committed).toMatchObject({ B: 1, C: 2, A: 0, D: 0 });
    expect(pot(s)).toBe(3);
    expect(nextToAct(s)).toBe("D");
  });
  it("wraps around the circle", () => {
    const s = begin(setup(["A", "B", "C", "D", "E"], 1)); // B first to act: the button is three seats back, (1 - 3) mod 5
    expect(s.button).toBe(3);
    expect([s.smallBlind, s.bigBlind]).toEqual([4, 0]);
    expect(nextToAct(s)).toBe("B");
  });
  it("three-handed the first to act is the button, who is not a blind", () => {
    const s = begin(setup(["A", "B", "C"], 0));
    expect([s.button, s.smallBlind, s.bigBlind]).toEqual([0, 1, 2]);
  });
  it("heads-up the button is the small blind and acts first", () => {
    const s = begin(setup(["A", "B"], 0));
    expect([s.button, s.smallBlind, s.bigBlind]).toEqual([0, 0, 1]);
    expect(s.committed).toMatchObject({ A: 1, B: 2 });
    expect(toCall(s, "A")).toBe(1);
  });
  it("refuses an impossible table", () => {
    expect("error" in start(setup(["A"], 0))).toBe(true);
    expect("error" in start(setup(["A", "A"], 0))).toBe(true);
    expect("error" in start(setup(["A", "B"], 2))).toBe(true);
    expect("error" in start(setup(["A", "B"], 0, 0))).toBe(true);
    expect("error" in start(setup(Array.from({ length: 11 }, (_, i) => "p" + i), 0))).toBe(true);
  });
});

describe("a hand from the first action to the river", () => {
  // A (button, first to act), B small blind, C big blind. Blinds 1/2.
  const s0 = setup(["A", "B", "C"], 0);

  it("raise, call, fold: the pot is what everybody put in, and the flop opens with the small blind", () => {
    const s = run(s0, [act("A", "raise", 6), act("B", "call"), act("C", "fold")]);
    expect(pot(s)).toBe(6 + 6 + 2); // A 6, B 1 + 5 added, C's dead big blind
    expect(s.street).toBe(1);
    expect(s.current).toBe(0);
    expect(nextToAct(s)).toBe("B");
    expect(s.folded).toEqual(["C"]);
  });

  it("records the street, the pot before each action and the amounts (call = chips added)", () => {
    const s = run(s0, [act("A", "raise", 6), act("B", "call"), act("C", "fold"), act("B", "bet", 8), act("A", "call")]);
    expect(s.steps.map((x) => [x.who, x.type, x.amount, x.street, x.pot_before])).toEqual([
      ["A", "raise", 6, 0, 3],
      ["B", "call", 5, 0, 9],
      ["C", "fold", undefined, 0, 14],
      ["B", "bet", 8, 1, 14],
      ["A", "call", 8, 1, 22],
    ]);
    expect(pot(s)).toBe(30);
    expect(s.street).toBe(2);
  });

  it("the big blind has the option when everybody limps, and the street does not close before he acts", () => {
    let s = run(s0, [act("A", "call"), act("B", "call")]);
    expect(s.street).toBe(0);
    expect(nextToAct(s)).toBe("C");
    expect(toCall(s, "C")).toBe(0);
    s = run(s0, [act("A", "call"), act("B", "call"), act("C", "check")]);
    expect(s.street).toBe(1);
    expect(pot(s)).toBe(6);
  });

  it("an all-in that is less than a full raise does not lower the minimum raise", () => {
    const s = run(setup(["A", "B", "C"], 0, 10), [act("A", "raise", 30), act("B", "allin", 35)]);
    expect(s.current).toBe(35);
    expect(s.lastRaise).toMatchObject({ who: "B", to: 35 }); // still the last to raise, for display
    expect(minRaiseTo(s)).toBe(55); // a full raise is still 20 on top of the bet, not the 5 the shove added
    const full = run(setup(["A", "B", "C"], 0, 10), [act("A", "raise", 30), act("B", "allin", 60)]);
    expect(minRaiseTo(full)).toBe(90); // 30 more on top of 60: a full all-in raise does reset it
  });

  it("the minimum raise starts again on every street", () => {
    const s = run(s0, [act("A", "raise", 6), act("B", "call"), act("C", "call")]);
    expect(minRaiseTo(s)).toBe(2); // nothing bet yet on the flop: one big blind
  });

  it("a re-raise reopens the action for the original raiser", () => {
    const s = run(s0, [act("A", "raise", 6), act("B", "raise", 18), act("C", "fold")]);
    expect(nextToAct(s)).toBe("A");
    expect(toCall(s, "A")).toBe(12);
    expect(s.lastRaise).toMatchObject({ who: "B", to: 18, size: 12 });
    expect(minRaiseTo(s)).toBe(30); // another 12 on top of 18
    const done = run(s0, [act("A", "raise", 6), act("B", "raise", 18), act("C", "fold"), act("A", "call")]);
    expect(done.street).toBe(1);
    expect(pot(done)).toBe(18 + 18 + 2);
  });

  it("everyone checks through every street and the hand ends at the river", () => {
    const pre = [act("A", "call"), act("B", "call"), act("C", "check")];
    const street = [act("B", "check"), act("C", "check"), act("A", "check")]; // small blind first, button last
    const s = run(s0, [...pre, ...street, ...street, ...street]);
    expect(s.over).toBe("showdown");
    expect(nextToAct(s)).toBeNull();
    expect("error" in apply(s, act("B", "check"))).toBe(true);
  });

  it("heads-up the big blind acts first after the flop, and the button last", () => {
    const s = run(setup(["A", "B"], 0), [act("A", "call"), act("B", "check")]);
    expect(s.street).toBe(1);
    expect(nextToAct(s)).toBe("B");
  });

  it("when everybody else folds the hand is over and the rest of the table is not asked", () => {
    const s = run(s0, [act("A", "raise", 6), act("B", "fold"), act("C", "fold")]);
    expect(s.over).toBe("fold");
    expect(nextToAct(s)).toBeNull();
    expect(pot(s)).toBe(6 + 1 + 2);
  });
});

describe("all-in", () => {
  const s0 = setup(["A", "B", "C"], 0);
  it("a shove called by two players who still have chips: they keep betting among themselves on the next street", () => {
    const s = run(s0, [act("A", "allin", 40), act("B", "call"), act("C", "call")]);
    expect(pot(s)).toBe(120);
    expect(s.over).toBeNull();
    expect(s.street).toBe(1);
    expect(nextToAct(s)).toBe("B");
  });
  it("when everybody is all-in, or only one player could still bet, the board runs out with no more betting", () => {
    const all = run(s0, [act("A", "allin", 40), act("B", "allin", 40), act("C", "allin", 40)]);
    expect(all.over).toBe("showdown");
    expect(pot(all)).toBe(120);
    const heads = run(setup(["A", "B"], 0), [act("A", "allin", 30), act("B", "call")]);
    expect(heads.over).toBe("showdown");
    expect(pot(heads)).toBe(60);
  });
  it("an all-in smaller than the bet is a short call and does not reopen the action", () => {
    const s = run(s0, [act("A", "raise", 20), act("B", "allin", 12), act("C", "call")]);
    expect(s.current).toBe(0); // the street closed and a new one started
    expect(s.lastRaise).toMatchObject({ who: "A", to: 20 });
    expect(pot(s)).toBe(20 + 12 + 20);
    expect(s.street).toBe(1);
    expect(nextToAct(s)).toBe("C"); // B is all-in and out of the betting; C is first among the live players
  });
  it("a player who is all-in is never asked again on later streets", () => {
    const s = run(s0, [act("A", "call"), act("B", "allin", 10), act("C", "call"), act("A", "call")]);
    expect(s.street).toBe(1);
    expect(nextToAct(s)).toBe("C");
    const after = run(s0, [act("A", "call"), act("B", "allin", 10), act("C", "call"), act("A", "call"), act("C", "check"), act("A", "check")]);
    expect(after.street).toBe(2);
  });
});

describe("what is refused", () => {
  const s0 = setup(["A", "B", "C"], 0);
  const bad = (actions: TableAction[], msg: RegExp) => {
    const r = replay(s0, actions);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(msg);
  };
  it("acting out of turn", () => bad([act("B", "call")], /tocca a A/));
  it("checking against a bet", () => bad([act("A", "check")], /check/));
  it("calling when there is nothing to call", () => bad([act("A", "call"), act("B", "call"), act("C", "call")], /niente da chiamare/));
  it("a raise that does not beat the bet", () => bad([act("A", "raise", 2)], /superare/));
  it("a raise with no amount", () => bad([act("A", "raise")], /superare/));
  it("a bet when there already is one", () => bad([act("A", "bet", 6)], /raise/));
  it("a raise when nobody has bet (after the flop)", () =>
    bad([act("A", "call"), act("B", "call"), act("C", "check"), act("B", "raise", 4)], /bet/));
  it("acting after the hand is over", () => bad([act("A", "raise", 6), act("B", "fold"), act("C", "fold"), act("A", "check")], /finita/));
  it("acting after folding", () =>
    bad([act("A", "fold"), act("B", "call"), act("C", "check"), act("B", "check"), act("C", "check"), act("A", "check")], /tocca a/));
  it("reports the index of the offending action", () => {
    const r = replay(s0, [act("A", "raise", 6), act("B", "check")]);
    expect(r).toMatchObject({ at: 1 });
  });
});

describe("skipped players", () => {
  const s0 = setup(["A", "B", "C", "D"], 3); // D first, button A, blinds B and C
  it("fold those who owe chips and check those who do not, up to the one who acts", () => {
    const s = begin(s0);
    expect(skippedBefore(s, "D")).toEqual([]);
    expect(skippedBefore(s, "B")).toEqual([act("D", "fold"), act("A", "fold")]);
    const limped = run(s0, [act("D", "call"), act("A", "call"), act("B", "call")]);
    expect(skippedBefore(limped, "C")).toEqual([]);
    const flop = run(s0, [act("D", "call"), act("A", "call"), act("B", "call"), act("C", "check")]);
    expect(skippedBefore(flop, "A")).toEqual([act("B", "check"), act("C", "check"), act("D", "check")]); // free to check: not folded
  });
  it("refuses a player who cannot act", () => {
    const s = run(s0, [act("D", "raise", 6), act("A", "fold"), act("B", "fold"), act("C", "fold")]);
    expect(skippedBefore(s, "A")).toEqual({ error: "la mano è finita" });
  });
});

describe("what the advisor needs", () => {
  const s0 = setup(["A", "B", "C", "D", "E", "F"], 3);
  it("positions run from the first to act after the flop (0) to the button (1)", () => {
    const s = begin(s0);
    expect(positionOf(s, "B")).toBe(0); // small blind
    expect(positionOf(s, "A")).toBe(1); // button
    expect(positionOf(s, "F")).toBeCloseTo(0.8, 12);
    expect(positionOf(begin(setup(["A", "B"], 0)), "A")).toBe(1);
    expect(positionOf(s, "nobody")).toBe(0.5);
  });
  it("hero owes the difference between the bet and what he already put in", () => {
    const s = run(s0, [act("D", "raise", 6), act("E", "call"), act("F", "fold"), act("A", "fold"), act("B", "call")]);
    expect(toCall(s, "C")).toBe(4); // big blind 2 against 6
    expect(pot(s)).toBe(6 + 6 + 6 + 2); // D, E, B (1 + 5 added) and the big blind C
    expect(nextToAct(s)).toBe("C");
  });
  it("does not change the state it was given", () => {
    const s = begin(s0);
    const before = JSON.stringify(s);
    apply(s, act("D", "raise", 6));
    skippedBefore(s, "B");
    expect(JSON.stringify(s)).toBe(before);
  });
});
