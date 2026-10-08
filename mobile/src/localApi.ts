/** On-device replacement for the FastAPI backend: the /api/* contract, served by the TypeScript core.
 * All data lives in the append-only event log (store.ts); players' stats are derived from recorded hands. */
import { advise, type AdviseRequest, type OppInput, type Weights } from "../../core/src/advisor.js";
import { parse } from "../../core/src/cards.js";
import type { PushFoldTable } from "../../core/src/pushfold.js";
import { deriveStats, type HandAction, type HandRecord } from "../../core/src/history.js";
import { PRIOR, type OppAction, type OppStats } from "../../core/src/policy.js";
import type { ActionRecord, ActionType } from "../../core/src/range.js";
import {
  allStyles, appendEvents, loadState, styleById, type PlayerState, type StorageLike, type StoreEvent, type StoreState,
} from "./store.js";

export type { StorageLike } from "./store.js";
export interface ApiResult { status: number; body: unknown }

const ACTIONS: readonly OppAction[] = ["none", "call", "bet", "raise"];
const ACTION_TYPES: readonly ActionType[] = ["fold", "check", "call", "bet", "raise", "allin"];
const MAX_HAND_ACTIONS = 200;
const HERO = "hero";

class ValidationError extends Error {}

// ---------- validation helpers (mirror the pydantic models of app/server.py) ----------
const num = (v: unknown, name: string, min: number, max = Infinity, dflt?: number): number => {
  const x = v === undefined && dflt !== undefined ? dflt : v;
  if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) throw new ValidationError(`${name} non valido`);
  return x;
};
const list = (v: unknown, name: string, min: number, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new ValidationError(`${name} non valido`);
  return v;
};
const cards = (v: unknown, name: string, min: number, max: number): string[] => {
  const xs = list(v ?? [], name, min, max);
  for (const x of xs) {
    if (typeof x !== "string") throw new ValidationError("carta non valida");
    parse(x); // throws "carta non valida: …"
  }
  return xs as string[];
};
const text = (v: unknown, name: string, max = 40): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > max) throw new ValidationError(`${name} non valido`);
  return s;
};
const shortId = (prefix = ""): string => prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

function parseActions(v: unknown, who: (a: any) => string | undefined): HandAction[] {
  return list(v ?? [], "azioni", 0, MAX_HAND_ACTIONS).map((a: any) => {
    if (!ACTION_TYPES.includes(a?.type)) throw new ValidationError("azione non valida");
    const player = who(a);
    if (!player) throw new ValidationError("giocatore dell'azione non valido");
    const out: HandAction = { player, street: num(a.street, "strada", 0, 3), type: a.type };
    if (a.amount !== undefined) out.amount = num(a.amount, "importo", 0);
    if (a.pot_before !== undefined) out.pot_before = num(a.pot_before, "piatto", 0);
    return out;
  });
}

function parseHand(body: any, id: string, ts: number): HandRecord {
  if (!body || typeof body !== "object") throw new ValidationError("richiesta non valida");
  const board = cards(body.board, "board", 0, 5);
  if (![0, 3, 4, 5].includes(board.length)) throw new ValidationError("il board deve avere 0, 3, 4 o 5 carte");
  const hero = body.hero === undefined ? undefined : cards(body.hero, "hero", 2, 2);
  const players = list(body.players, "giocatori", 1, 10).map((p: any) => ({
    id: text(p?.id, "id giocatore", 40), known: cards(p?.known, "carte mostrate", 0, 2),
  }));
  if (new Set(players.map((p) => p.id)).size !== players.length) throw new ValidationError("giocatori duplicati");
  const every = [...(hero ?? []), ...board, ...players.flatMap((p) => p.known)].map(parse);
  if (new Set(every).size !== every.length) throw new ValidationError("carte duplicate");
  const structure = body.structure ?? "no_limit";
  if (structure !== "no_limit" && structure !== "pot_limit") throw new ValidationError("formato non valido");
  const names = new Set([HERO, ...players.map((p) => p.id)]);
  const actions = parseActions(body.actions, (a) => (typeof a?.player === "string" && names.has(a.player) ? a.player : undefined));
  return {
    id, ts, bb: num(body.bb, "bb", Number.MIN_VALUE), structure, board, hero, actions,
    players: players.map((p) => (p.known.length ? p : { id: p.id })),
  };
}

