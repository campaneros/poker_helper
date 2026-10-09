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
const state = {
  slots: Array(7).fill(null), sel: "s0", suit: "h", dead: [], players: [], styles: [], opps: [], log: [], uid: 0,
  // the table: seats in clockwise order ("hero" or "o<uid>"), who acts first before the flop, what was done so far
  seats: ["hero"], first: null, acts: [], undo: [], menu: null, hands: [], renaming: null, adding: false,
};
const T = window.POKER_TABLE; // the betting engine (core/src/table.ts), installed by the app shell

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
    const renameForm = () => {
      const input = h("input", { type: "text", maxlength: "40", value: p.name, "aria-label": `Nuovo nome di ${p.name}`, "data-name-input": "1" });
      const save = async () => {
        try {
          await send("PUT", "/players/" + p.id, { name: input.value });
          state.renaming = null;
          say(`Rinominato: ${input.value.trim()}.`);
          await refreshAll();
        } catch (e) { say(e.message); }
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
      return h("div", { class: "row name-row" }, input, h("button", { type: "button", onclick: save }, "Salva"),
        h("button", { type: "button", onclick: () => { state.renaming = null; renderPlayers(); } }, "Annulla"));
    };
    return h("li", { class: "player" },
      h("div", {}, state.renaming === p.id ? renameForm() : h("strong", {}, p.name),
        h("span", { class: "mute" }, ` — ${p.style} · ${p.hands} mani · VPIP ${pct(p.vpip)} · PFR ${pct(p.pfr)} · AF ${p.af.toFixed(1)}`)),
      h("div", { class: "row" }, state.styles.length ? styleSel : null,
        h("button", { onclick: () => toggleHistory(p, history) }, "Storico"),
        h("button", { "aria-label": `Rinomina ${p.name}`, onclick: () => { state.renaming = p.id; renderPlayers(); } }, "Rinomina"),
        h("button", {
          onclick: async () => {
            await send("DELETE", "/players/" + p.id);
            state.opps = state.opps.filter((o) => o.player_id !== p.id);
            await refreshAll();
          },
        }, "Elimina")),
      suggestionBlock(p),
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
    h("button", { class: "ghost", "aria-label": "Modifica questa mano", onclick: (e) => e.target.closest(".hand").replaceWith(handEditor(hand)) }, "Modifica mano"),
    h("button", {
      class: "ghost", "aria-label": "Elimina questa mano",
      onclick: async () => { await send("DELETE", "/hands/" + hand.id); await refreshAll(); },
    }, "Elimina mano"));
}

/* ---------- amend a saved hand ---------- */
const ACTION_TYPES = ["fold", "check", "call", "bet", "raise", "allin"];
const parseCards = (t) => t.split(/[\s,]+/).filter(Boolean).map((c) => c[0].toUpperCase() + c.slice(1).toLowerCase());
/** A form that replaces the hand in the history. The server re-validates everything (impossible sequences are refused),
 * and saving is an amend event: the original time is kept, so the recency weighting of the stats does not move. */
function handEditor(hand) {
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
    h("button", { type: "button", class: "ghost", onclick: () => refreshAll() }, "Annulla"));
  save.onclick = async () => {
    err.textContent = "";
    save.disabled = true;
    try {
      const heroCards = parseCards(hero.value);
      await send("PUT", "/hands/" + hand.id, {
        ...(hand.table ? { table: hand.table } : {}),
        bb: parseFloat(bb.value), structure: structure.value, board: parseCards(board.value), ...(heroCards.length ? { hero: heroCards } : {}),
        players: shown.map((s) => ({ id: s.id, known: parseCards(s.input.value) })),
        actions: draft.map((a) => ({ player: a.player, street: a.street, type: a.type, ...(a.amount !== undefined ? { amount: a.amount } : {}), ...(a.pot_before !== undefined ? { pot_before: a.pot_before } : {}) })),
      });
      await refreshAll(); // the histories reopen by themselves, showing the amended hand
      say("Mano modificata. Le statistiche sono ricalcolate; l'ora originale è rimasta.");
    } catch (e) {
      err.textContent = e.message; // the server's reason: impossible sequence, duplicate card, full storage...
      save.disabled = false;
    }
  };
  return editor;
}

