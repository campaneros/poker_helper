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
  // the roster is rebuilt after every change: an open history must come back open, or the user loses their place
  const open = state.players.findIndex((p) => p.id === state.historyFor);
  if (open >= 0) toggleHistory(state.players[open], $("roster").children[open].querySelector(".history"));
}

async function toggleHistory(p, box) {
  box.hidden = !box.hidden;
  state.historyFor = box.hidden ? null : p.id;
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
    h("button", { class: "ghost", "aria-label": "Modifica questa mano", onclick: (e) => e.target.closest(".hand").replaceWith(handEditor(p, hand, box)) }, "Modifica mano"),
    h("button", {
      class: "ghost", "aria-label": "Elimina questa mano",
      onclick: async () => { await send("DELETE", "/hands/" + hand.id); await refreshAll(); },
    }, "Elimina mano"));
}

/* ---------- amend a saved hand ---------- */
const ACTION_TYPES = ["fold", "check", "call", "bet", "raise", "allin"];
const parseCards = (t) => t.split(/[\s,]+/).filter(Boolean).map((c) => c[0].toUpperCase() + c.slice(1).toLowerCase());
const nameOfId = (id) => (id === "hero" ? "Tu" : state.players.find((p) => p.id === id)?.name ?? id.replace("anon:", "Avversario "));

/** A form that replaces the hand in the history. The server re-validates everything (impossible sequences are refused),
 * and saving is an amend event: the original time is kept, so the recency weighting of the stats does not move. */
