# poker_helper

Consigliere di Texas Hold'em che gira interamente su un telefono Android, senza rete.
Cash No-Limit, Pot-Limit e torneo (ICM). Dato lo stato del tavolo dice cosa fare e quanto, con le probabilità
di ogni azione e la probabilità della mano finale. Tiene lo storico delle mani per giocatore, stili di gioco che
si adattano a ciò che gli avversari fanno davvero, e stima cosa possono avere a ogni azione.

## Struttura

| Cartella | Cosa contiene |
|---|---|
| `core/` | Il motore, in TypeScript: valutatore, equity Monte Carlo, range per giocatore, ICM, statistiche dallo storico, rete neurale. È ciò che gira sul telefono. |
| `mobile/` | L'app Android (Capacitor): archivio a eventi sul telefono, interfaccia, test end-to-end, controlli di sicurezza dell'APK. Vedi `mobile/README.md`. |
| `app/static/` | L'interfaccia (HTML/CSS/JS), condivisa dall'app e dal vecchio server. |
| `poker/`, `train.py` | Riferimento in Python: policy EV ("insegnante"), addestramento della rete, motore storico. Non gira sul telefono. |
| `bench/`, `tests/` | Banco di prova: partite simulate contro bot, vettori di riferimento (`tests/golden`), test Python. |
| `run.py`, `app/server.py` | Il vecchio server locale (non necessario per l'app). |

## Come si fida del risultato

Il motore TypeScript deve prendere **le stesse decisioni** del riferimento Python: `tests/golden/vectors.json`
congela comportamento, pesi della rete, ICM, ordinamento delle mani e arrotondamenti, e `core/test/golden.test.ts`
li confronta (stessa azione e stesso importo su ogni vettore; l'equity Monte Carlo entro l'errore statistico).
Le parti nate dopo (range, carte note, storico) si verificano contro enumerazione esatta e statistiche calcolate a mano.
I test sono controllati con mutazioni: rompere apposta il codice deve far fallire almeno un test.

```bash
.venv/bin/python -m pytest -q        # Python: 62 test (banco di prova, vettori, server, push/fold, Deep CFR)
(cd core && npx vitest run)          # motore: 147 test
(cd mobile && npx vitest run)        # archivio, guasti del registro, tavolo e rotte: 92 test
.venv/bin/python -m bench.sim --hands 3000     # simulazione heads-up contro bot
.venv/bin/python -m bench.table --hands 6000   # simulazione a 3-6 giocatori
```

Se si cambia di proposito policy, pesi o equity: `python -m bench.export_golden` e `python -m bench.export_weights`.
Le tabelle usate dall'app si rigenerano con `python -m bench.export_pushfold` e `python -m bench.export_equity169`.

## Deep CFR (heads-up, stack corti)

Obiettivo ridotto, come concordato: il gioco push/fold heads-up (lo small blind spinge o folda, il big blind chiama o folda).

| File | Cosa fa |
|---|---|
| `bench/equity_matrix.ts` | Equity all-in tra le 169 classi di mani, con le combinazioni esatte (card removal). Si esegue con il motore TypeScript. |
| `bench/pushfold.py` | Soluzione **esatta** (CFR+) per ogni stack da 2 a 25 bb. Sfruttabilità sotto 0,00001 bb: è il riferimento di verità. |
| `bench/deep_cfr.py` | Deep CFR con reti neurali (rimpianti e strategia media), confrontato con la soluzione esatta. |
| `core/src/table.ts` | **Il tavolo**: l'ordine dei giocatori e chi parla per primo prima del flop; da lì ricava bottone, bui, turni, strada di ogni azione, piatto, quanto devi chiamare e chi ha rilanciato per ultimo e di quanto. Tocchi un giocatore e dici cosa fa (fold, check, call, puntata o rilancio «a X» con scorciatoie ½ / ¾ / piatto, all-in). Se salti qualcuno, chi doveva parlare prima è segnato fold (check se non doveva nulla). La mano salvata porta con sé i posti e viene riprodotta dal motore a ogni salvataggio o correzione: turni, azioni e strade devono tornare. Gli stack non sono tracciati, quindi le side pot non sono divise (il totale del piatto è giusto). |
| `core/src/multiway.ts` | **Shove con 2 o più avversari** (preflop, fino a 15 bb, nessun rilancio prima di te): la rete non spinge mai in questi spot e nessuna soluzione li copre, quindi lo shove è valutato direttamente. Ogni avversario chiama con un range dedotto dalla larghezza del Nash heads-up a quella profondità, ristretto in base al numero di avversari e scalato dal suo VPIP; l'equity contro ogni possibile insieme di chiamanti viene da una sola passata Monte Carlo. È una **stima, non un equilibrio**, e l'interfaccia lo dice con l'EV in bb e il suo errore. In torneo il rischio è pesato col bubble factor. Non sono modellati side pot, azioni già fatte nella mano e posizioni a destra. L'all-in diventa il consiglio principale solo se il suo EV batte fold, call e rilanci della policy. |
| `bench/vs_teacher.py` | Confronta le decisioni dell'advisor con il Nash nello stesso spot. |
| `bench/export_pushfold.py`, `core/pushfold.json`, `core/src/pushfold.ts` | La soluzione esatta portata nell'app (63 KB): in heads-up, preflop, tra 2 e 25 bb, come small blind o come big blind contro un all-in, il consiglio principale **è** il Nash (SPINGI ALL-IN / CHIAMA / FOLD, con la sua probabilità) e la fonte è dichiarata. In torneo (stack e premi inseriti) lo stesso spot viene **risolto sul telefono con l'ICM** (`core/src/icmpushfold.ts`, circa 35 ms, matrice di equity `core/equity169.json` da 140 KB): il consiglio dice "Nash con ICM" e riporta quanto la soluzione dista da un equilibrio. Senza dati del torneo vale la tabella in chip. |

Cosa risulta (stack da 3 a 20 bb, anche profondità mai viste in addestramento):
- Il Deep CFR si avvicina al Nash ma non lo raggiunge: sfruttabilità media 0,03 bb contro 0,99 di "spingi e chiama sempre" (circa 3%),
  con range che differiscono di pochi punti percentuali. In un gioco così piccolo il metodo tabellare è esatto: il Deep CFR
  qui serve a convalidare la tecnica, non a fare meglio.
- Contro il Nash, come small blind a 4-20 bb, l'advisor **non folda mai** e dai 6 bb in su **non propone mai l'all-in**
  (le sue puntate arrivano a 1,5 volte il piatto). Non è per forza un errore, perché il gioco del Nash non permette di limpare,
  ma mostra che a stack corti manca una raccomandazione di spinta.
- I numeri tornano con le fonti: a 9 bb il big blind chiama circa il 42% secondo noi, 42,7% secondo
  [PokerStrategy](https://www.pokerstrategy.com/strategy/sit-and-go/1779/).

## Cosa è dimostrato e cosa no

- Contro bot simulati l'advisor vince (heads-up e multiway), ma i bot sono semplici e inventati.
- Conoscere i profili degli avversari **non** ha dato un vantaggio misurabile sul banco di prova.
  Il suo valore reale si vedrà solo con mani vere registrate nell'app.
- Il consiglio è buono quanto la policy EV, un'euristica: non è una soluzione GTO.
- Lo shove multiway è una stima: non esiste un riferimento esatto con cui confrontarlo. È controllato con casi a mano, con il calcolo indipendente dell'equity e con invarianti (non si allarga con più avversari né con stack più profondi), ma i range di chiamata sono un modello, non dati.
- Non è stato misurato su un telefono reale (velocità e comodità dei tasti). Sull'emulatore: shove multiway 80-300 ms, ICM heads-up circa 60 ms.

## Android

Costruire e installare l'APK: `mobile/README.md`. La chiave di firma non è nel repository e va custodita da chi
compila: senza di essa non si possono installare aggiornamenti sopra una versione già installata.
