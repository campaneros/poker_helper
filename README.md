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
.venv/bin/python -m pytest -q        # Python: 53 test (banco di prova, vettori, server)
(cd core && npx vitest run)          # motore: 49 test
(cd mobile && npx vitest run)        # archivio e rotte: 59 test
.venv/bin/python -m bench.sim --hands 3000     # simulazione heads-up contro bot
.venv/bin/python -m bench.table --hands 6000   # simulazione a 3-6 giocatori
```

Se si cambia di proposito policy, pesi o equity: `python -m bench.export_golden` e `python -m bench.export_weights`.

## Cosa è dimostrato e cosa no

- Contro bot simulati l'advisor vince (heads-up e multiway), ma i bot sono semplici e inventati.
- Conoscere i profili degli avversari **non** ha dato un vantaggio misurabile sul banco di prova.
  Il suo valore reale si vedrà solo con mani vere registrate nell'app.
- Il consiglio è buono quanto la policy EV, un'euristica: non è una soluzione GTO.
- Non è stato misurato su un telefono reale (velocità e comodità dei tasti).

## Android

Costruire e installare l'APK: `mobile/README.md`. La chiave di firma non è nel repository e va custodita da chi
compila: senza di essa non si possono installare aggiornamenti sopra una versione già installata.
