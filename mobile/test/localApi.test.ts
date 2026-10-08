/** The on-device API must behave like the FastAPI backend it replaces (stats values come from Python). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Weights } from "../../core/src/advisor.js";
import { createLocalApi, type StorageLike } from "../src/localApi.js";

const weights = JSON.parse(readFileSync(new URL("../../core/weights.json", import.meta.url), "utf8")) as Weights;

const memory = (initial?: string): StorageLike & { raw: () => string | null } => {
  const data = new Map<string, string>(initial === undefined ? [] : [["poker.players.v1", initial]]);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), raw: () => data.get("poker.players.v1") ?? null };
};
const seed = (hands: number, vpip: number, pfr: number, bets: number, calls: number, id = "p1") =>
  JSON.stringify([{ id, name: "Mario", hands, vpip, pfr, bets, calls }]);

const AA = { hero: ["Ah", "As"], board: [], bb: 2, pot: 6, to_call: 4, stack: 200, position: 0.8, opponents: [{ action: "raise" }] };

describe("player stats match the Python reference", () => {
  const cases: [string, number[], { vpip: number; pfr: number; af: number; style: string }][] = [
    ["prior only", [0, 0, 0, 0, 0], { vpip: 0.28, pfr: 0.15, af: 1.5, style: "medio" }],
    ["hyper-aggressive", [30, 30, 30, 60, 0], { vpip: 0.712, pfr: 0.66, af: 7.5, style: "loose-aggressivo" }],
    ["average", [10, 3, 1, 4, 6], { vpip: 0.286666666667, pfr: 0.133333333333, af: 1.1875, style: "medio" }],
    ["passive", [200, 40, 10, 20, 90], { vpip: 0.207272727273, pfr: 0.059090909091, af: 0.35, style: "medio-passivo" }],
  ];
  for (const [name, [h, v, p, b, c], want] of cases) {
    it(name, async () => {
      const api = createLocalApi(memory(seed(h, v, p, b, c)), weights);
      const [got] = (await api("GET", "/players")).body as any[];
      expect(got.vpip).toBeCloseTo(want.vpip, 9);
      expect(got.pfr).toBeCloseTo(want.pfr, 9);
      expect(got.af).toBeCloseTo(want.af, 9);
      expect(got.style).toBe(want.style);
    });
  }

  it("recording hands one by one reaches the same stats as the Python store", async () => {
    const store = memory();
    const api = createLocalApi(store, weights);
    const { id } = (await api("POST", "/players", { name: "Luca" })).body as { id: string };
    for (let i = 0; i < 30; i++) await api("POST", `/players/${id}/hand`, { vpip: true, pfr: true, bets: 2 });
    const [got] = (await api("GET", "/players")).body as any[];
    expect(got.hands).toBe(30);
    expect(got.vpip).toBeCloseTo(0.712, 9);
    expect(got.af).toBeCloseTo(7.5, 9);
  });
});

describe("hand recording semantics (as in Python's record_hand)", () => {
  it("a preflop raise counts as VPIP even when vpip is not flagged", async () => {
    const api = createLocalApi(memory(), weights);
    const { id } = (await api("POST", "/players", { name: "Raiser" })).body as { id: string };
    await api("POST", `/players/${id}/hand`, { pfr: true });
    const [got] = (await api("GET", "/players")).body as any[];
    expect(got.vpip).toBeCloseTo((1 + 0.28 * 20) / 21, 9); // vpip=1, pfr=1, hands=1
    expect(got.pfr).toBeCloseTo((1 + 0.15 * 20) / 21, 9);
  });

  it("rejects out-of-range bet/call counts", async () => {
    const api = createLocalApi(memory(seed(0, 0, 0, 0, 0)), weights);
    expect((await api("POST", "/players/p1/hand", { bets: 51 })).status).toBe(422);
    expect((await api("POST", "/players/p1/hand", { calls: -1 })).status).toBe(422);
  });
});

describe("routing", () => {
  it("unknown paths and methods are 404, not success", async () => {
    const api = createLocalApi(memory(), weights);
    expect((await api("GET", "/nope")).status).toBe(404);
    expect((await api("PUT", "/players")).status).toBe(404);
    expect((await api("GET", "/advise")).status).toBe(404);
  });
});

describe("players CRUD and storage", () => {
  it("creates, lists and deletes players; unknown ids give 404", async () => {
    const api = createLocalApi(memory(), weights);
    const created = (await api("POST", "/players", { name: "  Anna " })).body as { id: string; name: string };
    expect(created.name).toBe("Anna");
    expect(((await api("GET", "/players")).body as unknown[]).length).toBe(1);
    expect((await api("DELETE", `/players/${created.id}`)).status).toBe(200);
    expect(((await api("GET", "/players")).body as unknown[]).length).toBe(0);
    expect((await api("DELETE", "/players/nope")).status).toBe(404);
    expect((await api("POST", "/players/nope/hand", {})).status).toBe(404);
  });

  it("rejects empty and over-long names", async () => {
    const api = createLocalApi(memory(), weights);
    expect((await api("POST", "/players", { name: "   " })).status).toBe(422);
    expect((await api("POST", "/players", { name: "x".repeat(41) })).status).toBe(422);
  });

  it("survives corrupted or malformed storage instead of crashing", async () => {
    for (const bad of ["{not json", '{"a":1}', '[{"id":1}]', '[{"id":"a","name":"b","hands":-1,"vpip":0,"pfr":0,"bets":0,"calls":0}]']) {
      const api = createLocalApi(memory(bad), weights);
      expect((await api("GET", "/players")).body).toEqual([]);
    }
  });

  it("persists across API instances sharing the same storage", async () => {
    const store = memory();
    await createLocalApi(store, weights)("POST", "/players", { name: "Pia" });
    expect(((await createLocalApi(store, weights)("GET", "/players")).body as unknown[]).length).toBe(1);
  });
});

describe("advise", () => {
  it("AA facing a raise: raise/all-in with the backend's response shape", async () => {
    const r = await createLocalApi(memory(), weights)("POST", "/advise", AA);
    expect(r.status).toBe(200);
    const b = r.body as any;
    expect(["raise", "all-in"]).toContain(b.advice.action);
    expect(b.equity).toBeGreaterThan(0.7);
    expect(b.opponents[0].range_pct).toBeGreaterThan(0);
    expect(Object.keys(b.categories)).toContain("Coppia");
  });

  it("uses a saved player's stats: a nit's raise gives a tighter range than the default player's", async () => {
    const api = createLocalApi(memory(seed(300, 30, 25, 30, 20)), weights);
    const known = (await api("POST", "/advise", { ...AA, opponents: [{ player_id: "p1", action: "raise" }] })).body as any;
    const unknown = (await api("POST", "/advise", AA)).body as any;
    expect(known.opponents[0].range_pct).toBeLessThan(unknown.opponents[0].range_pct);
  });

  const invalid: [string, object][] = [
    ["duplicate cards", { ...AA, hero: ["Ah", "Ah"] }],
    ["bad card", { ...AA, hero: ["Ah", "Zz"] }],
    ["two-card board", { ...AA, board: ["2c", "3c"] }],
    ["zero big blind", { ...AA, bb: 0 }],
    ["negative pot", { ...AA, pot: -1 }],
    ["no opponents", { ...AA, opponents: [] }],
    ["ten opponents", { ...AA, opponents: Array(10).fill({}) }],
    ["unknown action", { ...AA, opponents: [{ action: "shove" }] }],
    ["bad structure", { ...AA, structure: "fixed_limit" }],
    ["NaN stack", { ...AA, stack: "lots" }],
    ["tournament without payouts", { ...AA, tournament: { stacks: [100, 200], payouts: [] } }],
  ];
  for (const [name, body] of invalid) {
    it(`422 on ${name}`, async () => {
      const r = await createLocalApi(memory(), weights)("POST", "/advise", body);
      expect(r.status).toBe(422);
      expect((r.body as any).detail[0].msg).toBeTruthy();
    });
  }

  it("pot-limit never exceeds the cap and tournament reports a bubble factor", async () => {
    const api = createLocalApi(memory(), weights);
    const pl = (await api("POST", "/advise", { ...AA, structure: "pot_limit", pot: 20, to_call: 10 })).body as any;
    expect(pl.advice.amount).toBeLessThanOrEqual(10 + 30 + 0.51);
    const t = (await api("POST", "/advise", { ...AA, tournament: { stacks: [200, 300, 500, 800], payouts: [50, 30, 20] } })).body as any;
    expect(t.advice.bubble_factor).toBeGreaterThanOrEqual(1);
  });
});