function renderStyles() {
  const chosen = $("newStyle").value;
  $("newStyle").replaceChildren(h("option", { value: "" }, "Nessuno (stile medio)"),
    ...state.styles.map((s) => h("option", { value: s.id, selected: s.id === chosen }, s.name)));
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
        h("span", { class: "tag" }, p ? `${p.style} · ${p.hands} mani` : o.style_id ? state.styles.find((s) => s.id === o.style_id)?.name ?? "stile medio" : "stile medio"),
        h("button", {
          "aria-label": "Rimuovi",
          onclick: () => removeOpp(o),
        }, "✕")),
      nameControl(o),
      styleControl(o),
      p ? suggestionBlock(p) : null,
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
  $("log").replaceChildren(...state.log.map((l) => h("li", {},
    `${STREETS[l.street]} · ${whoName(l.who)}: ${ACTION_NAMES[l.type]}${l.amount ? " " + fmt(l.amount) : ""}` +
    (l.pot_before ? ` (piatto ${fmt(l.pot_before)})` : ""))));
}

/* ---------- the table ---------- */
const keyOf = (o) => "o" + o.uid;
const seatName = (key) => (key === "hero" ? "Tu" : oppName(oppByUid(+key.slice(1)) ?? { player_id: null }));
const boardCount = () => state.slots.slice(2).filter(Boolean).length;
const idOfSeat = (key) => (key === "hero" ? "hero" : state.opps.find((o) => keyOf(o) === key)?.player_id || `anon:${state.opps.findIndex((o) => keyOf(o) === key) + 1}`);

/** The seating and the engine's view of the hand so far; null until the first player to act is chosen. */
function tableState() {
  if (!T || state.seats.length < 2 || !state.first || !state.seats.includes(state.first)) return null;
  const r = T.replay({ seats: state.seats, first: state.seats.indexOf(state.first), bb: num("bb") }, state.acts);
  return "state" in r ? r.state : null;
}

/** Everything that follows from the table: the log, who folded, the pot, what hero owes, the position. */
function syncFromTable() {
  const st = tableState();
  state.log = st ? st.steps.map((x) => ({ ...x })) : [];
  for (const o of state.opps) {
    const mine = state.log.filter((l) => l.who === keyOf(o));
    o.folded = !!st && st.folded.includes(keyOf(o));
    const last = mine[mine.length - 1];
    if (!last) continue;
    o.action = OPP_ACTION[last.type];
    if (last.amount && last.pot_before > 0) { o.bet_frac = last.amount / last.pot_before; o.bet_amount = undefined; } // the table is explicit
  }
  if (!st) return;
  $("pot").value = fmt(T.pot(st));
  $("toCall").value = st.folded.includes("hero") ? 0 : fmt(T.toCall(st, "hero"));
  const pos = T.positionOf(st, "hero");
  const options = [...$("position").options];
  $("position").value = options.reduce((best, x) => (Math.abs(+x.value - pos) < Math.abs(+best.value - pos) ? x : best)).value;
}

function afterTableChange() {
  syncFromTable();
  renderAll();
}

/** Seat a new opponent (after the given seat if it is at the table, otherwise last). Returns him, or null if he cannot sit. */
function addOpp(playerId, { after = null, styleId = null } = {}) {
  if (state.opps.length >= 9) { say("Il tavolo è pieno (10 giocatori, con te)."); return null; }
  if (state.acts.length) { say("Hai già registrato azioni: annullale per cambiare i giocatori al tavolo."); return null; }
  const o = newOpp(playerId);
  if (!playerId && styleId) o.style_id = styleId;
  state.opps.push(o);
  const at = state.seats.indexOf(after);
  if (at >= 0) state.seats.splice(at + 1, 0, keyOf(o)); else state.seats.push(keyOf(o));
  afterTableChange();
  return o;
}

