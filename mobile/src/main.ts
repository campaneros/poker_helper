/** Installs the on-device /api/* shim (fetch override). build-web.mjs imports this BEFORE the shared UI,
 * because the UI calls /api/players as soon as it loads. */
import type { Weights } from "../../core/src/advisor.js";
import type { EquityMatrix } from "../../core/src/icmpushfold.js";
import type { PushFoldTable } from "../../core/src/pushfold.js";
import equity169 from "../../core/equity169.json";
import pushFold from "../../core/pushfold.json";
import weights from "../../core/weights.json";
import { createLocalApi, type StorageLike } from "./localApi.js";

/** localStorage can be missing or throw (restricted contexts): fall back to memory for the session. */
function safeStorage(): StorageLike {
  try {
    const probe = "__poker_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
  }
}

(window as unknown as { POKER_NATIVE: boolean }).POKER_NATIVE = true; // tells the shared UI not to register the web service worker
const api = createLocalApi(safeStorage(), weights as Weights, pushFold as PushFoldTable, equity169 as EquityMatrix);
const realFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.href);
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the UI paint "Calcolo…" before the CPU-bound work
  const res = await api((init?.method ?? "GET").toUpperCase(), url.pathname.slice("/api".length), body);
  return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
};
