"use strict";
const RANKS = "23456789TJQKA", SUITS = [["s", "♠"], ["h", "♥"], ["d", "♦"], ["c", "♣"]];
const SUIT_NAMES = { s: "Picche", h: "Cuori", d: "Quadri", c: "Fiori" };
const SLOT_NAMES = ["Tu", "Tu", "Flop", "Flop", "Flop", "Turn", "River"];
const STREETS = ["Preflop", "Flop", "Turn", "River"];
const ACTION_NAMES = { fold: "fold", check: "check", call: "call", bet: "bet", raise: "raise", allin: "all-in" };
const OPP_ACTION = { fold: "none", check: "none", call: "call", bet: "bet", raise: "raise", allin: "raise" };
const MAX_DEAD = 10;
const $ = (id) => document.getElementById(id);
// sel: "s<i>" hero/board slot, "k<uid>_<n>" a card an opponent showed, "dead" a card seen out of play
const state = { slots: Array(7).fill(null), sel: "s0", suit: "h", dead: [], players: [], styles: [], opps: [], log: [], uid: 0 };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.filter((k) => k != null));
  return el;
}
const isRed = (c) => c[1] === "h" || c[1] === "d";
const pretty = (c) => (c[0] === "T" ? "10" : c[0]) + SUITS.find(([s]) => s === c[1])[1];
const num = (id) => parseFloat($(id).value);
const fmt = (x) => (Math.round(x * 100) / 100).toString();
const pct = (x) => Math.round(x * 100) + "%";
const oppByUid = (uid) => state.opps.find((o) => o.uid === uid);
const oppName = (o) => (state.players.find((p) => p.id === o.player_id)?.name ?? `Avversario ${state.opps.indexOf(o) + 1}`);
const whoName = (who) => (who === "hero" ? "Tu" : oppName(oppByUid(+who.slice(1)) ?? { player_id: null }));
const streetNow = () => { const n = state.slots.slice(2).filter(Boolean).length; return n >= 5 ? 3 : n >= 4 ? 2 : n >= 3 ? 1 : 0; };
const say = (msg) => { $("notice").textContent = msg; };