const styleOptions = (current) => [h("option", { value: "" }, "Nessuno (stile medio)"),
  ...state.styles.map((s) => h("option", { value: s.id, selected: s.id === current }, s.name))];

/** The style of an opponent: a saved player's style is saved with him; an anonymous one is for this hand only. */
function styleControl(o) {
  const p = state.players.find((x) => x.id === o.player_id);
  return h("label", {}, p ? "Stile del giocatore" : "Stile (solo per questa mano)", h("select", {
    "aria-label": `Stile di ${seatName(keyOf(o))}`,
    onchange: async (e) => {
      const id = e.target.value || null;
      if (!p) { o.style_id = id; afterTableChange(); return; }
      try { await send("PUT", `/players/${p.id}/style`, { style_id: id }); await refreshAll(); } catch (err) { say(err.message); }
    },
  }, ...styleOptions(p ? p.style_id : o.style_id)));
}

/** "He plays more like X": shown when the recorded hands fit another style better than the one he has. */
function suggestionBlock(p) {
  const s = p.suggested_style;
  if (!s) return null;
  return h("p", { class: "suggest", role: "note" },
    `Dalle ${s.hands} mani registrate gioca più come «${s.name}» (VPIP ${pct(s.observed.vpip)}, PFR ${pct(s.observed.pfr)}, AF ${s.observed.af.toFixed(1)}).`,
    h("button", {
      type: "button", "aria-label": `Usa lo stile ${s.name} per ${p.name}`,
      onclick: async () => {
        try { await send("PUT", `/players/${p.id}/style`, { style_id: s.style_id }); await refreshAll(); } catch (e) { say(e.message); }
      },
    }, `Usa «${s.name}»`));
}

/** A player sits down at the table: a saved one, or a new one with a name and style of the user's choice. */
async function seatFromPanel(profileId, rawName, styleId, err) {
  err.textContent = "";
  if (state.acts.length) { err.textContent = "Hai già registrato azioni: annullale per far sedere qualcuno."; return; }
  try {
    let playerId = profileId || null;
    const name = rawName.trim();
    if (!playerId && name) {
      const same = state.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (same && state.opps.some((x) => x.player_id === same.id)) throw new Error(`${same.name} è già seduto al tavolo.`);
      playerId = same ? same.id : (await send("POST", "/players", { name, style_id: styleId || null })).id;
    }
    const o = addOpp(playerId, { after: state.menu, styleId });
    if (!o) return;
    state.adding = false;
    state.menu = keyOf(o); // open at once: the user can move him or make him the first to act
    await refreshAll();
    say(`${seatName(keyOf(o))} è seduto al tavolo.`);
  } catch (e) {
    err.textContent = e.message;
  }
}

