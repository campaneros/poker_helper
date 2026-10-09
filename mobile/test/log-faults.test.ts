/** Fault injection on the event log: torn writes, damage in the middle of the file, a full or blocked storage,
 * double submits and random amend sequences. The log is the only copy of the user's players and hands. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Weights } from "../../core/src/advisor.js";
import type { HandRecord } from "../../core/src/history.js";
import { createLocalApi } from "../src/localApi.js";
import {
  EVENTS_KEY, StorageWriteError, appendEvents, readEvents, reduceEvents, type StorageLike, type StoreEvent,
} from "../src/store.js";

const weights = JSON.parse(readFileSync(new URL("../../core/weights.json", import.meta.url), "utf8")) as Weights;
const memory = (initial = ""): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>(initial ? [[EVENTS_KEY, initial]] : []);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const player = (id: string, ts = 1): StoreEvent => ({ t: "player", id, name: id, ts });
const handOf = (id: string, ts: number, actions: HandRecord["actions"] = []): HandRecord => ({
  id, ts, bb: 2, structure: "no_limit", board: [], players: [{ id: "a" }], actions,
});
const handEvent = (id: string, ts: number, actions: HandRecord["actions"] = []): StoreEvent =>
  ({ t: "hand", hand: handOf(id, ts, actions), ts });

describe("a write cut short at any byte", () => {
  const base: StoreEvent[] = [player("a"), player("b"), handEvent("h1", 5), { t: "assign", player: "a", style: "builtin:tag", ts: 6 }];
  const last: StoreEvent = handEvent("h2", 7, [{ player: "a", street: 0, type: "raise", amount: 6, pot_before: 3 }]);

  const fullLog = (() => { const s = memory(); appendEvents(s, [...base, last]); return s.data.get(EVENTS_KEY) as string; })();
  const baseLog = (() => { const s = memory(); appendEvents(s, base); return s.data.get(EVENTS_KEY) as string; })();

  it("keeps every earlier event, and either the whole last event or none of it", () => {
    expect(fullLog.startsWith(baseLog)).toBe(true);
    for (let cut = baseLog.length; cut <= fullLog.length; cut++) {
      const { events, skipped } = readEvents(memory(fullLog.slice(0, cut)));
      expect(events.slice(0, base.length)).toEqual(base);
      expect(events.length === base.length || events.length === base.length + 1).toBe(true);
      if (events.length === base.length + 1) expect(events[base.length]).toEqual(last);
      expect(skipped).toBeLessThanOrEqual(1); // the torn line, never more
      if (cut === baseLog.length) expect(skipped).toBe(0);
    }
  });

  it("recovers: the next event is appended on its own line and nothing earlier is lost", () => {
    const next = player("c", 9);
    for (let cut = baseLog.length + 1; cut < fullLog.length - 1; cut++) { // strictly inside the last line
      const s = memory(fullLog.slice(0, cut));
      appendEvents(s, [next]);
      const { events, skipped } = readEvents(s);
      expect(events).toEqual([...base, next]);
      expect(skipped).toBe(1); // the torn line is kept in the file but ignored
      expect(s.data.get(EVENTS_KEY)!.includes(fullLog.slice(baseLog.length, cut))).toBe(true);
    }
  });
});

describe("damage in the middle of the file", () => {
  const events: StoreEvent[] = [player("a"), player("b"), handEvent("h1", 5), player("c"), handEvent("h2", 6)];
  const lines = (() => { const s = memory(); appendEvents(s, events); return (s.data.get(EVENTS_KEY) as string).split("\n").filter(Boolean); })();

  it("changing any single character of a line drops exactly that event and keeps the rest in order", () => {
    const target = 2;
    for (let i = 0; i < lines[target].length; i++) {
      const damaged = lines[target].slice(0, i) + (lines[target][i] === "#" ? "$" : "#") + lines[target].slice(i + 1);
      const copy = [...lines]; copy[target] = damaged;
      const { events: read, skipped } = readEvents(memory(copy.join("\n") + "\n"));
      expect(read).toEqual(events.filter((_, k) => k !== target));
      expect(skipped).toBe(1);
    }
  });

  it("a damaged line is never deleted by later writes", () => {
    const copy = [...lines]; copy[1] = copy[1].slice(0, 10);
    const s = memory(copy.join("\n") + "\n");
    appendEvents(s, [player("z", 20)]);
    appendEvents(s, [player("y", 21)]);
    expect(s.data.get(EVENTS_KEY)!.split("\n")).toContain(copy[1]);
    expect(readEvents(s).skipped).toBe(1);
  });

  it("a line with garbage, an empty object or the wrong shape is skipped, not fatal", () => {
    const s = memory(["not json", "{}", '{"e":{"t":1},"h":"x"}', lines[0], "[]", "null", lines[1]].join("\n") + "\n");
    const { events: read, skipped } = readEvents(s);
    expect(read).toEqual([events[0], events[1]]);
    expect(skipped).toBe(5);
  });
});

describe("a full or blocked storage", () => {
  const limited = (cap: number): StorageLike & { data: Map<string, string> } => {
    const s = memory();
    return { ...s, setItem: (k, v) => { if (v.length > cap) throw new DOMException("quota", "QuotaExceededError"); s.data.set(k, v); } };
  };

  it("refuses the write, leaves the log byte-identical, and says so", () => {
    const s = limited(400);
    appendEvents(s, [player("a")]);
    const before = s.data.get(EVENTS_KEY);
    expect(() => appendEvents(s, [handEvent("h1", 5, Array.from({ length: 30 }, () => ({ player: "a", street: 0, type: "call" as const })))]))
      .toThrow(StorageWriteError);
    expect(s.data.get(EVENTS_KEY)).toBe(before);
    expect(readEvents(s).events).toEqual([player("a")]);
  });

  it("a storage that cannot even be read is reported as a write failure", () => {
    const blocked: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
    expect(() => appendEvents(blocked, [player("a")])).toThrow(StorageWriteError);
    expect(readEvents(blocked)).toEqual({ events: [], skipped: 1 }); // reading never throws
  });

  it("the API answers 507 with a message, and the hand is not half-saved", async () => {
    let full = false;
    const s = memory();
    const store: StorageLike = { getItem: (k) => s.getItem(k), setItem: (k, v) => { if (full) throw new Error("quota"); s.setItem(k, v); } };
    const api = createLocalApi(store, weights);
    const id = ((await api("POST", "/players", { name: "Mario" })).body as { id: string }).id;
    full = true;
    const hand = { bb: 2, board: [], players: [{ id }], actions: [{ player: id, street: 0, type: "raise", amount: 6 }] };
    const bad = await api("POST", "/hands", hand);
    expect(bad.status).toBe(507);
    expect(String((bad.body as any).detail)).toMatch(/NON è stata salvata/);
    expect(((await api("GET", "/hands")).body as unknown[]).length).toBe(0);
    full = false;
    expect((await api("POST", "/hands", hand)).status).toBe(200); // the same request works once there is room
    expect(((await api("GET", "/hands")).body as unknown[]).length).toBe(1);
  });
});

describe("saving twice", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  it("a repeated request with the same id records one hand and keeps its original time", async () => {
    const api = createLocalApi(memory(), weights);
    const id = ((await api("POST", "/players", { name: "Mario" })).body as { id: string }).id;
    const body = { id: "h_double_tap", bb: 2, board: [], players: [{ id }], actions: [{ player: id, street: 0, type: "raise", amount: 6 }] };
    const first = (await api("POST", "/hands", body)).body as HandRecord;
    vi.setSystemTime(2_000_000);
    const second = (await api("POST", "/hands", body)).body as HandRecord;
    expect(second).toEqual(first);
    expect(((await api("GET", "/hands")).body as unknown[]).length).toBe(1);
  });

  it("rejects a malformed id instead of storing it", async () => {
    const api = createLocalApi(memory(), weights);
    const bad = await api("POST", "/hands", { id: "../x", bb: 2, board: [], players: [{ id: "p" }], actions: [] });
    expect(bad.status).toBe(422);
  });
});

describe("amending", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  const raise = (p: string) => ({ player: p, street: 0, type: "raise", amount: 6, pot_before: 3 });
  const fold = (p: string) => ({ player: p, street: 0, type: "fold" });

  it("changes only the amended hand: replaying gives exactly what recording it right the first time would have", async () => {
    const run = async (secondHand: (id: string) => object[]) => {
      const api = createLocalApi(memory(), weights);
      const id = ((await api("POST", "/players", { name: "Mario" })).body as { id: string }).id;
      const ids: string[] = [];
      for (const [n, acts] of [[1, [raise(id)]], [2, secondHand(id)], [3, [fold(id)]]] as const) {
        vi.setSystemTime(1_000_000 + n * 1000);
        ids.push(((await api("POST", "/hands", { bb: 2, board: [], players: [{ id }], actions: acts })).body as HandRecord).id);
      }
      return { api, id, ids };
    };
    const wrongThenFixed = await run((id) => [raise(id)]);
    const originalHands = ((await wrongThenFixed.api("GET", "/hands")).body as HandRecord[]).map((h) => h.id).sort();
    vi.setSystemTime(9_000_000);
    const put = await wrongThenFixed.api("PUT", `/hands/${wrongThenFixed.ids[1]}`, {
      bb: 2, board: [], players: [{ id: wrongThenFixed.id }], actions: [fold(wrongThenFixed.id)],
    });
    expect(put.status).toBe(200);
    const direct = await run((id) => [fold(id)]);
    const view = async (r: typeof direct) => ({
      hands: ((await r.api("GET", "/hands")).body as HandRecord[]).map(({ bb, board, actions, ts }) => ({ bb, board, actions: actions.map((a) => a.type), ts })),
      stats: ((await r.api("GET", "/players")).body as any[])[0],
    });
    const a = await view(wrongThenFixed), b = await view(direct);
    const { id: _a, ...statsA } = a.stats, { id: _b, ...statsB } = b.stats;
    expect(statsA).toEqual(statsB);
    expect(a.hands).toEqual(b.hands); // same actions AND the same original times: recency order is preserved
    expect(((await wrongThenFixed.api("GET", "/hands")).body as HandRecord[]).map((h) => h.id).sort()).toEqual(originalHands);
  });

  it("refuses an edit that makes the hand impossible, and leaves the stored hand untouched", async () => {
    const api = createLocalApi(memory(), weights);
    const id = ((await api("POST", "/players", { name: "Mario" })).body as { id: string }).id;
    const good = { bb: 2, board: [], players: [{ id }], actions: [raise(id)] };
    const saved = (await api("POST", "/hands", good)).body as HandRecord;
    for (const actions of [
      [fold(id), raise(id)], // acts after folding
      [{ player: id, street: 1, type: "bet", amount: 4 }], // flop action with no flop
      [{ player: id, street: 1, type: "bet" }, { player: id, street: 0, type: "call" }], // streets out of order
    ]) {
      const r = await api("PUT", `/hands/${saved.id}`, { ...good, actions });
      expect(r.status).toBe(422);
    }
    expect((await api("GET", "/hands")).body).toEqual([saved]);
  });
});

describe("input the API must not let through", () => {
  it("refuses a style id it could never delete, and a street that is not a whole number", async () => {
    const api = createLocalApi(memory(), weights);
    expect((await api("POST", "/styles", { id: "mio stile", name: "X", vpip: 0.3, pfr: 0.2, af: 2 })).status).toBe(422);
    expect((await api("POST", "/styles", { id: "mio_stile", name: "X", vpip: 0.3, pfr: 0.2, af: 2 })).status).toBe(200);
    expect((await api("DELETE", "/styles/mio_stile")).status).toBe(200);
    const bad = await api("POST", "/hands", { bb: 2, board: ["2c", "7d", "9h"], players: [{ id: "p" }], actions: [{ player: "p", street: 0.5, type: "bet", amount: 4 }] });
    expect(bad.status).toBe(422);
    expect(((await api("GET", "/hands")).body as unknown[]).length).toBe(0);
  });

  it("reports the size of the log even when the storage cannot be read", async () => {
    const blocked: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
    const r = await createLocalApi(blocked, weights)("GET", "/storage");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bytes: 0 });
  });

  it("answers 422 for bad input but does not hide a programming error behind it", async () => {
    const ask = (api: ReturnType<typeof createLocalApi>, extra: object = {}) =>
      api("POST", "/advise", { hero: ["Ah", "As"], board: [], bb: 2, pot: 3, to_call: 1, stack: 20, opponents: [{}], ...extra });
    expect((await ask(createLocalApi(memory(), weights), { hero: ["Ah", "Ah"] })).status).toBe(422); // a duplicate card
    expect((await ask(createLocalApi(memory(), weights), { hero: ["Ah", "Zz"] })).status).toBe(422); // a card that does not exist
    // a broken table is a bug of ours, not of the user: it must throw, not come back as "your input is wrong"
    await expect(ask(createLocalApi(memory(), weights, {} as never))).rejects.toThrow(TypeError);
  });
});

describe("random sequences of creates, amends and deletes", () => {
  it("fold to exactly the state a plain model predicts, also after a trip through the file format", () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let run = 0; run < 200; run++) {
      const events: StoreEvent[] = [];
      const model = new Map<string, HandRecord>();
      for (let step = 0; step < 40; step++) {
        const id = "h" + rnd(6);
        if (rnd(4) === 0) { events.push({ t: "hand_del", id, ts: step }); model.delete(id); }
        else {
          const h = handOf(id, rnd(1000), Array.from({ length: rnd(4) }, () => ({ player: "a", street: 0, type: "call" as const })));
          events.push({ t: "hand", hand: h, ts: step }); model.set(id, h);
        }
      }
      const s = memory();
      for (const e of events) appendEvents(s, [e]); // one append per event, like the app does
      const state = reduceEvents(readEvents(s).events);
      expect([...state.hands.entries()].sort()).toEqual([...model.entries()].sort());
    }
  });
});