async function api(path, opts) {
  const r = await fetch("/api" + path, opts && { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data.detail;
    throw new Error(Array.isArray(d) ? d.map((e) => e.msg.replace(/^Value error, /, "")).join("; ") : d || r.statusText);
  }
  return data;
}
const send = (method, path, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

/* ---------- cards ---------- */
const usedCards = () => new Set([...state.slots, ...state.dead, ...state.opps.flatMap((o) => o.known)].filter(Boolean));

function cardAt(sel) {
  if (sel.startsWith("s")) return state.slots[+sel.slice(1)];
  if (sel.startsWith("k")) { const [uid, n] = sel.slice(1).split("_").map(Number); return oppByUid(uid)?.known[n]; }
  return null;
}
function writeCard(sel, card) {
  if (sel.startsWith("s")) state.slots[+sel.slice(1)] = card;
  else if (sel.startsWith("k")) { const [uid, n] = sel.slice(1).split("_").map(Number); const o = oppByUid(uid); if (o) o.known[n] = card; }
}
function ensureSelection() {
  if (state.sel.startsWith("k") && !oppByUid(+state.sel.slice(1).split("_")[0])) state.sel = "s0";
}

function slotButton(sel, label, extraClass = "") {
  const c = cardAt(sel);
  return h("button", {
    class: "slot" + extraClass + (sel === state.sel ? " sel" : "") + (c ? " filled" : "") + (c && isRed(c) ? " red" : ""),
    "aria-label": label + (c ? " " + pretty(c) : " vuota"),
    onclick: () => {
      if (sel.startsWith("k") && sel === state.sel && c) writeCard(sel, null); // tap a selected shown card again to clear it
      else state.sel = sel;
      renderAll();
    },
  }, c ? pretty(c) : "·");
}

function renderCards() {
  ensureSelection();
  const slots = $("slots");
  slots.replaceChildren();
  state.slots.forEach((_, i) => {
    if (i === 2) slots.append(h("span", { class: "sep" }));
    slots.append(slotButton("s" + i, SLOT_NAMES[i]));
  });
  // Touch-sized picker: pick the suit once (it stays selected), then tap ranks. Targets are >= 48 px.
  const used = usedCards();
  const suitBar = h("div", { class: "suits", role: "group", "aria-label": "Seme" },
    ...SUITS.map(([s, sym]) => h("button", {
      class: "suit" + (s === state.suit ? " on" : "") + (s === "h" || s === "d" ? " red" : ""),
      "data-suit": s, "aria-label": SUIT_NAMES[s], "aria-pressed": String(s === state.suit),
      onclick: () => { state.suit = s; renderCards(); },
    }, sym)));
  const ranks = h("div", { class: "ranks" },
    ...[...RANKS].reverse().map((r) => {
      const c = r + state.suit;
      return h("button", { class: isRed(c) ? "red" : "", disabled: used.has(c), "aria-label": c, onclick: () => pick(c) }, r === "T" ? "10" : r);
    }));
  $("picker").replaceChildren(suitBar, ranks);
  $("deadRow").replaceChildren(
    ...state.dead.map((c, i) => h("button", {
      class: "chip" + (isRed(c) ? " red" : ""), "aria-label": `Togli ${c} dalle carte viste`,
      onclick: () => { state.dead.splice(i, 1); renderAll(); },
    }, pretty(c) + " ✕")),
    h("button", {
      class: "chip add" + (state.sel === "dead" ? " sel" : ""), "aria-label": "Aggiungi carta vista",
      onclick: () => { state.sel = "dead"; renderAll(); },
    }, state.dead.length ? "+" : "+ carta vista"));
}

function pick(c) {
  if (state.sel === "dead") {
    if (state.dead.length < MAX_DEAD) state.dead.push(c);
  } else if (state.sel.startsWith("k")) {
    writeCard(state.sel, c);
    const [uid, n] = state.sel.slice(1).split("_").map(Number);
    const next = oppByUid(uid).known.findIndex((x, i) => i !== n && !x);
    if (next !== -1) state.sel = `k${uid}_${next}`;
  } else {
    const i = +state.sel.slice(1);
    state.slots[i] = c;
    const next = state.slots.findIndex((x, j) => j > i && !x);
    state.sel = "s" + (next !== -1 ? next : Math.max(state.slots.findIndex((x) => !x), 0));
  }
  renderAll();
}

/* ---------- players, styles, history ---------- */
async function loadPlayers() { state.players = await api("/players"); }
async function loadStyles() {
  try { state.styles = await api("/styles"); } catch { state.styles = []; } // an older backend has no styles
}

function renderPlayers() {
  $("addSel").replaceChildren(h("option", { value: "" }, "Sconosciuto (stile medio)"),
    ...state.players.map((p) => h("option", { value: p.id }, `${p.name} · ${p.style} (${p.hands} mani)`)));
  $("roster").replaceChildren(...state.players.map((p) => {
    const history = h("div", { class: "history", hidden: true });
    const styleSel = h("select", {
      "aria-label": `Stile di ${p.name}`,
      onchange: async (e) => { await send("PUT", `/players/${p.id}/style`, { style_id: e.target.value || null }); await refreshAll(); },
    }, h("option", { value: "" }, "Nessuno (stile medio)"),
      ...state.styles.map((s) => h("option", { value: s.id, selected: s.id === p.style_id }, s.name)));
    return h("li", { class: "player" },
      h("div", {}, h("strong", {}, p.name),
        h("span", { class: "mute" }, ` — ${p.style} · ${p.hands} mani · VPIP ${pct(p.vpip)} · PFR ${pct(p.pfr)} · AF ${p.af.toFixed(1)}`)),
      h("div", { class: "row" }, state.styles.length ? styleSel : null,
        h("button", { onclick: () => toggleHistory(p, history) }, "Storico"),
        h("button", {
          onclick: async () => {
            await send("DELETE", "/players/" + p.id);
            state.opps = state.opps.filter((o) => o.player_id !== p.id);
            await refreshAll();
          },
        }, "Elimina")),
      history);
  }));
}

async function toggleHistory(p, box) {
  box.hidden = !box.hidden;
  if (box.hidden) return;
  box.replaceChildren(h("p", { class: "mute" }, "Carico…"));
  try {
    const hands = await api(`/players/${p.id}/hands`);
    box.replaceChildren(...(hands.length ? hands.map((hand) => historyEntry(p, hand, box)) : [h("p", { class: "mute" }, "Nessuna mano registrata.")]));
  } catch (e) {
    box.replaceChildren(h("p", { class: "err" }, e.message));
  }
}

function historyEntry(p, hand, box) {
  const mine = hand.actions.filter((a) => a.player === p.id);
  const byStreet = STREETS.map((name, s) => {
    const acts = mine.filter((a) => a.street === s);
    return acts.length ? `${name}: ` + acts.map((a) => ACTION_NAMES[a.type] + (a.amount ? " " + fmt(a.amount) : "") + (a.pot_before ? ` (piatto ${fmt(a.pot_before)})` : "")).join(", ") : null;
  }).filter(Boolean);
  const shown = hand.players.find((x) => x.id === p.id)?.known;
  return h("div", { class: "hand" },
    h("div", { class: "mute" }, new Date(hand.ts).toLocaleString("it") + (hand.board.length ? " · board " + hand.board.map(pretty).join(" ") : "")),
    h("div", {}, byStreet.length ? byStreet.join(" → ") : "Nessuna azione registrata"),
    shown?.length ? h("div", {}, "Ha mostrato: " + shown.map(pretty).join(" ")) : null,
    h("button", {
      class: "ghost", "aria-label": "Elimina questa mano",
      onclick: async () => { await send("DELETE", "/hands/" + hand.id); await refreshAll(); box.hidden = true; await toggleHistory(p, box); },
    }, "Elimina mano"));
}

function renderStyles() {
  $("styleList").replaceChildren(...state.styles.map((s) => h("li", {},
    h("span", {}, `${s.name} — VPIP ${pct(s.vpip)} · PFR ${pct(s.pfr)} · AF ${s.af}`),
    s.builtin ? null : h("button", {
      "aria-label": `Elimina lo stile ${s.name}`,
      onclick: async () => { await send("DELETE", "/styles/" + s.id); await refreshAll(); },
    }, "Elimina"))));
}

/* ---------- opponents ---------- */
const ACTIONS = [["none", "Nessuna / check"], ["call", "Call"], ["bet", "Bet"], ["raise", "Raise"]];
const SIZES = [[0.33, "1/3 piatto"], [0.5, "1/2 piatto"], [0.66, "2/3 piatto"], [1, "piatto"], [1.5, "overbet"]];
const newOpp = (player_id) => ({ uid: ++state.uid, player_id, action: "none", bet_frac: 0.66, known: [null, null], folded: false });

function renderOpps() {
  $("opps").replaceChildren(...state.opps.map((o) => {
    const p = state.players.find((x) => x.id === o.player_id);
    const sizeLabel = h("label", {}, "Taglia puntata", h("select", {
      "aria-label": "Taglia puntata", onchange: (e) => (o.bet_frac = +e.target.value),
    }, ...SIZES.map(([v, t]) => h("option", { value: v, selected: v === o.bet_frac }, t))));
    sizeLabel.hidden = !["bet", "raise"].includes(o.action);
    return h("div", { class: "opp" + (o.folded ? " folded" : "") },
      h("header", {}, h("strong", {}, oppName(o) + (o.folded ? " (fold)" : "")),
        h("span", { class: "tag" }, p ? `${p.style} · ${p.hands} mani` : "stile medio"),
        h("button", {
          "aria-label": "Rimuovi",
          onclick: () => { state.opps = state.opps.filter((x) => x !== o); state.log = state.log.filter((l) => l.who !== "o" + o.uid); renderAll(); },
        }, "✕")),
      h("div", { class: "grid" },
        h("label", {}, "Ultima azione", h("select", {
          onchange: (e) => { o.action = e.target.value; sizeLabel.hidden = !["bet", "raise"].includes(o.action); },
        }, ...ACTIONS.map(([v, t]) => h("option", { value: v, selected: v === o.action }, t)))),
        sizeLabel),
      h("div", { class: "known" }, h("span", { class: "tag" }, "Carte mostrate"),
        slotButton(`k${o.uid}_0`, "Prima carta mostrata", " small"), slotButton(`k${o.uid}_1`, "Seconda carta mostrata", " small")));
  }));
}

/* ---------- action log ---------- */
function renderLog() {
  const who = $("logWho"), current = who.value;
  who.replaceChildren(h("option", { value: "hero" }, "Tu"),
    ...state.opps.map((o) => h("option", { value: "o" + o.uid }, oppName(o))));
  if ([...who.options].some((x) => x.value === current)) who.value = current;
  $("log").replaceChildren(...state.log.map((l) => h("li", {},
    `${STREETS[l.street]} · ${whoName(l.who)}: ${ACTION_NAMES[l.type]}${l.amount ? " " + fmt(l.amount) : ""}` +
    (l.pot_before ? ` (piatto ${fmt(l.pot_before)})` : ""))));
}

/** Opponents' quick-mode state follows what was logged for them. */
function syncOppsFromLog() {
  for (const o of state.opps) {
    const mine = state.log.filter((l) => l.who === "o" + o.uid);
    o.folded = mine.some((l) => l.type === "fold");
    const last = mine[mine.length - 1];
    if (!last) continue;
    o.action = OPP_ACTION[last.type];
    if (last.amount && last.pot_before > 0) o.bet_frac = last.amount / last.pot_before;
  }
}

function addAction() {
  const type = $("logAct").value, amount = parseFloat($("logAmt").value);
  if (["bet", "raise"].includes(type) && !(amount > 0)) { say("Inserisci l'importo della puntata."); return; }
  const pot = num("pot");
  state.log.push({
    who: $("logWho").value, street: streetNow(), type,
    ...(amount > 0 ? { amount } : {}), ...(pot >= 0 ? { pot_before: pot } : {}),
  });
  $("logAmt").value = "";
  say("");
  syncOppsFromLog();
  renderAll();
}

async function saveHand() {
  try {
    const board = state.slots.slice(2).filter(Boolean);
    if (![0, 3, 4, 5].includes(board.length)) throw new Error("Il board deve avere 0, 3, 4 o 5 carte consecutive.");
    if (!state.opps.length) throw new Error("Aggiungi almeno un avversario.");
    if (!state.log.length) throw new Error("Registra almeno un'azione prima di salvare.");
    const ids = new Map(state.opps.map((o, i) => [o.uid, o.player_id || `anon:${i + 1}`]));
    const idOf = (who) => (who === "hero" ? "hero" : ids.get(+who.slice(1)));
    const hero = state.slots[0] && state.slots[1] ? [state.slots[0], state.slots[1]] : undefined;
    const hand = await send("POST", "/hands", {
      bb: num("bb"), structure: $("structure").value === "pot_limit" ? "pot_limit" : "no_limit", board, hero,
      players: state.opps.map((o) => ({ id: ids.get(o.uid), known: o.known.filter(Boolean) })),
      actions: state.log.map((l) => ({ player: idOf(l.who), street: l.street, type: l.type, amount: l.amount, pot_before: l.pot_before })),
    });
    state.slots.fill(null); state.sel = "s0"; state.dead = []; state.log = [];
    for (const o of state.opps) { o.known = [null, null]; o.folded = false; o.action = "none"; }
    await refreshAll();
    say(`Mano salvata (${hand.actions.length} azioni). Le statistiche dei giocatori sono aggiornate.`);
  } catch (e) {
    say(e.message);
  }
}

/* ---------- advice ---------- */
const ACTION_IT = { fold: "FOLD", check: "CHECK", call: "CALL", bet: "BET", raise: "RAISE A", "all-in": "ALL-IN" };

function buildRequest() {
  const s = state.slots;
  if (!s[0] || !s[1]) throw new Error("Seleziona le tue due carte.");
  const board = s.slice(2).filter(Boolean);
  if (![0, 3, 4, 5].includes(board.length) || s.slice(2, 2 + board.length).some((c) => !c))
    throw new Error("Il board deve avere 0, 3, 4 o 5 carte consecutive (flop, turn, river).");
  if (!state.opps.length) throw new Error("Aggiungi almeno un avversario.");
  const active = state.opps.filter((o) => !o.folded);
  if (!active.length) throw new Error("Tutti gli avversari hanno foldato.");
  const mode = $("structure").value;
  const req = {
    hero: s.slice(0, 2), board, structure: mode === "pot_limit" ? "pot_limit" : "no_limit",
    bb: num("bb"), pot: num("pot"), to_call: num("toCall") || 0, stack: num("stack"), position: num("position"),
    ...(state.dead.length ? { dead: state.dead } : {}),
    opponents: active.map((o) => {
      const out = { player_id: o.player_id, action: o.action, bet_frac: o.bet_frac };
      const shown = o.known.filter(Boolean);
      if (shown.length) out.known = shown;
      const mine = state.log.filter((l) => l.who === "o" + o.uid);
      if (mine.length) out.actions = mine.map(({ street, type, amount, pot_before }) => ({ street, type, ...(amount ? { amount } : {}), ...(pot_before >= 0 ? { pot_before } : {}) }));
      return out;
    }),
  };
  if (mode === "tournament") {
    const list = (id) => $(id).value.split(/[,\s;]+/).filter(Boolean).map(Number);
    const stacks = list("tStacks"), payouts = list("tPays");
    if (stacks.length < 2 || !payouts.length || [...stacks, ...payouts].some((x) => !(x >= 0)))
      throw new Error("Torneo: inserisci gli stack di tutti i giocatori e i premi.");
    req.tournament = { stacks, payouts };
  }
  return { req, active };
}

async function go() {
  const out = $("result");
  out.hidden = false;
  try {
    const { req, active } = buildRequest();
    out.replaceChildren(h("p", { class: "mute" }, "Calcolo…"));
    renderResult(await send("POST", "/advise", req), req, active);
  } catch (e) {
    out.replaceChildren(h("p", { class: "err" }, e.message));
  }
}

const NASH_WORDS = { shove: "SPINGI ALL-IN", call: "CHIAMA", fold: "FOLD" };

/** Heads-up short-stack Nash push/fold (exact solution): shown next to the normal advice, which cannot shove. */
function nashBlock(n) {
  const who = n.role === "small_blind" ? "small blind" : "big blind contro un all-in";
  const mixed = n.probability > 0.05 && n.probability < 0.95;
  return h("div", { class: "nash" },
    h("h2", {}, "Nash push/fold, heads-up"),
    h("p", { class: "big " + (n.decision === "fold" ? "fold" : "go") }, NASH_WORDS[n.decision]),
    h("p", { class: "mute" },
      `${n.hand} · ${who} · ${fmt(n.depth)} bb effettivi · ${mixed ? `strategia mista: ${pct(n.probability)} ${n.role === "small_blind" ? "spinge" : "chiama"}` : "soluzione esatta"}`),
    h("p", { class: "mute" }, "Vale se l'avversario gioca in modo ottimale."
      + (n.caveat === "icm" ? " Torneo: ignora l'ICM, vicino alla bolla può cambiare." : "")));
}

function renderResult(r, req, active) {
  const a = r.advice, p = a.probs;
  const label = ACTION_IT[a.action] + (a.amount ? " " + fmt(a.amount) : "");
  const seg = (v, color) => h("i", { style: `width:${(v * 100).toFixed(1)}%;background:${color}` });
  const cats = Object.entries(r.categories).filter(([, v]) => v > 0.0005).sort((x, y) => y[1] - x[1]);
  $("result").replaceChildren(
    h("h2", {}, "Consiglio"),
    h("p", { class: "big " + (a.action === "fold" ? "fold" : "go") }, label),
    h("div", { class: "bar", role: "img", "aria-label": "Probabilità azioni" },
      seg(p.fold_check, "var(--red)"), seg(p.call, "var(--warn)"), seg(p.raise, "var(--acc)")),
    h("p", { class: "mute" }, `${req.to_call > 0 ? "Fold" : "Check"} ${(p.fold_check * 100).toFixed(0)}% · Call ${(p.call * 100).toFixed(0)}% · Raise ${(p.raise * 100).toFixed(0)}%`
      + (a.bubble_factor > 1.01 ? ` · bubble factor ${a.bubble_factor.toFixed(2)}` : "")),
    ...(r.pushfold ? [nashBlock(r.pushfold)] : []),
    h("h2", {}, `Equity ${(r.equity * 100).toFixed(1)}% (vince ${(r.win * 100).toFixed(1)}%)`),
    h("div", { class: "meter" }, h("b", { style: `width:${(r.equity * 100).toFixed(1)}%` })),
    h("h2", { style: "margin-top:12px" }, "Mano finale più probabile"),
    h("table", {}, ...cats.map(([n, v]) => h("tr", {}, h("td", {}, n), h("td", {}, (v * 100).toFixed(1) + "%")))),
    h("h2", { style: "margin-top:12px" }, "Cosa possono avere"),
    ...r.opponents.map((o, i) => h("p", { class: "opp-range" },
      h("strong", {}, `${oppName(active[i])} (range ${o.range_pct}%): `),
      (o.top ?? []).map((t) => `${t.hand} ${t.pct}%`).join(" · ") || "—",
      o.contradiction ? h("span", { class: "err" }, " — le azioni registrate non tornano con il suo stile: range non ristretto") : null)),
    h("p", { class: "mute" }, `${r.sims.toLocaleString("it")} simulazioni · ${a.source === "net" ? "rete neurale" : "policy EV"}`));
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- wiring ---------- */
async function refreshAll() {
  await Promise.all([loadPlayers(), loadStyles()]);
  renderAll();
}
function renderAll() {
  renderCards(); renderOpps(); renderLog(); renderPlayers(); renderStyles();
}

$("go").onclick = go;
document.addEventListener("keydown", (e) => {
  const typing = ["newName", "styleName"].includes(e.target.id); // Enter in these fields is not "advise"
  if (e.key === "Enter" && !typing && !["BUTTON", "SELECT", "SUMMARY"].includes(e.target.tagName)) go();
});
$("clearCards").onclick = () => {
  state.slots.fill(null); state.sel = "s0"; state.dead = [];
  for (const o of state.opps) o.known = [null, null];
  renderAll();
};
$("structure").onchange = (e) => { $("tourney").hidden = e.target.value !== "tournament"; };
$("addOpp").onclick = () => {
  if (state.opps.length >= 9) return;
  state.opps.push(newOpp($("addSel").value || null));
  renderAll();
};
$("newPlayer").onclick = async () => {
  const name = $("newName").value.trim();
  if (!name) return;
  try { await send("POST", "/players", { name }); $("newName").value = ""; await refreshAll(); } catch (e) { say(e.message); }
};
$("logAdd").onclick = addAction;
$("logUndo").onclick = () => { state.log.pop(); syncOppsFromLog(); say(""); renderAll(); };
$("saveHand").onclick = saveHand;
$("styleAdd").onclick = async () => {
  const msg = $("styleMsg");
  try {
    await send("POST", "/styles", {
      name: $("styleName").value, vpip: num("styleVpip") / 100, pfr: num("stylePfr") / 100, af: num("styleAf"),
    });
    $("styleName").value = "";
    msg.textContent = "Stile salvato.";
    await refreshAll();
  } catch (e) {
    msg.textContent = e.message;
  }
};

state.opps.push(newOpp(null));
renderAll();
refreshAll().catch(() => {});
// Native app (Capacitor): assets are local, a service worker would only risk serving stale files after an update.
if ("serviceWorker" in navigator && !window.POKER_NATIVE) navigator.serviceWorker.register("sw.js").catch(() => {});
