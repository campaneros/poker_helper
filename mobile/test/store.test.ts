/** The event log: integrity, recovery, replay semantics and migration from the interim store. */
import { describe, expect, it } from "vitest";
import {
  EVENTS_KEY, LEGACY_PLAYERS_KEY, appendEvents, checksum, loadState, readEvents, reduceEvents,
  type StorageLike, type StoreEvent,
} from "../src/store.js";

const memory = (initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const player = (id: string, name = id, ts = 1): StoreEvent => ({ t: "player", id, name, ts });
const hand = (id: string, ts = 1) => ({ id, ts, bb: 2, structure: "no_limit" as const, board: [], players: [{ id: "a" }], actions: [] });

describe("checksum", () => {
  it("is deterministic and sensitive to any change", () => {
    expect(checksum("abc")).toBe(checksum("abc"));
    expect(checksum("abc")).not.toBe(checksum("abd"));
    expect(checksum("")).toBe("811c9dc5"); // FNV-1a offset basis
  });
});

describe("append and read", () => {
  it("round-trips events in order, across separate appends", () => {
    const s = memory();
    appendEvents(s, [player("a"), player("b")]);
    appendEvents(s, [{ t: "player_del", id: "a", ts: 2 }]);
    const { events, skipped } = readEvents(s);
    expect(skipped).toBe(0);
    expect(events.map((e) => e.t)).toEqual(["player", "player", "player_del"]);
  });

  it("an empty or missing log is simply empty", () => {
    expect(readEvents(memory())).toEqual({ events: [], skipped: 0 });
    expect(readEvents(memory({ [EVENTS_KEY]: "" }))).toEqual({ events: [], skipped: 0 });
  });

  it("a line edited behind our back (checksum mismatch) is skipped, the others survive", () => {
    const s = memory();
    appendEvents(s, [player("a", "Anna"), player("b", "Bruno"), player("c", "Carla")]);
    const lines = (s.data.get(EVENTS_KEY) as string).split("\n");
    lines[1] = lines[1].replace("Bruno", "Mallory");
    s.data.set(EVENTS_KEY, lines.join("\n"));
    const { events, skipped } = readEvents(s);
    expect(skipped).toBe(1);
    expect(events.map((e) => (e as any).name)).toEqual(["Anna", "Carla"]);
  });

  it("a truncated last line (crash mid-write) loses only that event, and new events still append cleanly", () => {
    const s = memory();
    appendEvents(s, [player("a"), player("b")]);
    s.data.set(EVENTS_KEY, (s.data.get(EVENTS_KEY) as string).slice(0, -20)); // cut into the last line
    expect(readEvents(s)).toMatchObject({ skipped: 1, events: [{ id: "a" }] });
    appendEvents(s, [player("c")]);
    const { events, skipped } = readEvents(s);
    expect(events.map((e) => (e as any).id)).toEqual(["a", "c"]);
    expect(skipped).toBe(1);
  });

  it("garbage lines, blank lines and wrong shapes are skipped without throwing", () => {
    const s = memory({ [EVENTS_KEY]: ["not json", "", '{"e":1,"h":"x"}', '{"e":{"t":"player"},"h":"x"}', "null"].join("\n") });
    expect(readEvents(s)).toEqual({ events: [], skipped: 4 });
  });

  it("unreadable storage degrades to an empty log", () => {
    const broken: StorageLike = { getItem: () => { throw new Error("denied"); }, setItem: () => undefined };
    expect(readEvents(broken)).toEqual({ events: [], skipped: 1 });
  });
});

describe("replaying the log", () => {
  it("players: add, rename by re-adding, delete", () => {
    const st = reduceEvents([player("a", "Anna"), player("b"), { t: "player_del", id: "b", ts: 2 }]);
    expect([...st.players.keys()]).toEqual(["a"]);
  });

  it("assigning a style, and deleting that style unassigns it", () => {
    const st = reduceEvents([
      player("a"), { t: "style", id: "s1", name: "mio", vpip: 0.3, pfr: 0.2, af: 2, ts: 1 },
      { t: "assign", player: "a", style: "s1", ts: 2 },
    ]);
    expect(st.players.get("a")?.style_id).toBe("s1");
    const gone = reduceEvents([
      player("a"), { t: "style", id: "s1", name: "mio", vpip: 0.3, pfr: 0.2, af: 2, ts: 1 },
      { t: "assign", player: "a", style: "s1", ts: 2 }, { t: "style_del", id: "s1", ts: 3 },
    ]);
    expect(gone.players.get("a")?.style_id).toBeNull();
    expect(gone.styles.size).toBe(0);
  });

  it("events about unknown players are ignored", () => {
    const st = reduceEvents([{ t: "assign", player: "ghost", style: "x", ts: 1 }, { t: "legacy", player: "ghost", ts: 1, hands: 1, vpip: 1, pfr: 0, bets: 0, calls: 0 }]);
    expect(st.players.size).toBe(0);
  });

  it("a hand event with an existing id amends it; hand_del removes it; the log keeps every step", () => {
    const events: StoreEvent[] = [
      { t: "hand", hand: hand("h1"), ts: 1 },
      { t: "hand", hand: { ...hand("h1"), bb: 4 }, ts: 2 },
      { t: "hand", hand: hand("h2"), ts: 3 },
      { t: "hand_del", id: "h2", ts: 4 },
    ];
    const st = reduceEvents(events);
    expect([...st.hands.keys()]).toEqual(["h1"]);
    expect(st.hands.get("h1")?.bb).toBe(4);
    expect(events.length).toBe(4); // nothing was overwritten in the log itself
  });

  it("legacy counters accumulate", () => {
    const l = (hands: number): StoreEvent => ({ t: "legacy", player: "a", ts: 1, hands, vpip: hands, pfr: 0, bets: 1, calls: 2 });
    const st = reduceEvents([player("a"), l(3), l(4)]);
    expect(st.players.get("a")?.legacy).toEqual({ hands: 7, vpip: 7, pfr: 0, bets: 2, calls: 4 });
  });

  it("replaying the same log twice gives the same state (deterministic)", () => {
    const events = [player("a"), { t: "hand", hand: hand("h1"), ts: 2 } as StoreEvent];
    expect(reduceEvents(events)).toEqual(reduceEvents(events));
  });
});

describe("migration from the interim players store", () => {
  const interim = JSON.stringify([
    { id: "p1", name: "Mario", hands: 12, vpip: 5, pfr: 2, bets: 7, calls: 3 },
    { id: "p2", name: "NoHands", hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0 },
    { id: "p3", name: "Damaged", hands: -1, vpip: 0, pfr: 0, bets: 0, calls: 0 },
    { id: 4, name: "BadId", hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0 },
  ]);

  it("turns players and counters into events, skips damaged records, and leaves the old key alone", () => {
    const s = memory({ [LEGACY_PLAYERS_KEY]: interim });
    const st = loadState(s);
    expect([...st.players.keys()].sort()).toEqual(["p1", "p2"]);
    expect(st.players.get("p1")?.legacy).toEqual({ hands: 12, vpip: 5, pfr: 2, bets: 7, calls: 3 });
    expect(s.data.get(LEGACY_PLAYERS_KEY)).toBe(interim);
  });

  it("runs once: loading again does not duplicate counters", () => {
    const s = memory({ [LEGACY_PLAYERS_KEY]: interim });
    loadState(s);
    expect(loadState(s).players.get("p1")?.legacy.hands).toBe(12);
  });

  it("does nothing when the log already exists, or when the old store is unreadable", () => {
    const withLog = memory({ [LEGACY_PLAYERS_KEY]: interim });
    appendEvents(withLog, [player("x")]);
    expect([...loadState(withLog).players.keys()]).toEqual(["x"]);
    for (const bad of ["{oops", '{"a":1}', "null"]) {
      expect(loadState(memory({ [LEGACY_PLAYERS_KEY]: bad })).players.size).toBe(0);
    }
  });
});

describe("rename events", () => {
  it("change only the name, and are ignored for a player who is gone", () => {
    const s = memory();
    appendEvents(s, [
      player("a", "Anna"), { t: "assign", player: "a", style: "builtin:tag", ts: 2 },
      { t: "rename", id: "a", name: "Annina", ts: 3 }, { t: "rename", id: "ghost", name: "Nessuno", ts: 4 },
      player("b", "Bruno"), { t: "player_del", id: "b", ts: 5 }, { t: "rename", id: "b", name: "Bruno II", ts: 6 },
    ]);
    const state = reduceEvents(readEvents(s).events);
    expect([...state.players.values()].map((p) => [p.id, p.name, p.style_id])).toEqual([["a", "Annina", "builtin:tag"]]);
  });
});