function renderAddSeat() {
  const box = $("addSeatPanel");
  if (!state.adding) { box.hidden = true; return; }
  box.hidden = false;
  const close = h("button", { type: "button", "aria-label": "Chiudi", onclick: () => { state.adding = false; renderAddSeat(); } }, "✕");
  if (state.acts.length) {
    box.replaceChildren(h("header", {}, h("strong", {}, "Aggiungi giocatore"), close),
      h("p", { class: "mute" }, "Hai già registrato azioni: annullale per cambiare i giocatori al tavolo."));
    return;
  }
  const seated = new Set(state.opps.map((o) => o.player_id).filter(Boolean));
  const profile = h("select", { "aria-label": "Giocatore da far sedere", id: "seatProfile" }, h("option", { value: "" }, "Nuovo giocatore"),
    ...state.players.filter((p) => !seated.has(p.id)).map((p) => h("option", { value: p.id }, `${p.name} · ${p.style}`)));
  const name = h("input", { type: "text", maxlength: "40", placeholder: "Nome (facoltativo)", "aria-label": "Nome del nuovo giocatore", "data-name-input": "1" });
  const style = h("select", { "aria-label": "Stile del nuovo giocatore" }, ...styleOptions(null));
  const fresh = h("div", { class: "grid" }, h("label", {}, "Nome", name), h("label", {}, "Stile", style));
  profile.onchange = () => { fresh.hidden = !!profile.value; };
  const err = h("p", { class: "err", role: "alert" });
  const go = () => seatFromPanel(profile.value, name.value, style.value || null, err);
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  const after = state.menu && state.seats.includes(state.menu) ? seatName(state.menu) : null;
  box.replaceChildren(h("header", {}, h("strong", {}, "Aggiungi un giocatore al tavolo"), close),
    h("label", {}, "Chi", profile), fresh,
    h("p", { class: "mute" }, (after ? `Si siede subito dopo ${after}` : "Si siede in fondo") + "; poi lo puoi spostare con ◀ ▶."
      + " Con un nome diventa un giocatore salvato e la sua storia si accumula; senza nome resta anonimo."),
    h("div", { class: "row" }, h("button", { type: "button", onclick: go }, "Siediti al tavolo"),
      h("button", { type: "button", class: "ghost", onclick: () => { state.adding = false; renderAddSeat(); } }, "Annulla")),
    err);
}

/** Give an opponent a name of the user's choice. Without a profile this saves a new one, so his history and stats start to
 * accumulate under that name; with one it renames it. A name that already exists reuses that profile instead of making a twin. */
async function nameOpponent(o, raw) {
  const name = raw.trim();
  if (!name) { say("Scrivi un nome."); return; }
  try {
    const same = state.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (o.player_id) {
      await send("PUT", "/players/" + o.player_id, { name });
      say(`Rinominato: ${name}.`);
    } else if (same) {
      if (state.opps.some((x) => x !== o && x.player_id === same.id)) throw new Error(`${same.name} è già seduto al tavolo.`);
      o.player_id = same.id;
      say(`Esiste già un profilo «${same.name}»: assegnato a questo posto.`);
    } else {
      o.player_id = (await send("POST", "/players", { name, style_id: o.style_id || null })).id;
      o.style_id = null; // now stored with the player
      say(`Salvato come ${name}: da ora la sua storia si accumula sotto questo nome.`);
    }
    await refreshAll();
  } catch (e) {
    say(e.message);
  }
}

function nameControl(o) {
  const input = h("input", {
    type: "text", maxlength: "40", placeholder: "Nome a tua scelta", "aria-label": "Nome del giocatore", "data-name-input": "1",
    value: state.players.find((p) => p.id === o.player_id)?.name ?? "",
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); nameOpponent(o, input.value); } },
  });
  return h("div", { class: "row name-row" }, input, h("button", { type: "button", onclick: () => nameOpponent(o, input.value) }, "Salva nome"));
}

function removeOpp(o) {
  if (state.acts.length) { say("Hai già registrato azioni: annullale per togliere un giocatore dal tavolo."); return; }
  state.opps = state.opps.filter((x) => x !== o);
  state.seats = state.seats.filter((k) => k !== keyOf(o));
  if (state.first === keyOf(o)) state.first = null;
  if (state.menu === keyOf(o)) state.menu = null;
  afterTableChange();
}

/** Where a seat is drawn: hero at the bottom, the others clockwise in table order. */
function seatPosition(key) {
  const n = state.seats.length, k = (state.seats.indexOf(key) - state.seats.indexOf("hero") + n) % n;
  const angle = (Math.PI / 2) + (k * 2 * Math.PI) / n;
  return `left:${(50 + 41 * Math.cos(angle)).toFixed(1)}%;top:${(50 + 42 * Math.sin(angle)).toFixed(1)}%`;
}