// ---------- derived views ----------
const priorOf = (state: StoreState, p: PlayerState): OppStats => {
  const s = styleById(state, p.style_id);
  return s ? { vpip: s.vpip, pfr: s.pfr, af: s.af } : PRIOR;
};
const statsOf = (state: StoreState, p: PlayerState) =>
  deriveStats(p.id, [...state.hands.values()], priorOf(state, p), p.legacy);

function publicPlayer(state: StoreState, p: PlayerState) {
  const stats = statsOf(state, p);
  const style = styleById(state, p.style_id);
  return { id: p.id, name: p.name, ...stats, style_id: style?.id ?? null, style_name: style?.name ?? null };
}

const handsOf = (state: StoreState, playerId: string): HandRecord[] =>
  [...state.hands.values()].filter((h) => h.players.some((p) => p.id === playerId)).sort((a, b) => b.ts - a.ts);

function parseAdvise(body: any, state: StoreState): AdviseRequest {
  if (!body || typeof body !== "object") throw new ValidationError("richiesta non valida");
  const hero = cards(body.hero, "hero", 2, 2) as [string, string];
  const board = cards(body.board, "board", 0, 5);
  const dead = cards(body.dead, "carte morte", 0, 10);
  const structure = body.structure ?? "no_limit";
  if (structure !== "no_limit" && structure !== "pot_limit") throw new ValidationError("formato non valido");
  const opponents: OppInput[] = list(body.opponents, "avversari", 1, 9).map((o: any) => {
    const action = o?.action ?? "none";
    if (!ACTIONS.includes(action)) throw new ValidationError("azione non valida");
    const known = state.players.get(o?.player_id);
    const stats = known ? (({ vpip, pfr, af, ftb }) => ({ vpip, pfr, af, ftb }))(statsOf(state, known)) : undefined;
    const input: OppInput = { stats, action, bet_frac: num(o?.bet_frac, "bet_frac", 0, 10, 0.6) };
    const shown = cards(o?.known, "carte mostrate", 0, 2);
    if (shown.length) input.known = shown;
    if (o?.actions !== undefined) {
      input.actions = parseActions(o.actions, () => "x").map(({ street, type, amount, pot_before }) => (
        { street, type, ...(amount !== undefined ? { amount } : {}), ...(pot_before !== undefined ? { pot_before } : {}) }
      )) as ActionRecord[];
    }
    return input;
  });
  let tournament: AdviseRequest["tournament"];
  if (body.tournament) {
    const stacks = list(body.tournament.stacks, "stack", 2, 9).map((x) => num(x, "stack", 0));
    const payouts = list(body.tournament.payouts, "premi", 1, 9).map((x) => num(x, "premio", 0));
    tournament = { stacks, payouts };
  }
  return {
    hero, board, structure, tournament, opponents, ...(dead.length ? { dead } : {}),
    bb: num(body.bb, "bb", Number.MIN_VALUE),
    pot: num(body.pot, "piatto", 0),
    to_call: num(body.to_call, "da chiamare", 0, Infinity, 0),
    stack: num(body.stack, "stack", Number.MIN_VALUE),
    position: num(body.position, "posizione", 0, 1, 0.5),
    budgetMs: 800,
  };
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const fail = (status: number, msg: string): ApiResult => ({ status, body: { detail: status === 422 ? [{ msg }] : msg } });
const INPUT_ERROR = /carta|carte|board|duplicate|servono|mostrate/;

export function createLocalApi(storage: StorageLike, weights: Weights, pushFold?: PushFoldTable) {
  const save = (...events: StoreEvent[]): void => appendEvents(storage, events);
  /** The player as the log says AFTER a write: never the copy read before it. */
  const refreshed = (id: string) => {
    const fresh = loadState(storage);
    return publicPlayer(fresh, fresh.players.get(id) as PlayerState);
  };

  return async function handle(method: string, path: string, body?: any): Promise<ApiResult> {
    try {
      const state = loadState(storage);
      const now = Date.now();
      const route = `${method} ${path}`;

      if (route === "POST /advise") return ok(advise(parseAdvise(body, state), weights, undefined, pushFold));

      // ----- players -----
      if (route === "GET /players") return ok([...state.players.values()].map((p) => publicPlayer(state, p)));
      if (route === "POST /players") {
        const id = shortId();
        save({ t: "player", id, name: text(body?.name, "nome"), ts: now });
        return ok(refreshed(id));
      }
      const player = /^\/players\/([\w-]+)(?:\/(hand|hands|style))?$/.exec(path);
      if (player) {
        const target = state.players.get(player[1]);
        if (!target) return fail(404, "giocatore non trovato");
        const part = player[2];
        if (method === "DELETE" && !part) { save({ t: "player_del", id: target.id, ts: now }); return ok({ ok: true }); }
        if (method === "PUT" && part === "style") {
          const styleId = body?.style_id ?? null;
          if (styleId !== null && !styleById(state, styleId)) return fail(404, "stile non trovato");
          save({ t: "assign", player: target.id, style: styleId, ts: now });
          return ok(refreshed(target.id));
        }
        if (method === "GET" && part === "hands") {
          const limit = num(body?.limit, "limite", 1, 200, 50);
          return ok(handsOf(state, target.id).slice(0, limit));
        }
        if (method === "POST" && part === "hand") { // quick manual counters (kept for compatibility)
          const bets = num(body?.bets, "bets", 0, 50, 0), calls = num(body?.calls, "calls", 0, 50, 0);
          const pfr = !!body?.pfr, vpip = !!body?.vpip || pfr;
          save({ t: "legacy", player: target.id, ts: now, hands: 1, vpip: vpip ? 1 : 0, pfr: pfr ? 1 : 0, bets: Math.floor(bets), calls: Math.floor(calls) });
          return ok(refreshed(target.id));
        }
      }

      // ----- styles -----
      if (route === "GET /styles") return ok(allStyles(state));
      if (route === "POST /styles") {
        const id = body?.id === undefined ? shortId("s_") : text(body.id, "id stile", 40);
        if (id.startsWith("builtin:")) return fail(422, "gli stili predefiniti non si modificano");
        const vpip = num(body?.vpip, "vpip", 0, 1), pfr = num(body?.pfr, "pfr", 0, 1), af = num(body?.af, "aggressività", 0, 20);
        if (pfr > vpip) throw new ValidationError("il PFR non può superare il VPIP");
        save({ t: "style", id, name: text(body?.name, "nome"), vpip, pfr, af, ts: now });
        return ok({ id, name: text(body?.name, "nome"), vpip, pfr, af });
      }
      const style = /^\/styles\/([\w:-]+)$/.exec(path);
      if (style && method === "DELETE") {
        if (style[1].startsWith("builtin:")) return fail(422, "gli stili predefiniti non si eliminano");
        if (!state.styles.has(style[1])) return fail(404, "stile non trovato");
        save({ t: "style_del", id: style[1], ts: now });
        return ok({ ok: true });
      }

      // ----- hand history -----
      if (route === "GET /hands") {
        const limit = num(body?.limit, "limite", 1, 200, 50);
        return ok([...state.hands.values()].sort((a, b) => b.ts - a.ts).slice(0, limit));
      }
      if (route === "POST /hands") {
        const hand = parseHand(body, shortId("h_"), now);
        save({ t: "hand", hand, ts: now });
        return ok(hand);
      }
      const hand = /^\/hands\/([\w-]+)$/.exec(path);
      if (hand) {
        const existing = state.hands.get(hand[1]);
        if (!existing) return fail(404, "mano non trovata");
        if (method === "DELETE") { save({ t: "hand_del", id: existing.id, ts: now }); return ok({ ok: true }); }
        if (method === "PUT") { // amend: same id and original time, so recency order is preserved
          const amended = parseHand(body, existing.id, existing.ts);
          save({ t: "hand", hand: amended, ts: now });
          return ok(amended);
        }
      }
      return fail(404, "non trovato");
    } catch (e) {
      if (e instanceof ValidationError || (e instanceof Error && INPUT_ERROR.test(e.message))) {
        return fail(422, (e as Error).message);
      }
      throw e;
    }
  };
}
