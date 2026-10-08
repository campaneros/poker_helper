/** Append-only event log on the phone. Every change (new player, style, recorded hand, edit, delete) is an event;
 * the state is the fold of the log. Undo and edit never overwrite history. Each stored event carries a checksum,
 * so a damaged entry is skipped instead of taking the whole log down. */
import type { HandRecord, LegacyCounts } from "../../core/src/history.js";
import type { OppStats } from "../../core/src/policy.js";

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export const EVENTS_KEY = "poker.events.v1";
export const LEGACY_PLAYERS_KEY = "poker.players.v1"; // the interim store this log replaces

export interface StyleDef extends OppStats { id: string; name: string; builtin?: boolean }
export interface PlayerState { id: string; name: string; style_id: string | null; legacy: LegacyCounts }

export type StoreEvent =
  | { t: "player"; id: string; name: string; ts: number }
  | { t: "player_del"; id: string; ts: number }
  | { t: "style"; id: string; name: string; vpip: number; pfr: number; af: number; ts: number }
  | { t: "style_del"; id: string; ts: number }
  | { t: "assign"; player: string; style: string | null; ts: number }
  | { t: "hand"; hand: HandRecord; ts: number } // creates the hand, or amends it when the id already exists
  | { t: "hand_del"; id: string; ts: number }
  | ({ t: "legacy"; player: string; ts: number } & LegacyCounts);

/** Styles every install has. They cannot be edited or deleted; custom styles are stored as events. */
export const BUILTIN_STYLES: readonly StyleDef[] = [
  { id: "builtin:nit", name: "Nit (tight-passivo)", vpip: 0.15, pfr: 0.12, af: 2.0, builtin: true },
  { id: "builtin:tag", name: "TAG (tight-aggressivo)", vpip: 0.22, pfr: 0.17, af: 2.5, builtin: true },
  { id: "builtin:lag", name: "LAG (loose-aggressivo)", vpip: 0.4, pfr: 0.3, af: 3.0, builtin: true },
  { id: "builtin:fish", name: "Fish (loose-passivo)", vpip: 0.55, pfr: 0.06, af: 0.6, builtin: true },
  { id: "builtin:maniac", name: "Maniac", vpip: 0.7, pfr: 0.45, af: 4.0, builtin: true },
];

export interface StoreState {
  players: Map<string, PlayerState>;
  styles: Map<string, StyleDef>;
  hands: Map<string, HandRecord>;
  skipped: number; // log entries dropped because they were damaged
}

/** FNV-1a, enough to detect a truncated or edited entry (not a security measure). */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

const isEvent = (x: unknown): x is StoreEvent => {
  const e = x as StoreEvent;
  return !!e && typeof e === "object" && typeof e.t === "string" && typeof e.ts === "number";
};

/** One event per line: a damaged or truncated line costs only that event, never the rest of the log. */
const line = (e: StoreEvent): string => JSON.stringify({ e, h: checksum(JSON.stringify(e)) });

/** Read the log; lines that fail parsing, checksum or shape are dropped and counted. */
export function readEvents(storage: StorageLike): { events: StoreEvent[]; skipped: number } {
  let text: string | null = null;
  try { text = storage.getItem(EVENTS_KEY); } catch { return { events: [], skipped: 1 }; }
  const events: StoreEvent[] = [];
  let skipped = 0;
  for (const raw of (text ?? "").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const item = JSON.parse(raw);
      if (item && typeof item.h === "string" && isEvent(item.e) && checksum(JSON.stringify(item.e)) === item.h) events.push(item.e);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, skipped };
}

export function appendEvents(storage: StorageLike, add: readonly StoreEvent[]): void {
  const current = storage.getItem(EVENTS_KEY) ?? "";
  const separator = current && !current.endsWith("\n") ? "\n" : ""; // a truncated last line must not swallow the new event
  storage.setItem(EVENTS_KEY, current + separator + add.map(line).join("\n") + "\n");
}

const noCounts = (): LegacyCounts => ({ hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0 });
const add = (a: LegacyCounts, b: LegacyCounts): LegacyCounts => ({
  hands: a.hands + b.hands, vpip: a.vpip + b.vpip, pfr: a.pfr + b.pfr, bets: a.bets + b.bets, calls: a.calls + b.calls,
});

export function reduceEvents(events: readonly StoreEvent[], skipped = 0): StoreState {
  const players = new Map<string, PlayerState>();
  const styles = new Map<string, StyleDef>();
  const hands = new Map<string, HandRecord>();
  for (const e of events) {
    switch (e.t) {
      case "player": players.set(e.id, { id: e.id, name: e.name, style_id: null, legacy: noCounts() }); break;
      case "player_del": players.delete(e.id); break;
      case "style": styles.set(e.id, { id: e.id, name: e.name, vpip: e.vpip, pfr: e.pfr, af: e.af }); break;
      case "style_del": {
        styles.delete(e.id);
        for (const [id, p] of players) if (p.style_id === e.id) players.set(id, { ...p, style_id: null });
        break;
      }
      case "assign": {
        const p = players.get(e.player);
        if (p) players.set(e.player, { ...p, style_id: e.style });
        break;
      }
      case "hand": hands.set(e.hand.id, e.hand); break;
      case "hand_del": hands.delete(e.id); break;
      case "legacy": {
        const p = players.get(e.player);
        if (p) players.set(e.player, { ...p, legacy: add(p.legacy, e) });
        break;
      }
    }
  }
  return { players, styles, hands, skipped };
}

/** One-time move from the interim players store (counters only) into the log. The old key is left untouched. */
function migrateLegacy(storage: StorageLike): void {
  try {
    const raw = storage.getItem(LEGACY_PLAYERS_KEY);
    if (!raw || storage.getItem(EVENTS_KEY)) return;
    const old: unknown = JSON.parse(raw);
    if (!Array.isArray(old)) return;
    const ts = Date.now();
    const events: StoreEvent[] = [];
    for (const p of old) {
      const counts = [p?.hands, p?.vpip, p?.pfr, p?.bets, p?.calls];
      // a damaged record is skipped whole; the old key stays in place, so nothing is lost for good
      if (typeof p?.id !== "string" || typeof p?.name !== "string" || !counts.every((n) => Number.isInteger(n) && n >= 0)) continue;
      events.push({ t: "player", id: p.id, name: p.name, ts });
      if (p.hands > 0) {
        events.push({ t: "legacy", player: p.id, ts, hands: p.hands, vpip: p.vpip, pfr: p.pfr, bets: p.bets, calls: p.calls });
      }
    }
    if (events.length) appendEvents(storage, events);
  } catch {
    // unreadable interim store: nothing to migrate
  }
}

export function loadState(storage: StorageLike): StoreState {
  migrateLegacy(storage);
  const { events, skipped } = readEvents(storage);
  return reduceEvents(events, skipped);
}

export function styleById(state: StoreState, id: string | null): StyleDef | undefined {
  return id ? state.styles.get(id) ?? BUILTIN_STYLES.find((s) => s.id === id) : undefined;
}

export const allStyles = (state: StoreState): StyleDef[] => [...BUILTIN_STYLES, ...state.styles.values()];