function renderTable() {
  const st = tableState();
  const need = st && !st.over ? T.BOARD_FOR_STREET[st.street] : 0;
  $("tableHint").textContent = !T ? "" : state.seats.length < 2 ? "Aggiungi gli avversari: ognuno prende un posto al tavolo."
    : !st ? "Tocca un giocatore e scegli «Parla per primo» (il primo a parlare prima del flop): da lì ricavo bottone, bui e turni."
    : st.over ? (st.over === "fold" ? "Mano finita: tutti hanno foldato." : "Non ci sono più puntate: escono le carte e si scoprono.")
    : boardCount() < need ? `Inserisci le carte del ${["", "flop", "turn", "river"][st.street]} per continuare.`
    : `Tocca a ${seatName(T.nextToAct(st))}${T.nextToAct(st) === "hero" ? ": premi «Consiglia»" : ""}.`;
  const turn = st && !st.over ? T.nextToAct(st) : null;
  const seats = state.seats.map((key, i) => {
    const flags = [];
    if (st && i === st.button) flags.push("D");
    if (st && i === st.smallBlind) flags.push("SB");
    if (st && i === st.bigBlind) flags.push("BB");
    if (state.first === key) flags.push("1°");
    const folded = !!st && st.folded.includes(key);
    const status = !st ? "" : folded ? "fold" : st.allIn.includes(key) ? "all-in" : st.committed[key] > 0 ? fmt(st.committed[key]) : "";
    return h("button", {
      class: "seat" + (key === "hero" ? " hero" : "") + (folded ? " folded" : "") + (turn === key ? " turn" : "") + (state.menu === key ? " picked" : ""),
      style: seatPosition(key), "data-seat": key,
      "aria-label": `${seatName(key)}${flags.length ? ", " + flags.join(" ") : ""}${status ? ", " + status : ""}. Tocca per registrare cosa fa`,
      onclick: () => { state.menu = state.menu === key ? null : key; renderTable(); renderSeatMenu(); },
    }, h("span", { class: "badges" }, ...flags.map((f) => h("b", {}, f))), h("strong", {}, seatName(key).replace(/^Avversario /, "Avv. ")), h("small", {}, status || " "));
  });
  const board = state.slots.slice(2).filter(Boolean).map(pretty).join(" ");
  $("table").replaceChildren(
    h("div", { class: "felt" },
      h("span", { class: "pot" }, st ? `Piatto ${fmt(T.pot(st))}` : "Piatto"),
      h("span", { class: "cards" }, board || "—"),
      st && !st.over && st.current > 0 ? h("span", { class: "mute" }, `Puntata da pareggiare ${fmt(st.current)}${st.lastRaise && st.lastRaise.street === st.street ? ` · ultimo rilancio: ${seatName(st.lastRaise.who)} a ${fmt(st.lastRaise.to)}` : ""}`)
        : st && !st.over ? h("span", { class: "mute" }, ["Preflop", "Flop", "Turn", "River"][st.street]) : null),
    ...seats);
}

const moveSeat = (key, d) => {
  const i = state.seats.indexOf(key), j = (i + d + state.seats.length) % state.seats.length;
  [state.seats[i], state.seats[j]] = [state.seats[j], state.seats[i]];
  afterTableChange();
};

/** What the chosen player does. Players who must have acted before him are recorded as passing (fold, or check if free). */
function commitAction(key, type, amount) {
  const st = tableState();
  const fail = (msg) => { const e = [...$("seatMenu").querySelectorAll(".err")].at(-1); if (e) e.textContent = msg; };
  if (!st) return fail("Scegli prima chi parla per primo.");
  const plan = T.skippedBefore(st, key);
  if ("error" in plan) return fail(plan.error);
  const acts = [...plan, { who: key, type, ...(amount !== undefined ? { amount } : {}) }];
  let cur = st;
  for (const a of acts) {
    const r = T.apply(cur, a);
    if ("error" in r) return fail(r.error);
    cur = r.state;
  }
  state.acts = [...state.acts, ...acts];
  state.undo.push(acts.length);
  state.menu = null;
  say(plan.length ? "Passano prima di lui: " + plan.map((a) => `${seatName(a.who)} (${a.type === "fold" ? "fold" : "check"})`).join(", ") + "." : "");
  afterTableChange();
}

