/** Hands recorded at the table: the seating is stored with the hand, replayed by the engine on every save and amend,
 * and the players' history is derived from the same actions. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Weights } from "../../core/src/advisor.js";
import type { HandRecord } from "../../core/src/history.js";
import { createLocalApi, type StorageLike } from "../src/localApi.js";

const weights = JSON.parse(readFileSync(new URL("../../core/weights.json", import.meta.url), "utf8")) as Weights;
const memory = (): StorageLike => {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const setup = async () => {
  const api = createLocalApi(memory(), weights);
  const mk = async (name: string) => ((await api("POST", "/players", { name })).body as { id: string }).id;
  return { api, a: await mk("Anna"), b: await mk("Bruno") };
};

// hero button and first to act, Anna small blind, Bruno big blind; blinds 1/2
const threeHanded = (a: string, b: string, actions: object[], extra: object = {}) => ({
  bb: 2, board: ["2c", "7d", "9h"], players: [{ id: a }, { id: b }], actions, table: { seats: ["hero", a, b], first: 0 }, ...extra,
});

describe("saving a hand with its table", () => {
  it("stores the seating, and the actions come back with their streets and pots", async () => {
    const { api, a, b } = await setup();
    const body = threeHanded(a, b, [
      { player: "hero", street: 0, type: "raise", amount: 6, pot_before: 3 },
      { player: a, street: 0, type: "call", amount: 5, pot_before: 9 },
      { player: b, street: 0, type: "fold", pot_before: 14 },
      { player: a, street: 1, type: "bet", amount: 8, pot_before: 14 },
      { player: "hero", street: 1, type: "fold", pot_before: 22 },
    ]);
    const r = await api("POST", "/hands", body);
    expect(r.status).toBe(200);
    const saved = r.body as HandRecord;
    expect(saved.table).toEqual({ seats: ["hero", a, b], first: 0 });
    expect(((await api("GET", "/hands")).body as HandRecord[])[0].table).toEqual(saved.table);
  });

  it("the players' history comes from the same actions: the raiser has a raise on record", async () => {
    const { api, a, b } = await setup();
    await api("POST", "/hands", threeHanded(a, b, [
      { player: "hero", street: 0, type: "call", amount: 2, pot_before: 3 },
      { player: a, street: 0, type: "raise", amount: 8, pot_before: 5 },
      { player: b, street: 0, type: "fold", pot_before: 13 },
      { player: "hero", street: 0, type: "fold", pot_before: 13 },
    ]));
    const hands = (await api("GET", `/players/${a}/hands`)).body as HandRecord[];
    expect(hands).toHaveLength(1);
    expect(hands[0].actions.filter((x) => x.player === a).map((x) => [x.type, x.amount])).toEqual([["raise", 8]]);
    const stats = ((await api("GET", "/players")).body as any[]).find((p) => p.id === a);
    expect(stats.hands).toBe(1);
    expect(stats.pfr).toBeGreaterThan(0.15);
  });

  it("refuses an action the table does not allow, and says which one", async () => {
    const { api, a, b } = await setup();
    const check = await api("POST", "/hands", threeHanded(a, b, [{ player: "hero", street: 0, type: "check" }]));
    expect(check.status).toBe(422);
    expect(JSON.stringify(check.body)).toMatch(/azione 1.*check/);
    const turn = await api("POST", "/hands", threeHanded(a, b, [{ player: a, street: 0, type: "fold" }]));
    expect(turn.status).toBe(422);
    expect(JSON.stringify(turn.body)).toMatch(/tocca a hero/);
    const afterEnd = await api("POST", "/hands", threeHanded(a, b, [
      { player: "hero", street: 0, type: "raise", amount: 6 }, { player: a, street: 0, type: "fold" },
      { player: b, street: 0, type: "fold" }, { player: "hero", street: 0, type: "check" },
    ]));
    expect(afterEnd.status).toBe(422);
    expect(((await api("GET", "/hands")).body as unknown[]).length).toBe(0);
  });

  it("uses the hand's own big blind: a raise to 6 is not a raise when the big blind is 10", async () => {
    const { api, a, b } = await setup();
    const small = await api("POST", "/hands", threeHanded(a, b, [{ player: "hero", street: 0, type: "raise", amount: 6 }], { bb: 10 }));
    expect(small.status).toBe(422);
    expect(JSON.stringify(small.body)).toMatch(/superare 10/);
    expect((await api("POST", "/hands", threeHanded(a, b, [{ player: "hero", street: 0, type: "raise", amount: 30 }], { bb: 10 }))).status).toBe(200);
  });

  it("refuses an action filed under the wrong street", async () => {
    const { api, a, b } = await setup();
    const r = await api("POST", "/hands", threeHanded(a, b, [
      { player: "hero", street: 0, type: "raise", amount: 6 }, { player: a, street: 0, type: "call" },
      { player: b, street: 0, type: "fold" }, { player: a, street: 2, type: "bet", amount: 8 },
    ], { board: ["2c", "7d", "9h", "Ks"] }));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/azione 4.*flop/);
  });

  it("refuses a seating that does not match the hand", async () => {
    const { api, a, b } = await setup();
    const bad = async (table: unknown) => (await api("POST", "/hands", threeHanded(a, b, [], { table }))).status;
    expect(await bad({ seats: ["hero", a, "stranger"], first: 0 })).toBe(422); // not in the hand
    expect(await bad({ seats: ["hero", a, a], first: 0 })).toBe(422);
    expect(await bad({ seats: ["hero", a, b], first: 3 })).toBe(422);
    expect(await bad({ seats: ["hero", a, b], first: 0.5 })).toBe(422);
    expect(await bad({ seats: ["hero"], first: 0 })).toBe(422);
    expect(await bad({ seats: ["hero", a, b], first: 0 })).toBe(200);
  });
});

describe("amending a hand that has a table", () => {
  it("the same rules apply, a bad edit changes nothing, and a good one keeps the seating", async () => {
    const { api, a, b } = await setup();
    const good = threeHanded(a, b, [
      { player: "hero", street: 0, type: "raise", amount: 6 }, { player: a, street: 0, type: "fold" }, { player: b, street: 0, type: "fold" },
    ]);
    const saved = (await api("POST", "/hands", good)).body as HandRecord;
    const broken = await api("PUT", `/hands/${saved.id}`, { ...good, actions: [{ player: a, street: 0, type: "raise", amount: 6 }] });
    expect(broken.status).toBe(422);
    expect(((await api("GET", "/hands")).body as HandRecord[])[0]).toEqual(saved);
    const fixed = await api("PUT", `/hands/${saved.id}`, {
      ...good, actions: [{ player: "hero", street: 0, type: "raise", amount: 8 }, { player: a, street: 0, type: "fold" }, { player: b, street: 0, type: "fold" }],
    });
    expect(fixed.status).toBe(200);
    expect((fixed.body as HandRecord).table).toEqual(saved.table);
  });

  it("hands without a table, saved by older versions, are still accepted as before", async () => {
    const { api, a } = await setup();
    const r = await api("POST", "/hands", { bb: 2, board: [], players: [{ id: a }], actions: [{ player: a, street: 0, type: "raise", amount: 6 }] });
    expect(r.status).toBe(200);
    expect((r.body as HandRecord).table).toBeUndefined();
  });
});
