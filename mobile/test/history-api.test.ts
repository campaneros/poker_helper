/** Styles, hand history and adaptive stats through the on-device API. Expected stats are worked out by hand. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Weights } from "../../core/src/advisor.js";
import { createLocalApi, type StorageLike } from "../src/localApi.js";
import { EVENTS_KEY } from "../src/store.js";

const weights = JSON.parse(readFileSync(new URL("../../core/weights.json", import.meta.url), "utf8")) as Weights;
const memory = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

let clock = 0;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); clock = 1_000_000; vi.setSystemTime(clock); });
afterEach(() => vi.useRealTimers());
const tick = () => vi.setSystemTime((clock += 1000)); // every recorded hand gets a later timestamp

const setup = () => {
  const store = memory();
  const api = createLocalApi(store, weights);
  const call = async (m: string, p: string, b?: unknown) => api(m, p, b);
  return { store, call };
};
const newPlayer = async (call: ReturnType<typeof setup>["call"], name = "Mario") =>
  ((await call("POST", "/players", { name })).body as { id: string }).id;

const handBody = (id: string, actions: object[], extra: object = {}) => ({
  bb: 2, structure: "no_limit", board: [], players: [{ id }], actions, ...extra,
});
const raisePreflop = (id: string) => ({ player: id, street: 0, type: "raise", amount: 6, pot_before: 3 });
const foldPreflop = (id: string) => ({ player: id, street: 0, type: "fold" });

describe("styles", () => {
  it("lists the five built-in styles; custom styles are created, validated and deleted", async () => {
    const { call } = setup();
    expect(((await call("GET", "/styles")).body as any[]).map((s) => s.id)).toEqual(
      ["builtin:nit", "builtin:tag", "builtin:lag", "builtin:fish", "builtin:maniac"]);
    const made = (await call("POST", "/styles", { name: "Il mio", vpip: 0.3, pfr: 0.2, af: 2 })).body as any;
    expect(made.id).toMatch(/^s_/);
    expect(((await call("GET", "/styles")).body as any[]).length).toBe(6);
    expect((await call("DELETE", `/styles/${made.id}`)).status).toBe(200);
    expect(((await call("GET", "/styles")).body as any[]).length).toBe(5);
  });

  it("rejects bad values and any change to built-in styles", async () => {
    const { call } = setup();
    const ok = { name: "x", vpip: 0.3, pfr: 0.2, af: 2 };
    for (const bad of [{ ...ok, name: " " }, { ...ok, vpip: 1.5 }, { ...ok, pfr: 0.4 }, { ...ok, af: -1 }, { ...ok, vpip: "a" }]) {
      expect((await call("POST", "/styles", bad)).status).toBe(422);
    }
    expect((await call("POST", "/styles", { ...ok, id: "builtin:nit" })).status).toBe(422);
    expect((await call("DELETE", "/styles/builtin:nit")).status).toBe(422);
    expect((await call("DELETE", "/styles/s_nope")).status).toBe(404);
  });

  it("an assigned style is the player's starting point: a maniac with no hands is exactly a maniac", async () => {
    const { call } = setup();
    const id = await newPlayer(call);
    const before = (await call("GET", "/players")).body as any[];
    expect(before[0].vpip).toBeCloseTo(0.28, 9);
    const r = (await call("PUT", `/players/${id}/style`, { style_id: "builtin:maniac" })).body as any;
    expect(r.vpip).toBeCloseTo(0.7, 9); // (0 + 0.7*20) / 20
    expect(r.af).toBeCloseTo(4, 9);
    expect(r.style_name).toBe("Maniac");
    const cleared = (await call("PUT", `/players/${id}/style`, { style_id: null })).body as any;
    expect(cleared.vpip).toBeCloseTo(0.28, 9);
    expect((await call("PUT", `/players/${id}/style`, { style_id: "s_missing" })).status).toBe(404);
    expect((await call("PUT", `/players/zzz/style`, { style_id: null })).status).toBe(404);
  });

  it("deleting a custom style returns its players to the default", async () => {
    const { call } = setup();
    const id = await newPlayer(call);
    const s = (await call("POST", "/styles", { name: "x", vpip: 0.6, pfr: 0.3, af: 3 })).body as any;
    await call("PUT", `/players/${id}/style`, { style_id: s.id });
    await call("DELETE", `/styles/${s.id}`);
    const p = ((await call("GET", "/players")).body as any[])[0];
    expect(p.style_id).toBeNull();
    expect(p.vpip).toBeCloseTo(0.28, 9);
  });
});

describe("recording hands and the stats that follow", () => {
  it("returns the recorded hand with an id and the time it was recorded", async () => {
    const { call } = setup();
    const id = await newPlayer(call);
    const r = await call("POST", "/hands", handBody(id, [raisePreflop(id)]));
    expect(r.status).toBe(200);
    expect((r.body as any).id).toMatch(/^h_/);
    expect((r.body as any).ts).toBe(clock);
  });

  it("stats move from the prior toward what the player does, weighted toward recent hands", async () => {
    const { call } = setup();
    const id = await newPlayer(call);
    for (let i = 0; i < 30; i++) { tick(); await call("POST", "/hands", handBody(id, [raisePreflop(id)])); }
    const p = ((await call("GET", "/players")).body as any[])[0];
    let n = 0; // by hand: 30 hands, the k-th most recent weighs 0.5^(k/50); every one is a preflop raise
    for (let k = 0; k < 30; k++) n += Math.pow(0.5, k / 50);
    expect(p.vpip).toBeCloseTo((n + 0.28 * 20) / (n + 20), 9);
    expect(p.pfr).toBeCloseTo((n + 0.15 * 20) / (n + 20), 9);
    expect(p.hands).toBe(30);
  });

  it("a player who turns tight after playing loose drifts back down (styles change with the hands)", async () => {
    const { call } = setup();
    const id = await newPlayer(call);
    for (let i = 0; i < 20; i++) { tick(); await call("POST", "/hands", handBody(id, [raisePreflop(id)])); }
    const loose = ((await call("GET", "/players")).body as any[])[0].vpip;
    for (let i = 0; i < 60; i++) { tick(); await call("POST", "/hands", handBody(id, [foldPreflop(id)])); }
    const later = ((await call("GET", "/players")).body as any[])[0].vpip;
    expect(later).toBeLessThan(loose - 0.1);
  });

  it("amending a hand changes the stats and keeps its place in time; deleting it reverts them", async () => {
    const { call, store } = setup();
    const id = await newPlayer(call);
    tick(); const first = (await call("POST", "/hands", handBody(id, [raisePreflop(id)]))).body as any;
    tick(); await call("POST", "/hands", handBody(id, [foldPreflop(id)]));
    const vpipOf = async () => ((await call("GET", "/players")).body as any[])[0].vpip;
    const withRaise = await vpipOf();
    tick();
    const amended = (await call("PUT", `/hands/${first.id}`, handBody(id, [foldPreflop(id)]))).body as any;
    expect(amended.ts).toBe(first.ts); // same moment in history
    expect(await vpipOf()).toBeLessThan(withRaise);
    expect((await call("DELETE", `/hands/${first.id}`)).status).toBe(200);
    expect(((await call("GET", "/players")).body as any[])[0].hands).toBe(1);
    // the log kept every step: player, add, add, amend, delete
    expect((store.data.get(EVENTS_KEY) as string).trim().split("\n").length).toBe(5);
  });

  it("each player's own history: newest first, only hands they were in", async () => {
    const { call } = setup();
    const a = await newPlayer(call, "A"), b = await newPlayer(call, "B");
    tick(); await call("POST", "/hands", handBody(a, [raisePreflop(a)]));
    tick(); await call("POST", "/hands", handBody(b, [raisePreflop(b)]));
    tick(); await call("POST", "/hands", { ...handBody(a, [foldPreflop(a)]), players: [{ id: a }, { id: b }] });
    const forA = (await call("GET", `/players/${a}/hands`)).body as any[];
    expect(forA.length).toBe(2);
    expect(forA[0].ts).toBeGreaterThan(forA[1].ts);
    expect(forA.every((h) => h.players.some((p: any) => p.id === a))).toBe(true);
    expect((await call("GET", "/players/nope/hands")).status).toBe(404);
    expect(((await call("GET", "/hands")).body as any[]).length).toBe(3);
  });

  it("works for opponents who are not saved ('anon:N') and for the hero's own actions", async () => {
    const { call } = setup();
    const r = await call("POST", "/hands", {
      ...handBody("anon:1", [{ player: "hero", street: 0, type: "call" }, { player: "anon:1", street: 0, type: "raise" }]),
      hero: ["Ah", "As"],
    });
    expect(r.status).toBe(200);
  });

  it("stores the cards a player showed", async () => {
    const { call } = setup();
    const id = await newPlayer(call);
    const r = (await call("POST", "/hands", {
      ...handBody(id, [raisePreflop(id)]), board: ["2c", "7d", "9h"], players: [{ id, known: ["Kd", "Kc"] }],
    })).body as any;
    expect(r.players[0].known).toEqual(["Kd", "Kc"]);
  });

  const valid = (id: string) => handBody(id, [raisePreflop(id)]);
  it("rejects malformed hands with a readable message", async () => {
    const { call } = setup();
    const id = await newPlayer(call);
    const bad: [string, object][] = [
      ["two-card board", { ...valid(id), board: ["2c", "3c"] }],
      ["duplicate card across board and shown cards", { ...valid(id), board: ["Kd", "3c", "4c"], players: [{ id, known: ["Kd"] }] }],
      ["three shown cards", { ...valid(id), players: [{ id, known: ["Kd", "Kc", "Kh"] }] }],
      ["unknown action", handBody(id, [{ player: id, street: 0, type: "shove" }])],
      ["action by someone not in the hand", handBody(id, [{ player: "stranger", street: 0, type: "raise" }])],
      ["street out of range", handBody(id, [{ player: id, street: 4, type: "raise" }])],
      ["negative amount", handBody(id, [{ player: id, street: 0, type: "raise", amount: -5 }])],
      ["zero big blind", { ...valid(id), bb: 0 }],
      ["no players", { ...valid(id), players: [] }],
      ["duplicate players", { ...valid(id), players: [{ id }, { id }] }],
      ["too many actions", handBody(id, Array(201).fill(raisePreflop(id)))],
      ["bad structure", { ...valid(id), structure: "fixed" }],
    ];
    for (const [name, body] of bad) {
      const r = await call("POST", "/hands", body);
      expect(r.status, name).toBe(422);
      expect((r.body as any).detail[0].msg, name).toBeTruthy();
    }
    expect(((await call("GET", "/hands")).body as any[]).length).toBe(0);
    expect((await call("PUT", "/hands/h_nope", valid(id))).status).toBe(404);
    expect((await call("DELETE", "/hands/h_nope")).status).toBe(404);
  });
});

describe("advice using actions, shown cards and dead cards", () => {
  const base = { hero: ["Ah", "As"], board: [], bb: 2, pot: 12, to_call: 6, stack: 200, position: 0.8 };

  it("recorded actions of this hand narrow that opponent's range", async () => {
    const { call } = setup();
    const quick = (await call("POST", "/advise", { ...base, opponents: [{ action: "none" }] })).body as any;
    const informed = (await call("POST", "/advise", {
      ...base, opponents: [{ actions: [{ street: 0, type: "raise", amount: 6, pot_before: 3 }] }],
    })).body as any;
    expect(informed.opponents[0].range_pct).toBeLessThan(quick.opponents[0].range_pct);
    expect(informed.opponents[0].top.length).toBe(5);
  });

  it("every opponent comes with the class shares behind the 13x13 map", async () => {
    const { call } = setup();
    const r = (await call("POST", "/advise", { ...base, opponents: [{ known: ["Kd", "Kc"] }, {}] })).body as any;
    expect(r.opponents[0].grid).toEqual({ KK: 100 });
    expect(Object.keys(r.opponents[1].grid).length).toBeGreaterThan(40);
  });

  it("shown cards pin the opponent's hand", async () => {
    const { call } = setup();
    const r = (await call("POST", "/advise", { ...base, opponents: [{ known: ["Kd", "Kc"] }] })).body as any;
    expect(r.opponents[0].top[0]).toEqual({ hand: "KK", pct: 100 });
    expect(r.equity).toBeGreaterThan(0.78);
  });

  it("dead cards are honoured: the nut straight on a three-spade board when every other spade is out of the deck", async () => {
    const { call } = setup();
    // As Ks Qs 3d 2c and hero Jh Th = broadway straight. Only a flush beats it, and only spade pairs make one.
    const spot = { ...base, hero: ["Jh", "Th"], board: ["As", "Ks", "Qs", "3d", "2c"], opponents: [{}] };
    const live = (await call("POST", "/advise", spot)).body as any;
    const noSpadesLeft = (await call("POST", "/advise", {
      ...spot, dead: ["Js", "Ts", "9s", "8s", "7s", "6s", "5s", "4s", "3s", "2s"],
    })).body as any;
    expect(live.equity).toBeLessThan(0.95); // flushes are in the opponent's range
    expect(noSpadesLeft.equity).toBeGreaterThan(0.98); // nothing can beat the straight any more
  });

  it("a saved player's observed history reaches the advice (a tight history gives a narrower range)", async () => {
    const { call } = setup();
    const id = await newPlayer(call);
    for (let i = 0; i < 40; i++) { tick(); await call("POST", "/hands", handBody(id, [foldPreflop(id)])); }
    const request = (o: object) => call("POST", "/advise", { ...base, opponents: [o] });
    const tight = ((await request({ player_id: id, action: "raise" })).body as any).opponents[0].range_pct;
    const stranger = ((await request({ action: "raise" })).body as any).opponents[0].range_pct;
    expect(tight).toBeLessThan(stranger);
  });

  it("rejects a card that appears twice, more than two shown cards, and malformed actions", async () => {
    const { call } = setup();
    const bad = [
      { ...base, dead: ["Ah"], opponents: [{}] },
      { ...base, opponents: [{ known: ["As", "Kd"] }] },
      { ...base, opponents: [{ known: ["Kd"] }, { known: ["Kd"] }] },
      { ...base, opponents: [{ known: ["Kd", "Kc", "Kh"] }] },
      { ...base, dead: Array(11).fill("2c"), opponents: [{}] },
      { ...base, opponents: [{ actions: [{ street: 9, type: "bet" }] }] },
      { ...base, opponents: [{ actions: [{ street: 0, type: "teleport" }] }] },
    ];
    for (const body of bad) expect((await call("POST", "/advise", body)).status).toBe(422);
  });
});

describe("Nash push/fold through the on-device API", () => {
  const table = JSON.parse(readFileSync(new URL("../../core/pushfold.json", import.meta.url), "utf8"));
  const spot = { hero: ["Ah", "As"], board: [], bb: 2, pot: 3, to_call: 1, stack: 19, position: 0.95, opponents: [{}] };
  const ask = async (body: object, withTable = true) =>
    (await createLocalApi(memory(), weights, withTable ? table : undefined)("POST", "/advise", body)).body as any;

  it("small blind at 10 bb: aces shove, seven-deuce folds; the normal advice is still returned", async () => {
    const aces = await ask(spot);
    expect(aces.pushfold).toMatchObject({ role: "small_blind", hand: "AA", depth: 10, decision: "shove" });
    expect(aces.advice).toMatchObject({ action: "all-in", amount: 19, source: "nash" }); // the exact answer is THE answer
    expect((await ask({ ...spot, hero: ["7c", "2d"] })).pushfold).toMatchObject({ hand: "72o", decision: "fold" });
  });

  it("big blind facing an all-in at 10 bb", async () => {
    const facing = { ...spot, pot: 22, to_call: 18, stack: 18 };
    expect((await ask(facing)).pushfold).toMatchObject({ role: "big_blind", depth: 10, decision: "call" });
    expect((await ask({ ...facing, hero: ["7c", "2d"] })).pushfold).toMatchObject({ role: "big_blind", decision: "fold" });
  });

  it("is absent without a table, multiway, postflop, deep-stacked or pot-limit", async () => {
    expect((await ask(spot, false)).pushfold).toBeUndefined();
    expect((await ask({ ...spot, opponents: [{}, {}] })).pushfold).toBeUndefined();
    expect((await ask({ ...spot, board: ["2c", "7d", "9h"] })).pushfold).toBeUndefined();
    expect((await ask({ ...spot, stack: 199 })).pushfold).toBeUndefined();
    expect((await ask({ ...spot, structure: "pot_limit" })).pushfold).toBeUndefined();
  });

  it("marks a tournament spot, and still rejects a malformed request", async () => {
    const t = await ask({ ...spot, tournament: { stacks: [20, 30, 50], payouts: [50, 30, 20] } });
    expect(t.pushfold.caveat).toBe("icm");
    expect(t.advice.source).not.toBe("nash"); // chip-EV table: the network, which prices the ICM, keeps the lead
    const bad = await createLocalApi(memory(), weights, table)("POST", "/advise", { ...spot, hero: ["Ah", "Ah"] });
    expect(bad.status).toBe(422);
  });
});

describe("multiway shove through the on-device API", () => {
  const table = JSON.parse(readFileSync(new URL("../../core/pushfold.json", import.meta.url), "utf8"));
  const spot = { hero: ["Ah", "As"], board: [], bb: 2, pot: 3, to_call: 1, stack: 20, position: 0.3, opponents: [{}, {}, {}], budgetMs: 5000 };
  const ask = async (body: object, withTable = true) =>
    (await createLocalApi(memory(), weights, withTable ? table : undefined)("POST", "/advise", body)).body as any;

  it("aces shove three-handed at 10 bb, and the answer says it is an estimate", async () => {
    const r = await ask(spot);
    expect(r.multiway).toMatchObject({ hand: "AA", depth: 10, decision: "shove", approximate: true });
    expect(r.multiway.call_probs).toHaveLength(3);
    expect(r.advice).toMatchObject({ action: "all-in", amount: 20, source: "multiway" });
    expect(r.pushfold).toBeUndefined(); // the exact heads-up table does not apply
  });
  it("uses each player's own style: a nit table calls less than a fish table", async () => {
    const store = memory();
    const api = createLocalApi(store, weights, table);
    const seat = async (name: string, style: string) => {
      const id = ((await api("POST", "/players", { name })).body as { id: string }).id;
      await api("PUT", `/players/${id}/style`, { style_id: style });
      return { player_id: id };
    };
    const nits = [await seat("N1", "builtin:nit"), await seat("N2", "builtin:nit"), await seat("N3", "builtin:nit")];
    const fish = [await seat("F1", "builtin:fish"), await seat("F2", "builtin:fish"), await seat("F3", "builtin:fish")];
    const a = (await api("POST", "/advise", { ...spot, opponents: nits })).body as any;
    const b = (await api("POST", "/advise", { ...spot, opponents: fish })).body as any;
    expect(a.multiway.nobody_calls).toBeGreaterThan(b.multiway.nobody_calls);
  });
  it("is absent without the table, heads-up, postflop or deep-stacked", async () => {
    expect((await ask(spot, false)).multiway).toBeUndefined();
    expect((await ask({ ...spot, opponents: [{}] })).multiway).toBeUndefined();
    expect((await ask({ ...spot, board: ["2c", "7d", "9h"] })).multiway).toBeUndefined();
    expect((await ask({ ...spot, stack: 80 })).multiway).toBeUndefined();
  });
});

describe("Nash with the ICM through the on-device API", () => {
  const chip = JSON.parse(readFileSync(new URL("../../core/pushfold.json", import.meta.url), "utf8"));
  const matrix = JSON.parse(readFileSync(new URL("../../core/equity169.json", import.meta.url), "utf8"));
  const bubble = { stacks: [20, 20, 10], payouts: [1, 1, 0] };
  const smallBlind = { hero: ["Ah", "As"], board: [], bb: 2, pot: 3, to_call: 1, stack: 19, position: 0.95, opponents: [{}], tournament: bubble };
  const facing = { ...smallBlind, hero: ["Kc", "Td"], pot: 22, to_call: 18, stack: 18 };
  const ask = async (body: object, withMatrix = true) =>
    createLocalApi(memory(), weights, chip, withMatrix ? matrix : undefined)("POST", "/advise", body);

  it("small blind on the bubble shoves aces, and the answer says it was solved for this tournament", async () => {
    const r = (await ask(smallBlind)).body as any;
    expect(r.advice).toMatchObject({ action: "all-in", amount: 19, source: "nash_icm" });
    expect(r.pushfold).toMatchObject({ icm: true, decision: "shove" });
    expect(r.pushfold.gap).toBeLessThan(1e-4);
  });

  it("a call that chips make is a fold on the bubble; the same hand calls when the prize is winner-take-all", async () => {
    expect(((await ask(facing)).body as any).advice).toMatchObject({ action: "fold", source: "nash_icm" });
    expect(((await ask({ ...facing, tournament: { stacks: [20, 20], payouts: [1] } })).body as any).advice).toMatchObject({ action: "call" });
  });

  it("the opponent can be chosen from the stack list, and a bad choice is rejected", async () => {
    const t = { stacks: [20, 12, 30], payouts: [50, 30, 20] };
    const largest = ((await ask({ ...facing, tournament: t })).body as any).pushfold;
    const chosen = ((await ask({ ...facing, tournament: { ...t, villain: 1 } })).body as any).pushfold;
    expect(largest.depth).toBe(10);
    expect(chosen.depth).toBe(6);
    for (const villain of [0, 3, 1.5, -1, "1"]) {
      expect((await ask({ ...facing, tournament: { ...t, villain } })).status, String(villain)).toBe(422);
    }
  });

  it("without the matrix it falls back to the chip-EV table with its caveat", async () => {
    const r = (await ask(smallBlind, false)).body as any;
    expect(r.pushfold.caveat).toBe("icm");
    expect(r.advice.source).not.toBe("nash_icm");
  });
});

describe("nicknames for players", () => {
  it("renaming keeps the style, the hands and the stats, and survives a restart", async () => {
    const store = memory();
    const api = createLocalApi(store, weights);
    const id = ((await api("POST", "/players", { name: "Tizio" })).body as { id: string }).id;
    await api("PUT", `/players/${id}/style`, { style_id: "builtin:fish" });
    await api("POST", "/hands", { bb: 2, board: [], players: [{ id }], actions: [{ player: id, street: 0, type: "raise", amount: 6 }] });
    const before = ((await api("GET", "/players")).body as any[])[0];
    const r = await api("PUT", `/players/${id}`, { name: "  Il Dottore " });
    expect(r.status).toBe(200);
    expect((r.body as any).name).toBe("Il Dottore");
    const { name: _n, ...after } = r.body as any, { name: _o, ...old } = before;
    expect(after).toEqual(old); // same id, style, hands, VPIP, PFR, AF
    expect(((await api("GET", `/players/${id}/hands`)).body as unknown[]).length).toBe(1);
    const reopened = createLocalApi(store, weights);
    expect(((await reopened("GET", "/players")).body as any[])[0].name).toBe("Il Dottore");
  });

  it("refuses an empty, too long or already used name, and an unknown player", async () => {
    const api = createLocalApi(memory(), weights);
    const a = ((await api("POST", "/players", { name: "Anna" })).body as { id: string }).id;
    const b = ((await api("POST", "/players", { name: "Bruno" })).body as { id: string }).id;
    expect((await api("PUT", `/players/${b}`, { name: "   " })).status).toBe(422);
    expect((await api("PUT", `/players/${b}`, { name: "x".repeat(41) })).status).toBe(422);
    const twin = await api("PUT", `/players/${b}`, { name: "ANNA" });
    expect(twin.status).toBe(422);
    expect(JSON.stringify(twin.body)).toMatch(/esiste già/);
    expect((await api("PUT", "/players/nessuno", { name: "Carlo" })).status).toBe(404);
    expect((await api("PUT", `/players/${a}`, { name: "ANNA" })).status).toBe(200); // changing only the case of his own name is fine
    expect(((await api("GET", "/players")).body as any[]).map((p) => p.name).sort()).toEqual(["ANNA", "Bruno"]);
  });
});

describe("a new player starts with the style chosen for him", () => {
  it("is created with that style, which his stats start from", async () => {
    const api = createLocalApi(memory(), weights);
    const nit = (await api("POST", "/players", { name: "Tizio", style_id: "builtin:nit" })).body as any;
    const plain = (await api("POST", "/players", { name: "Caio" })).body as any;
    expect(nit.style_id).toBe("builtin:nit");
    expect(nit.vpip).toBeCloseTo(0.15, 2); // no hands yet: the style is all there is
    expect(plain.style_id).toBeNull();
    expect(plain.vpip).toBeCloseTo(0.28, 2);
  });
  it("refuses an unknown style without creating the player, and a name already in use", async () => {
    const api = createLocalApi(memory(), weights);
    expect((await api("POST", "/players", { name: "Tizio", style_id: "builtin:nope" })).status).toBe(404);
    expect(((await api("GET", "/players")).body as unknown[]).length).toBe(0);
    await api("POST", "/players", { name: "Tizio" });
    const twin = await api("POST", "/players", { name: "tizio" });
    expect(twin.status).toBe(422);
    expect(JSON.stringify(twin.body)).toMatch(/esiste già/);
    expect(((await api("GET", "/players")).body as unknown[]).length).toBe(1);
  });
  it("a custom style can be the starting one too", async () => {
    const api = createLocalApi(memory(), weights);
    const style = (await api("POST", "/styles", { name: "Il fish del giovedì", vpip: 0.6, pfr: 0.1, af: 0.8 })).body as any;
    const p = (await api("POST", "/players", { name: "Pino", style_id: style.id })).body as any;
    expect(p.style_name).toBe("Il fish del giovedì");
    expect(p.vpip).toBeCloseTo(0.6, 2);
  });
});