function renderSeatMenu() {
  const box = $("seatMenu"), key = state.menu;
  if (!key || !state.seats.includes(key)) { box.hidden = true; return; }
  box.hidden = false;
  const st = tableState();
  const opp = key === "hero" ? null : oppByUid(+key.slice(1));
  const free = !state.acts.length;
  const parts = [h("header", {}, h("strong", {}, seatName(key)),
    h("button", { "aria-label": "Chiudi", onclick: () => { state.menu = null; renderTable(); renderSeatMenu(); } }, "✕"))];
  if (opp) {
    parts.push(nameControl(opp));
    parts.push(styleControl(opp));
    const saved = state.players.find((p) => p.id === opp.player_id);
    if (saved && suggestionBlock(saved)) parts.push(suggestionBlock(saved));
    parts.push(h("label", {}, "Profilo", h("select", {
      "aria-label": `Profilo del giocatore al posto di ${seatName(key)}`,
      onchange: (e) => { opp.player_id = e.target.value || null; opp.style_id = null; afterTableChange(); },
    }, h("option", { value: "" }, "Sconosciuto (stile medio)"),
      ...state.players.map((p) => h("option", { value: p.id, selected: p.id === opp.player_id }, `${p.name} · ${p.style}`)))));
  }
  parts.push(h("div", { class: "acts" },
    h("button", { disabled: !free, onclick: () => { state.first = key; afterTableChange(); } }, state.first === key ? "È il primo ✓" : "Parla per primo"),
    h("button", { disabled: !free, "aria-label": "Sposta a sinistra", onclick: () => moveSeat(key, -1) }, "◀ Sposta"),
    h("button", { disabled: !free, "aria-label": "Sposta a destra", onclick: () => moveSeat(key, 1) }, "Sposta ▶")));
  if (!free) parts.push(h("p", { class: "mute" }, "Ordine e primo a parlare si cambiano solo prima di registrare azioni."));
  if (st && !st.over) {
    const need = T.BOARD_FOR_STREET[st.street];
    const plan = T.skippedBefore(st, key);
    if (boardCount() < need) {
      parts.push(h("p", { class: "err" }, `Inserisci prima le carte del ${["", "flop", "turn", "river"][st.street]}.`));
    } else if ("error" in plan) {
      parts.push(h("p", { class: "err" }, plan.error));
    } else {
      let after = st;
      for (const a of plan) after = T.apply(after, a).state;
      const owe = T.toCall(after, key), pot = T.pot(after), cur = after.current;
      if (plan.length) parts.push(h("p", { class: "mute" }, "Prima di lui passano: " + plan.map((a) => seatName(a.who)).join(", ") + "."));
      const amount = h("input", {
        type: "number", inputmode: "decimal", step: "any", min: "0", id: "seatAmount",
        "aria-label": cur > 0 ? "Rilancia a (totale)" : "Importo della puntata", value: fmt(cur > 0 ? T.minRaiseTo(after) : st.bb),
      });
      const size = (label, to) => h("button", { type: "button", onclick: () => { amount.value = fmt(Math.round(to * 100) / 100); } }, label);
      const potAfterCall = pot + owe;
      parts.push(h("div", { class: "acts" },
        h("button", { onclick: () => commitAction(key, "fold") }, "Fold"),
        owe > 0 ? h("button", { onclick: () => commitAction(key, "call") }, `Call ${fmt(owe)}`) : h("button", { onclick: () => commitAction(key, "check") }, "Check")));
      parts.push(h("label", {}, cur > 0 ? `Rilancia a (totale; minimo ${fmt(T.minRaiseTo(after))})` : "Punta", amount));
      parts.push(h("div", { class: "sizes" },
        size("Min", cur > 0 ? T.minRaiseTo(after) : after.bb),
        size("½ piatto", cur + 0.5 * potAfterCall), size("¾ piatto", cur + 0.75 * potAfterCall), size("Piatto", cur + potAfterCall)));
      parts.push(h("div", { class: "acts" },
        h("button", { onclick: () => commitAction(key, cur > 0 ? "raise" : "bet", parseFloat(amount.value)) }, cur > 0 ? "Rilancia" : "Punta"),
        h("button", { onclick: () => commitAction(key, "allin", parseFloat(amount.value)) }, "All-in (totale)")));
      if (key === "hero") parts.push(h("p", { class: "mute" }, `Nel campo «Il tuo stack» hai ${fmt(num("stack"))}: per un all-in scrivi il totale che metti in questo giro.`));
    }
  }
  parts.push(h("p", { class: "err", role: "alert" }));
  box.replaceChildren(...parts);
}

