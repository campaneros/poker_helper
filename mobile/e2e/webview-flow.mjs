// End-to-end check of the real UI over the Chrome DevTools Protocol (Android WebView or desktop Chrome).
// Android:  adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>   (pid from /proc/net/unix)
// Desktop:  chrome --remote-debugging-port=9222 <url>
// Run: node mobile/e2e/webview-flow.mjs [port]      Exit code 1 if any check fails.
// The app keeps its data in localStorage, so run it on a fresh install (adb shell pm clear <package>).
const port = process.argv[2] ?? "9222";
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
// the app page only: a fresh Chrome profile also exposes internal chrome:// pages as targets
const page = targets.find((t) => t.type === "page" && /^https?:/.test(t.url));
if (!page) throw new Error("nessuna pagina trovata: controlla adb forward / la porta di debug");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
let nextId = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});

const MIN_TOUCH_PX = 44;
const inPage = `(async () => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const rect = (e) => e.getBoundingClientRect();
  const wait = (f, what) => new Promise((res, rej) => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (f()) { clearInterval(i); res(); }
      else if (Date.now() - t0 > 8000) { clearInterval(i); rej(new Error('timeout: ' + what)); }
    }, 30);
  });
  const pickCard = (code) => { $('.suit[data-suit="' + code[1] + '"]').click(); $('.ranks button[aria-label="' + code + '"]').click(); };
  const setValue = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const out = { checks: {} };
  const sent = { advise: [], hands: [] }; // what the UI really sends to the engine
  const realFetch = window.fetch;
  window.fetch = (u, i) => {
    if (i && typeof i.body === 'string' && /\\/advise$/.test(String(u))) sent.advise.push(JSON.parse(i.body));
    if (i && typeof i.body === 'string' && /\\/hands$/.test(String(u))) sent.hands.push(JSON.parse(i.body));
    return realFetch(u, i);
  };
  if ($$('#roster li').length !== 0) throw new Error('stato non pulito: ci sono gia ' + $$('#roster li').length + ' giocatori (usa un profilo/installazione nuovi)');

  // 1) layout: no horizontal overflow; every tappable picker/chip/card target is touch sized
  const root = document.documentElement;
  out.viewport = root.clientWidth;
  out.checks.noHorizontalOverflow = root.scrollWidth <= root.clientWidth;
  const small = () => $$('.suit, .ranks button, .chip, .slot.small')
    .filter((e) => rect(e).width < ${MIN_TOUCH_PX} || rect(e).height < ${MIN_TOUCH_PX})
    .map((e) => (e.getAttribute('aria-label') || e.className) + ' ' + Math.round(rect(e).width) + 'x' + Math.round(rect(e).height));
  out.smallTargets = small();
  out.checks.touchTargets = out.smallTargets.length === 0;

  // 2) cards: hero + flop via suit-then-rank; a used card becomes disabled
  ['Ah', 'Kh', '2h', '7h', 'Jc'].forEach(pickCard);
  out.slots = $$('#slots .slot').map((e) => e.textContent).join(' ');
  $('.suit[data-suit="h"]').click();
  out.checks.usedCardDisabled = $('.ranks button[aria-label="Ah"]').disabled === true;

  // 3) a saved player, a built-in style assigned to him, and a custom style created from the form
  $('#newName').value = 'E2E'; $('#newPlayer').click();
  await wait(() => $$('#roster li').length === 1, 'player in roster');
  setValue($('#roster li select'), 'builtin:fish');
  await wait(() => /loose-passivo/.test($('#roster li').textContent), 'style applied to the player');
  out.checks.styleAssigned = true;
  $('#styleName').value = 'Test'; $('#styleAdd').click();
  await wait(() => $$('#styleList li').some((li) => /Test/.test(li.textContent)), 'custom style listed');
  out.checks.customStyleCreated = true;

  // 4) put the saved player at the table next to the default opponent; show two cards of the first one; mark a dead card
  setValue($('#addSel'), $$('#addSel option')[1].value); $('#addOpp').click();
  await wait(() => $$('.opp').length === 2, 'two opponents');
  $$('.opp')[0].querySelector('.slot.small').click();
  pickCard('Kd'); pickCard('Kc');
  out.shown = $$('.opp')[0].querySelector('.known').textContent;
  out.checks.shownCardsSet = /K♦/.test(out.shown) && /K♣/.test(out.shown);
  $('#deadRow .chip.add').click(); pickCard('2s');
  out.checks.deadCardAdded = $$('#deadRow .chip:not(.add)').length === 1;
  $('.suit[data-suit="d"]').click();
  out.checks.shownCardLeavesPicker = $('.ranks button[aria-label="Kd"]').disabled === true;

  // 5) action log: raise by the saved player, fold marks him out, undo brings him back
  const savedUid = $$('#logWho option')[2].value;
  setValue($('#logWho'), savedUid); setValue($('#logAct'), 'raise'); $('#logAmt').value = '12'; $('#logAdd').click();
  out.checks.actionLogged = $$('#log li').length === 1 && /raise 12/.test($('#log li').textContent);
  setValue($('#logAct'), 'fold'); $('#logAdd').click();
  out.checks.foldMarksPlayerOut = $$('.opp')[1].classList.contains('folded');
  $('#logUndo').click();
  out.checks.undoRestoresPlayer = !$$('.opp')[1].classList.contains('folded') && $$('#log li').length === 1;
  setValue($('#logAct'), 'bet'); $('#logAmt').value = ''; $('#logAdd').click();
  out.checks.betNeedsAmount = /importo/i.test($('#notice').textContent) && $$('#log li').length === 1;

  // 6) advice: shown cards pin the hand, the log narrows the other opponent, bars are drawn
  $('#pot').value = 40; $('#toCall').value = 20; $('#stack').value = 300;
  $('#go').click();
  await wait(() => $('#result .big'), 'advice');
  const text = $('#result').innerText;
  out.advice = text.split('\\n').filter(Boolean).slice(0, 4).join(' | ');
  out.checks.adviceShown = /(RAISE|CALL|FOLD|CHECK|BET|ALL-IN)/.test(text) && /EQUITY \\d+\\.\\d%/.test(text);
  out.checks.barsRendered = $$('#result .bar i').some((i) => rect(i).width > 0) && rect($('#result .meter b')).width > 0;
  out.likely = $$('#result .opp-range').map((p) => p.textContent);
  out.checks.shownHandReported = out.likely.some((t) => /KK 100%/.test(t));
  out.checks.rangeShownForEachOpponent = out.likely.length === 2;
  const req = sent.advise[0];
  out.checks.adviceCarriesTableInfo = !!req && req.opponents[0].known?.length === 2 && req.opponents[1].actions?.length === 1
    && req.opponents[1].actions[0].type === 'raise' && req.dead?.length === 1;

  // 7) save the hand: the player's stats and history are updated
  $('#saveHand').click();
  await wait(() => /Mano salvata/.test($('#notice').textContent), 'hand saved');
  out.checks.handSaved = true;
  const saved = sent.hands[0];
  out.checks.savedHandIsComplete = !!saved && saved.actions.length === 1 && saved.actions[0].amount === 12
    && saved.players.length === 2 && saved.players[0].known.length === 2 && saved.board.length === 3 && saved.hero?.length === 2;
  out.checks.stateResetAfterSave = $$('#log li').length === 0 && $$('#deadRow .chip:not(.add)').length === 0
    && $$('#slots .slot').every((e) => e.textContent === '·');
  await wait(() => /1 mani/.test($('#roster li').textContent), 'player stats refreshed');
  out.checks.statsUpdated = true;
  $$('#roster li button').find((b) => b.textContent === 'Storico').click();
  await wait(() => $('#roster li .hand'), 'history shown');
  out.history = $('#roster li .hand').innerText.replace(/\\n+/g, ' | ');
  out.checks.historyShowsAction = /raise 12/.test(out.history) && /Preflop|Flop/.test(out.history);

  // 8) error path: asking for advice with no cards shows a message instead of crashing
  $('#go').click();
  await wait(() => $('#result .err'), 'error message');
  out.checks.missingCardsMessage = /due carte/i.test($('#result .err').textContent);
  return out;
})()`;

const res = await evaluate(inPage);
const failure = res.result?.exceptionDetails;
const value = res.result?.result?.value;
if (failure || !value?.checks) {
  console.error("ERRORE nella pagina:", failure?.exception?.description ?? JSON.stringify(res.result));
  process.exit(1);
}
console.log(JSON.stringify(value, null, 1));
ws.close();
const failed = Object.entries(value.checks).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length) { console.error(`FALLITI: ${failed.join(", ")}`); process.exit(1); }
console.log("TUTTI I CONTROLLI SUPERATI");
