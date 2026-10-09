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
  const typeInto2 = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
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
  const small = () => $$('.suit, .ranks button, .chip, .slot.small, #roster button')
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

  // 5) the table: first to act, a player skipped over, undo, a refused raise, then the real sequence
  out.checks.tableHintAsksFirst = /per primo/.test($('#tableHint').textContent) && $$('.seat').length === 3;
  out.checks.seatsAreTouchSized = $$('.seat').every((e) => rect(e).width >= ${MIN_TOUCH_PX} && rect(e).height >= ${MIN_TOUCH_PX});
  const seat = (k) => $('.seat[data-seat="' + k + '"]');
  const menuButton = (text) => $$('#seatMenu button').find((b) => b.textContent.trim().startsWith(text));
  seat('o1').click();
  menuButton('Parla per primo').click();
  const flags = (k) => seat(k).querySelector('.badges').textContent;
  out.checks.tableDerivesBlinds = /D/.test(flags('o1')) && /1°/.test(flags('o1')) && /SB/.test(flags('o2')) && /BB/.test(flags('hero'));
  out.checks.tableHintNamesNext = /Tocca a Avversario 1/.test($('#tableHint').textContent);
  seat('o2').click();
  menuButton('Fold').click();          // E2E folds although the first player has not acted: he is recorded as passing
  out.checks.skippedPlayerFolds = $$('.opp')[0].classList.contains('folded') && $$('#log li').length === 2 && /Passano prima di lui/.test($('#notice').textContent);
  $('#logUndo').click();               // the fold and the pass recorded with it go together
  out.checks.undoRestoresPlayer = !$$('.opp')[0].classList.contains('folded') && $$('#log li').length === 0;
  seat('o1').click();
  menuButton('Call').click();
  seat('o2').click();
  $('#seatAmount').value = '';
  $$('#seatMenu button').find((b) => b.textContent.trim() === 'Rilancia').click();
  out.checks.betNeedsAmount = /superare/.test($('#seatMenu .err').textContent) && $$('#log li').length === 1;
  $('#seatAmount').value = '12';
  $$('#seatMenu button').find((b) => b.textContent.trim() === 'Rilancia').click();
  out.log = $$('#log li').map((li) => li.textContent);
  out.checks.actionLogged = $$('#log li').length === 2 && /Avversario 1: call 2/.test(out.log[0]) && /E2E: raise 12 \\(piatto 5\\)/.test(out.log[1]);
  out.checks.tableFillsPotAndCall = $('#pot').value === '16' && $('#toCall').value === '10';
  out.checks.lastRaiseShown = /ultimo rilancio: E2E a 12/.test($('#table .felt').textContent);

  // 6) advice: shown cards pin the hand, the log narrows the other opponent, bars are drawn
  $('#stack').value = 300;
  $('#go').click();
  await wait(() => $('#result .big'), 'advice');
  const text = $('#result').innerText;
  out.advice = text.split('\\n').filter(Boolean).slice(0, 4).join(' | ');
  out.checks.adviceShown = /(RAISE|CALL|FOLD|CHECK|BET|ALL-IN)/.test(text) && /EQUITY \\d+\\.\\d%/.test(text);
  out.checks.barsRendered = $$('#result .bar i').some((i) => rect(i).width > 0) && rect($('#result .meter b')).width > 0;
  out.likely = $$('#result .opp-range').map((p) => p.textContent);
  out.checks.shownHandReported = out.likely.some((t) => /KK 100%/.test(t));
  out.checks.rangeShownForEachOpponent = out.likely.length === 2;
  const maps = $$('#result details.range-map');
  out.checks.rangeMapPerOpponent = maps.length === 2 && maps.every((m) => m.querySelectorAll('.cell').length === 169);
  const kk = maps[0].querySelector('.cell[data-hand="KK"]'), aa = maps[0].querySelector('.cell[data-hand="AA"]');
  out.checks.rangeMapPinsShownHand = kk.dataset.pct === '100' && aa.dataset.pct === '0'
    && maps[0].querySelectorAll('.cell.on').length === 1;
  maps[1].open = true;
  const cell = maps[1].querySelector('.cell[data-hand="AKs"]');
  cell.click();
  out.checks.rangeMapCellExplains = /AKs: .*% del range/.test(maps[1].querySelector('[aria-live]').textContent);
  out.checks.rangeMapFitsScreen = rect(maps[1].querySelector('.grid13')).width <= window.innerWidth;
  const req = sent.advise[0];
  out.checks.adviceCarriesTableInfo = !!req && req.opponents[0].known?.length === 2 && req.opponents[1].actions?.length === 1
    && req.opponents[1].actions[0].type === 'raise' && req.dead?.length === 1 && req.pot === 16 && req.to_call === 10;

  // 6b) a bet typed in chips instead of a pot fraction: pot 16 already holds the 8, so it was 8 into 8 = 1x
  setValue($$('.opp')[0].querySelector('select'), 'bet');
  typeInto2($$('.opp')[0].querySelector('input[aria-label="Importo della puntata in fiche"]'), '8');
  $('#result').replaceChildren();
  $('#go').click();
  await wait(() => $('#result .big'), 'advice with a typed bet');
  out.checks.typedBetReachesTheEngine = Math.abs(sent.advise[sent.advise.length - 1].opponents[0].bet_frac - 1) < 1e-9;

  // 7) save the hand: the player's stats and history are updated
  $('#saveHand').click();
  await wait(() => /Mano salvata/.test($('#notice').textContent), 'hand saved');
  out.checks.handSaved = true;
  const saved = sent.hands[0];
  out.checks.savedHandIsComplete = !!saved && saved.actions.length === 2 && saved.actions[1].amount === 12
    && saved.table?.seats.length === 3 && saved.table.first === 1 && saved.players.length === 2 && saved.players[0].known.length === 2 && saved.board.length === 3 && saved.hero?.length === 2;
  out.checks.stateResetAfterSave = $$('#log li').length === 0 && $$('#deadRow .chip:not(.add)').length === 0
    && $$('#slots .slot').every((e) => e.textContent === '·');
  await wait(() => /1 mani/.test($('#roster li').textContent), 'player stats refreshed');
  out.checks.statsUpdated = true;
  $$('#roster li button').find((b) => b.textContent === 'Storico').click();
  await wait(() => $('#roster li .hand'), 'history shown');
  out.history = $('#roster li .hand').innerText.replace(/\\n+/g, ' | ');
  out.checks.historyShowsAction = /raise 12/.test(out.history) && /Preflop|Flop/.test(out.history);

  // 7a) amend the saved hand: raise 12 -> 18; an edit the table refuses (check against a bet) is rejected; then fix it
  $$('#roster li button').find((b) => b.getAttribute('aria-label') === 'Modifica questa mano').click();
  await wait(() => $('#roster li .editor'), 'hand editor');
  const editorRows = () => $$('#roster li .editor .edit-action');
  const typeInto = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const saveEdit = () => $('#roster li .editor button[aria-label="Salva le modifiche alla mano"]').click();
  out.checks.editorShowsTheHand = editorRows().length === 2 && editorRows()[1].querySelector('input[aria-label="Importo"]').value === '12';
  typeInto(editorRows()[1].querySelector('input[aria-label="Importo"]'), '18');
  setValue(editorRows()[1].querySelector('select[aria-label$="tipo"]'), 'check');
  saveEdit();
  await wait(() => /check/.test($('#roster li .editor .err').textContent), 'impossible edit refused');
  out.checks.impossibleEditRefused = !$('#roster li .editor button[aria-label="Salva le modifiche alla mano"]').disabled;
  setValue(editorRows()[1].querySelector('select[aria-label$="tipo"]'), 'raise');
  saveEdit();
  await wait(() => /Mano modificata/.test($('#notice').textContent) && $('#roster li .hand:not(.editor)'), 'amended hand saved');
  out.amended = $('#roster li .hand').innerText.replace(/\\n+/g, ' | ');
  out.checks.amendShowsNewAmount = /raise 18/.test(out.amended) && !/raise 12/.test(out.amended);
  out.checks.amendKeepsOneHand = $$('#roster li .hand').length === 1 && /1 mani/.test($('#roster li').textContent);

  // 7a2) the history of whole hands: seating, every player's actions in order, final pot
  await wait(() => $$('#handLog li').length === 1 && $('#handLog .hand-card'), 'hand log');
  const card = $('#handLog .hand-card');
  card.open = true;
  out.handCard = card.innerText.replace(/\\n+/g, ' | ');
  out.checks.handLogShowsTheHand = /Posti: Tu \\(BB\\).*Avversario 1 \\(D\\).*E2E \\(SB\\)/.test(out.handCard)
    && /Preflop: Avversario 1 call 2 · E2E raise 18/.test(out.handCard) && /piatto 22/.test(out.handCard) && /Board: /.test(out.handCard);

  // 7b) heads-up short stack: the Nash push/fold block appears (small blind, 10 bb, aces); with two opponents it must not
  pickCard('Ah'); pickCard('As');
  $('#bb').value = 2; $('#pot').value = 3; $('#toCall').value = 1; $('#stack').value = 19;
  $('#result').replaceChildren();
  $('#go').click();
  await wait(() => $('#result .big'), 'advice with two opponents');
  out.checks.nashHiddenMultiway = !$('#result .nash');
  out.multiway = ($('#result .multiway') || {innerText: ''}).innerText.replace(/\\n+/g, ' | ');
  out.checks.multiwayShown = /SPINGERE CONVIENE/.test(out.multiway) && /AA/.test(out.multiway) && /9\.5 bb/.test(out.multiway)
    && /ALL-IN/.test($('#result .big').textContent) && /approssimata/.test($('#result').innerText);
  $$('.opp')[1].querySelector('header button').click();
  $('#result').replaceChildren();
  $('#go').click();
  await wait(() => $('#result .nash'), 'push/fold block heads-up');
  out.nash = $('#result .nash').innerText.replace(/\\n+/g, ' | ');
  out.checks.nashShownHeadsUp = /SPINGI ALL-IN/.test(out.nash) && /AA/.test(out.nash) && /10 bb/.test(out.nash);
  out.checks.mainAdviceIsNash = /ALL-IN/.test($('#result .big').textContent) && /Nash esatto/.test($('#result').innerText);
  $('#clearCards').click();

  // 7c) tournament: the ICM solution becomes the main advice, and the opponent can be picked from the stack list
  setValue($('#structure'), 'tournament');
  $('#tStacks').value = '20, 20, 10'; $('#tStacks').dispatchEvent(new Event('input', { bubbles: true }));
  $('#tPays').value = '1, 1, 0';
  const villainSelect = $$('.opp')[0].querySelector('select[aria-label^="Stack dell"]');
  out.checks.villainChoiceShown = !!villainSelect;
  setValue(villainSelect, '2'); // the 10-chip stack: the effective stack becomes 5 big blinds
  pickCard('Ah'); pickCard('As');
  $('#result').replaceChildren();
  $('#go').click();
  await wait(() => $('#result .nash'), 'ICM push/fold block');
  out.icm = $('#result .nash').innerText.replace(/\\n+/g, ' | ');
  out.checks.icmAdviceShown = /ALL-IN/.test($('#result .big').textContent) && /Nash con ICM/.test($('#result').innerText) && /tutti gli stack/.test(out.icm);
  out.checks.chosenOpponentReachesTheEngine = sent.advise[sent.advise.length - 1].tournament?.villain === 2 && /5 bb effettivi/.test(out.icm);
  setValue($('#structure'), 'no_limit');
  $('#clearCards').click();

  // 7d) a nickname for an opponent: it becomes a saved profile; renaming keeps the same one
  const nameInput = () => $$('.opp')[0].querySelector('input[aria-label="Nome del giocatore"]');
  const saveName = () => $$('.opp')[0].querySelector('.name-row button').click();
  const rosterBefore = $$('#roster li').length;
  typeInto(nameInput(), 'Il Dottore');
  saveName();
  await wait(() => $$('#roster li').length === rosterBefore + 1, 'nickname saved as a profile');
  out.checks.nicknameCreatesProfile = $('.opp header strong').textContent === 'Il Dottore' && $('.seat[data-seat="o1"] strong').textContent === 'Il Dottore';
  typeInto(nameInput(), 'Dottor Rossi');
  saveName();
  await wait(() => /Dottor Rossi/.test($('.opp header strong').textContent), 'renamed');
  out.checks.renameKeepsOneProfile = $$('#roster li').length === rosterBefore + 1 && !/Il Dottore/.test($('#roster').textContent);
  $('.seat[data-seat="o1"]').click();
  out.checks.seatMenuHasNameField = !!$('#seatMenu input[aria-label="Nome del giocatore"]') && $('#seatMenu input[aria-label="Nome del giocatore"]').value === 'Dottor Rossi';
  $('.seat[data-seat="o1"]').click();

  // 7e) the roster: a new player starts with a chosen style, and any player can be renamed from the list
  const rosterNow = $$('#roster li').length;
  setValue($('#newStyle'), 'builtin:nit');
  $('#newName').value = 'Tizio'; $('#newPlayer').click();
  await wait(() => $$('#roster li').length === rosterNow + 1, 'player created with a style');
  const tizio = () => $$('#roster li').find((li) => /Tizio/.test(li.textContent));
  out.checks.newPlayerStartsWithStyle = /Nit/.test(tizio().textContent) && /VPIP 15%/.test(tizio().textContent);
  tizio().querySelector('button[aria-label^="Rinomina"]').click();
  const renameInput = () => $('#roster input[data-name-input]');
  typeInto(renameInput(), 'E2E');
  [...$$('#roster .name-row button')].find((b) => b.textContent === 'Salva').click();
  await wait(() => /esiste già/.test($('#notice').textContent), 'duplicate name refused');
  out.checks.renameRefusesDuplicate = !!renameInput();
  typeInto(renameInput(), 'Caio');
  [...$$('#roster .name-row button')].find((b) => b.textContent === 'Salva').click();
  await wait(() => $$('#roster li').some((li) => /Caio/.test(li.textContent)) && !renameInput(), 'renamed from the roster');
  out.checks.renameFromRoster = !$$('#roster li').some((li) => /Tizio/.test(li.textContent)) && $$('#roster li').length === rosterNow + 1
    && /Nit/.test($$('#roster li').find((li) => /Caio/.test(li.textContent)).textContent);

  out.rosterSmall = $$('#roster button, #roster select').filter((e) => rect(e).width < ${MIN_TOUCH_PX} || rect(e).height < ${MIN_TOUCH_PX}).map((e) => (e.getAttribute('aria-label') || e.textContent) + ' ' + Math.round(rect(e).width) + 'x' + Math.round(rect(e).height));
  out.checks.rosterTargetsTouchSized = out.rosterSmall.length === 0 && root.scrollWidth <= root.clientWidth;

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