/* ---------- the history of whole hands ---------- */
const nameOfId = (id) => (id === "hero" ? "Tu" : state.players.find((p) => p.id === id)?.name ?? id.replace("anon:", "Avversario "));

function handCard(hand) {
  let seating = null, potTotal = null;
  if (hand.table && T) {
    const r = T.replay({ seats: hand.table.seats, first: hand.table.first, bb: hand.bb },
      hand.actions.map((a) => ({ who: a.player, type: a.type, ...(a.amount !== undefined ? { amount: a.amount } : {}) })));
    if ("state" in r) {
      const s = r.state;
      potTotal = T.pot(s);
      seating = hand.table.seats.map((id, i) => nameOfId(id) + (i === s.button ? " (D)" : i === s.smallBlind ? " (SB)" : i === s.bigBlind ? " (BB)" : "")).join(" → ");
    }
  }
  const lines = STREETS.map((name, s) => {
    const acts = hand.actions.filter((a) => a.street === s);
    return acts.length ? `${name}: ` + acts.map((a) => `${nameOfId(a.player)} ${ACTION_NAMES[a.type]}${a.amount ? " " + fmt(a.amount) : ""}`).join(" · ") : null;
  }).filter(Boolean);
  const shown = hand.players.filter((p) => p.known?.length).map((p) => `${nameOfId(p.id)}: ${p.known.map(pretty).join(" ")}`);
  return h("li", {}, h("details", { class: "hand-card" },
    h("summary", {}, `${new Date(hand.ts).toLocaleString("it")} · ${hand.players.length + 1} giocatori${potTotal !== null ? " · piatto " + fmt(potTotal) : ""}`),
    seating ? h("p", { class: "mute" }, "Posti: " + seating + ` · bui ${fmt(hand.bb / 2)}/${fmt(hand.bb)}`) : null,
    hand.hero?.length ? h("p", {}, "Le tue carte: " + hand.hero.map(pretty).join(" ")) : null,
    hand.board.length ? h("p", {}, "Board: " + hand.board.map(pretty).join(" ")) : null,
    ...lines.map((l) => h("p", {}, l)),
    shown.length ? h("p", {}, "Mostrate: " + shown.join(" · ")) : null,
    h("button", { class: "ghost", "aria-label": "Modifica questa mano", onclick: (e) => e.target.closest("li").replaceWith(handEditor(hand)) }, "Modifica mano"),
    h("button", { class: "ghost", "aria-label": "Elimina questa mano", onclick: async () => { await send("DELETE", "/hands/" + hand.id); await refreshAll(); } }, "Elimina mano")));
}