function handEditor(p, hand, box) {
  const draft = hand.actions.map((a) => ({ ...a }));
  const err = h("p", { class: "err", role: "alert" });
  const opt = (value, text, sel) => h("option", { value, selected: sel }, text);
  const sel = (label, options, current, onchange) => h("select", { "aria-label": label, onchange: (e) => onchange(e.target.value) },
    ...options.map(([v, t]) => opt(v, t, String(v) === String(current))));
  const field = (label, input) => h("label", {}, label, input);
  const bb = h("input", { type: "number", inputmode: "decimal", step: "any", value: hand.bb, "aria-label": "Big blind" });
  const structure = h("select", { "aria-label": "Formato" }, opt("no_limit", "No limit", hand.structure !== "pot_limit"), opt("pot_limit", "Pot limit", hand.structure === "pot_limit"));
  const cardsInput = (label, cards) => h("input", { type: "text", autocapitalize: "off", autocomplete: "off", spellcheck: "false", placeholder: "es. Ah Kd 7c", value: (cards ?? []).join(" "), "aria-label": label });
  const board = cardsInput("Board", hand.board);
  const hero = cardsInput("Le tue carte", hand.hero);
  const shown = hand.players.map((pl) => ({ id: pl.id, input: cardsInput(`Carte mostrate da ${nameOfId(pl.id)}`, pl.known) }));
  const who = [["hero", "Tu"], ...hand.players.map((pl) => [pl.id, nameOfId(pl.id)])];
  const rows = h("div", { class: "edit-actions" });
  const drawRows = () => rows.replaceChildren(...draft.map((a, i) => {
    const num = (label, key) => h("input", {
      type: "number", inputmode: "decimal", step: "any", min: "0", "aria-label": label, placeholder: label, value: a[key] ?? "",
      oninput: (e) => { if (e.target.value === "") delete a[key]; else a[key] = parseFloat(e.target.value); },
    });
    const move = (d) => { const j = i + d; if (j < 0 || j >= draft.length) return; [draft[i], draft[j]] = [draft[j], draft[i]]; drawRows(); };
    return h("div", { class: "edit-action" },
      sel(`Azione ${i + 1}: giocatore`, who, a.player, (v) => (a.player = v)),
      sel(`Azione ${i + 1}: strada`, STREETS.map((n, s) => [s, n]), a.street, (v) => (a.street = +v)),
      sel(`Azione ${i + 1}: tipo`, ACTION_TYPES.map((t) => [t, ACTION_NAMES[t]]), a.type, (v) => (a.type = v)),
      num("Importo", "amount"), num("Piatto prima", "pot_before"),
      h("span", { class: "edit-move" },
        h("button", { type: "button", "aria-label": `Sposta su l'azione ${i + 1}`, onclick: () => move(-1) }, "↑"),
        h("button", { type: "button", "aria-label": `Sposta giù l'azione ${i + 1}`, onclick: () => move(1) }, "↓"),
        h("button", { type: "button", "aria-label": `Elimina l'azione ${i + 1}`, onclick: () => { draft.splice(i, 1); drawRows(); } }, "✕")));
  }));
  drawRows();
  const save = h("button", { type: "button", "aria-label": "Salva le modifiche alla mano" }, "Salva modifiche");
  const editor = h("div", { class: "hand editor" },
    h("strong", {}, "Modifica mano"),
    field("Big blind", bb), field("Formato", structure), field("Board (0, 3, 4 o 5 carte)", board), field("Le tue carte", hero),
    ...shown.map((s) => field(`Carte mostrate da ${nameOfId(s.id)}`, s.input)),
    h("strong", {}, "Azioni, in ordine"), rows,
    h("button", { type: "button", class: "ghost", onclick: () => { draft.push({ player: who[0][0], street: draft.at(-1)?.street ?? 0, type: "check" }); drawRows(); } }, "+ Azione"),
    err, save,
    h("button", { type: "button", class: "ghost", onclick: () => { box.hidden = true; toggleHistory(p, box); } }, "Annulla"));
  save.onclick = async () => {
    err.textContent = "";
    save.disabled = true;
    try {
      const heroCards = parseCards(hero.value);
      await send("PUT", "/hands/" + hand.id, {
        bb: parseFloat(bb.value), structure: structure.value, board: parseCards(board.value), ...(heroCards.length ? { hero: heroCards } : {}),
        players: shown.map((s) => ({ id: s.id, known: parseCards(s.input.value) })),
        actions: draft.map((a) => ({ player: a.player, street: a.street, type: a.type, ...(a.amount !== undefined ? { amount: a.amount } : {}), ...(a.pot_before !== undefined ? { pot_before: a.pot_before } : {}) })),
      });
      await refreshAll(); // the history reopens by itself, showing the amended hand
      say("Mano modificata. Le statistiche sono ricalcolate; l'ora originale è rimasta.");
    } catch (e) {
      err.textContent = e.message; // the server's reason: impossible sequence, duplicate card, full storage...
      save.disabled = false;
    }
  };
  return editor;
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
const newOpp = (player_id) => ({ uid: ++state.uid, player_id, action: "none", bet_frac: 0.66, known: [null, null], folded: false, villain: "" });
/** The stacks typed for the tournament, as numbers (hero first). */
const tournamentStacks = () => $("tStacks").value.split(/[,\s;]+/).filter(Boolean).map(Number).filter((x) => x >= 0);

/** The bet as a fraction of the pot BEFORE it. A typed amount wins over the preset size; the pot field already
 * contains this bet, so it is taken out first. */
function betFraction(o) {
  if (!(o.bet_amount > 0)) return o.bet_frac;
  const pot = num("pot"), before = pot - o.bet_amount > 0 ? pot - o.bet_amount : pot;
  return before > 0 ? Math.min(10, Math.max(0.01, o.bet_amount / before)) : o.bet_frac;
}

function renderOpps() {
  $("opps").replaceChildren(...state.opps.map((o) => {
    const p = state.players.find((x) => x.id === o.player_id);
    const sizeLabel = h("label", {}, "Taglia puntata", h("select", {
      "aria-label": "Taglia puntata", onchange: (e) => (o.bet_frac = +e.target.value),
    }, ...SIZES.map(([v, t]) => h("option", { value: v, selected: v === o.bet_frac }, t))));
    const amountLabel = h("label", {}, "Oppure importo (fiche)", h("input", {
      type: "number", inputmode: "decimal", step: "any", min: "0", placeholder: "es. 30", value: o.bet_amount ?? "",
      "aria-label": "Importo della puntata in fiche",
      oninput: (e) => { o.bet_amount = e.target.value === "" ? undefined : parseFloat(e.target.value); },
    }));
    sizeLabel.hidden = amountLabel.hidden = !["bet", "raise"].includes(o.action);
    return h("div", { class: "opp" + (o.folded ? " folded" : "") },
      h("header", {}, h("strong", {}, oppName(o) + (o.folded ? " (fold)" : "")),
        h("span", { class: "tag" }, p ? `${p.style} · ${p.hands} mani` : "stile medio"),
        h("button", {
          "aria-label": "Rimuovi",
          onclick: () => { state.opps = state.opps.filter((x) => x !== o); state.log = state.log.filter((l) => l.who !== "o" + o.uid); renderAll(); },
        }, "✕")),
      h("div", { class: "grid" },
        h("label", {}, "Ultima azione", h("select", {
          onchange: (e) => { o.action = e.target.value; sizeLabel.hidden = amountLabel.hidden = !["bet", "raise"].includes(o.action); },
        }, ...ACTIONS.map(([v, t]) => h("option", { value: v, selected: v === o.action }, t)))),
        sizeLabel, amountLabel),
      $("structure").value === "tournament" && tournamentStacks().length > 2 ? h("label", {}, "Quale stack della lista?", h("select", {
        "aria-label": "Stack dell'avversario nella lista del torneo", onchange: (e) => (o.villain = e.target.value),
      }, h("option", { value: "" }, "Il più grande"),
        ...tournamentStacks().slice(1).map((v, i) => h("option", { value: String(i + 1), selected: String(i + 1) === o.villain }, `Stack ${i + 2}: ${fmt(v)}`)))) : null,
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
    if (last.amount && last.pot_before > 0) { o.bet_frac = last.amount / last.pot_before; o.bet_amount = undefined; } // the log is explicit
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
  const button = $("saveHand");
  if (button.disabled) return; // a double tap must not record the hand twice
  button.disabled = true;
  state.pendingHandId ??= "h_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); // a retry reuses it
  try {
    const board = state.slots.slice(2).filter(Boolean);
    if (![0, 3, 4, 5].includes(board.length)) throw new Error("Il board deve avere 0, 3, 4 o 5 carte consecutive.");
    if (!state.opps.length) throw new Error("Aggiungi almeno un avversario.");
    if (!state.log.length) throw new Error("Registra almeno un'azione prima di salvare.");
    const ids = new Map(state.opps.map((o, i) => [o.uid, o.player_id || `anon:${i + 1}`]));
    const idOf = (who) => (who === "hero" ? "hero" : ids.get(+who.slice(1)));
    const hero = state.slots[0] && state.slots[1] ? [state.slots[0], state.slots[1]] : undefined;
    const hand = await send("POST", "/hands", {
      id: state.pendingHandId, bb: num("bb"), structure: $("structure").value === "pot_limit" ? "pot_limit" : "no_limit", board, hero,
      players: state.opps.map((o) => ({ id: ids.get(o.uid), known: o.known.filter(Boolean) })),
      actions: state.log.map((l) => ({ player: idOf(l.who), street: l.street, type: l.type, amount: l.amount, pot_before: l.pot_before })),
    });
    state.pendingHandId = null;
    state.slots.fill(null); state.sel = "s0"; state.dead = []; state.log = [];
    for (const o of state.opps) { o.known = [null, null]; o.folded = false; o.action = "none"; }
    await refreshAll();
    say(`Mano salvata (${hand.actions.length} azioni). Le statistiche dei giocatori sono aggiornate.`);
  } catch (e) {
    say(e.message);
  } finally {
    button.disabled = false;
  }
}

/* ---------- advice ---------- */
const SOURCE_NAMES = {
  net: "rete neurale", teacher: "policy EV", nash: "Nash esatto (push/fold)", nash_icm: "Nash con ICM (push/fold)",
  multiway: "stima shove multiway (approssimata)",
};
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
      const out = { player_id: o.player_id, action: o.action, bet_frac: betFraction(o) };
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
    const chosen = active.length === 1 ? active[0].villain : "";
    req.tournament = { stacks, payouts, ...(chosen ? { villain: Number(chosen) } : {}) };
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
      `${n.hand} · ${who} · ${fmt(n.depth)} bb effettivi · ${mixed ? `strategia mista: ${pct(n.probability)} ${n.role === "small_blind" ? "spinge" : "chiama"}` : n.icm ? "calcolata per questo torneo (ICM)" : "soluzione esatta"}`),
    h("p", { class: "mute" }, "Vale se l'avversario gioca in modo ottimale."
      + (n.icm ? ` Tiene conto di tutti gli stack e dei premi${n.gap > 0.001 ? " (soluzione approssimata: " + (n.gap * 100).toFixed(2) + "% del montepremi di scarto)" : ""}.` : "")
      + (n.caveat === "icm" ? " Torneo: ignora l'ICM, vicino alla bolla può cambiare." : "")));
}

/** Open shove with 2+ opponents: an approximate EV, never a solution. The numbers are shown so the caller can judge. */
function multiwayBlock(m, calls) {
  const shove = m.decision === "shove";
  const unsure = Math.abs(m.ev_bb) < 2 * m.se_bb;
  return h("div", { class: "multiway" },
    h("h2", {}, "Shove multiway (stima)"),
    h("p", { class: "big " + (shove ? "go" : "fold") }, shove ? "SPINGERE CONVIENE" : "SPINGERE NON CONVIENE"),
    h("p", { class: "mute" },
      `${m.hand} · ${fmt(m.depth)} bb · EV dello shove ${m.ev_bb >= 0 ? "+" : ""}${m.ev_bb.toFixed(2)} bb (±${m.se_bb.toFixed(2)}) rispetto al fold`
      + ` · nessuno chiama ${pct(m.nobody_calls)}`),
    h("p", { class: "mute" }, "Chiamano: " + m.call_probs.map((c, i) => `${oppName(calls[i])} ${pct(c)}`).join(" · ")),
    h("p", { class: "mute" }, "Stima, non equilibrio: ogni avversario chiama in modo indipendente con un range dedotto dalla larghezza del Nash"
      + " heads-up e dal suo VPIP; le side pot e le azioni già fatte in questa mano non sono modellate."
      + (m.bubble_factor > 1.01 ? ` Torneo: rischio pesato con bubble factor ${m.bubble_factor.toFixed(2)}.` : "")
      + (unsure ? " Il valore è dentro l'errore di stima: la scelta è dubbia." : "")));
}

/** The 13x13 map of an opponent's range: pairs on the diagonal, suited above it, offsuit below. Read-only; tapping a cell
 * names it. Shade is relative to the most likely class (square root, so rare hands stay visible), and every cell also
 * carries its label, so colour is never the only signal. */
function rangeGrid(grid, who) {
  const order = [...RANKS].reverse(); // A K Q ... 2
  const label = (i, j) => (i === j ? order[i] + order[j] : i < j ? order[i] + order[j] + "s" : order[j] + order[i] + "o");
  const top = Math.max(...Object.values(grid), 0.01);
  const detail = h("p", { class: "mute", "aria-live": "polite" }, "Tocca una cella per vedere la probabilità.");
  const cells = [];
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const name = label(i, j), v = grid[name] ?? 0, t = Math.sqrt(v / top);
      cells.push(h("div", {
        class: "cell" + (v > 0 ? " on" : ""), "data-hand": name, "data-pct": v,
        style: `background:rgba(46,125,50,${(0.08 + 0.92 * t).toFixed(2)});color:${t > 0.55 ? "#fff" : "inherit"}`,
        onclick: () => { detail.textContent = v > 0 ? `${name}: ${v.toFixed(v < 1 ? 2 : 1)}% del range di ${who}` : `${name}: fuori dal range di ${who}`; },
      }, name));
    }
  }
  return h("details", { class: "range-map" },
    h("summary", {}, `Griglia del range di ${who}`),
    h("div", { class: "grid13", role: "img", "aria-label": `Griglia 13 per 13 del range di ${who}: coppie sulla diagonale, suited sopra, offsuit sotto` }, ...cells),
    h("p", { class: "mute" }, "Più scuro = più probabile. Coppie sulla diagonale, suited sopra, offsuit sotto."),
    detail);
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
    ...(r.multiway ? [multiwayBlock(r.multiway, active)] : []),
    h("h2", {}, `Equity ${(r.equity * 100).toFixed(1)}% (vince ${(r.win * 100).toFixed(1)}%)`),
    h("div", { class: "meter" }, h("b", { style: `width:${(r.equity * 100).toFixed(1)}%` })),
    h("h2", { style: "margin-top:12px" }, "Mano finale più probabile"),
    h("table", {}, ...cats.map(([n, v]) => h("tr", {}, h("td", {}, n), h("td", {}, (v * 100).toFixed(1) + "%")))),
    h("h2", { style: "margin-top:12px" }, "Cosa possono avere"),
    ...r.opponents.flatMap((o, i) => [h("p", { class: "opp-range" },
      h("strong", {}, `${oppName(active[i])} (range ${o.range_pct}%): `),
      (o.top ?? []).map((t) => `${t.hand} ${t.pct}%`).join(" · ") || "—",
      o.contradiction ? h("span", { class: "err" }, " — le azioni registrate non tornano con il suo stile: range non ristretto") : null),
      o.grid ? rangeGrid(o.grid, oppName(active[i])) : null]),
    h("p", { class: "mute" }, `${r.sims.toLocaleString("it")} simulazioni · ${SOURCE_NAMES[a.source] ?? a.source}`));
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
$("structure").onchange = (e) => { $("tourney").hidden = e.target.value !== "tournament"; renderOpps(); };
$("tStacks").addEventListener("input", renderOpps);
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