function renderHandLog() {
  $("handLog").replaceChildren(...(state.hands.length ? state.hands.map(handCard) : [h("li", { class: "mute" }, "Nessuna mano registrata.")]));
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
    if (!tableState()) throw new Error("Indica chi parla per primo al tavolo e registra le azioni.");
    if (!state.log.length) throw new Error("Registra almeno un'azione prima di salvare.");
    const ids = new Map(state.opps.map((o, i) => [o.uid, o.player_id || `anon:${i + 1}`]));
    const idOf = (who) => (who === "hero" ? "hero" : ids.get(+who.slice(1)));
    const hero = state.slots[0] && state.slots[1] ? [state.slots[0], state.slots[1]] : undefined;
    const hand = await send("POST", "/hands", {
      id: state.pendingHandId, bb: num("bb"), structure: $("structure").value === "pot_limit" ? "pot_limit" : "no_limit", board, hero,
      table: { seats: state.seats.map(idOfSeat), first: state.seats.indexOf(state.first) },
      players: state.opps.map((o) => ({ id: ids.get(o.uid), known: o.known.filter(Boolean) })),
      actions: state.log.map((l) => ({ player: idOf(l.who), street: l.street, type: l.type, amount: l.amount, pot_before: l.pot_before })),
    });
    state.pendingHandId = null;
    // next hand: the button moves one seat clockwise, so the first to act does too
    state.first = state.seats[(state.seats.indexOf(state.first) + 1) % state.seats.length];
    state.acts = []; state.undo = []; state.menu = null;
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
    bb: num("bb"), pot: num("pot"), to_call: num("toCall") || 0, stack: num("stack"),
    position: tableState() ? T.positionOf(tableState(), "hero") : num("position"),
    ...(state.dead.length ? { dead: state.dead } : {}),
    opponents: active.map((o) => {
      const out = { player_id: o.player_id, action: o.action, bet_frac: betFraction(o) };
      if (!o.player_id && o.style_id) out.style_id = o.style_id;
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
  await Promise.all([loadPlayers(), loadStyles(), api("/hands").then((h) => { state.hands = h; }).catch(() => { state.hands = []; })]);
  renderAll();
}
function renderAll() {
  renderCards(); renderOpps(); renderLog(); renderTable(); renderAddSeat(); renderSeatMenu(); renderPlayers(); renderStyles(); renderHandLog();
}

$("go").onclick = go;
document.addEventListener("keydown", (e) => {
  const typing = ["newName", "styleName"].includes(e.target.id) || e.target.dataset?.nameInput; // Enter in these fields is not "advise"
  if (e.key === "Enter" && !typing && !["BUTTON", "SELECT", "SUMMARY"].includes(e.target.tagName)) go();
});
$("clearCards").onclick = () => {
  state.slots.fill(null); state.sel = "s0"; state.dead = [];
  for (const o of state.opps) o.known = [null, null];
  renderAll();
};
$("structure").onchange = (e) => { $("tourney").hidden = e.target.value !== "tournament"; renderOpps(); };
$("tStacks").addEventListener("input", renderOpps);
$("addOpp").onclick = () => addOpp($("addSel").value || null);
$("addSeat").onclick = () => { state.adding = !state.adding; renderAddSeat(); };
$("bb").addEventListener("change", () => { // new blinds change every amount: keep the actions only if they still hold
  if (state.acts.length && !tableState()) { state.acts = []; state.undo = []; say("Big blind cambiato: le azioni registrate non valgono più e sono state tolte."); }
  afterTableChange();
});
$("newPlayer").onclick = async () => {
  const name = $("newName").value.trim();
  if (!name) return;
  try {
    await send("POST", "/players", { name, style_id: $("newStyle").value || null });
    $("newName").value = "";
    await refreshAll();
  } catch (e) { say(e.message); }
};
$("logUndo").onclick = () => {
  const n = state.undo.pop() ?? 0;
  state.acts = state.acts.slice(0, state.acts.length - n); // an action and the passes recorded with it go together
  say("");
  afterTableChange();
};
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

addOpp(null);
refreshAll().catch(() => {});
// Native app (Capacitor): assets are local, a service worker would only risk serving stale files after an update.
if ("serviceWorker" in navigator && !window.POKER_NATIVE) navigator.serviceWorker.register("sw.js").catch(() => {});
