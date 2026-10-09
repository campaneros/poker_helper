# Poker Advisor — app Android

L'app gira interamente sul telefono: motore (`../core`), rete neurale, archivio dei giocatori e delle mani.
Non chiede alcun permesso e non usa la rete.

## Costruire l'APK

```bash
source mobile/env.sh                 # JDK 21 + Android SDK (installati con Homebrew)
cd mobile
npm run android:release              # APK firmato -> android/app/build/outputs/apk/release/app-release.apk
npm run android:debug                # APK di test (debug remoto della WebView ACCESO, serve a e2e/)
e2e/check-apk.sh <apk> --release     # controllo di sicurezza: permessi, backup, componenti esposti, debug
```

Installazione sul telefono: `adb install -r dist/PokerAdvisor-1.0.apk`, oppure copia il file e aprilo
(serve consentire "installa app sconosciute" per il programma che lo apre).

## La chiave di firma

`android/release.keystore` + `android/keystore.properties` (permessi 600, esclusi dal repository).

- **Fai una copia di entrambi i file in un posto sicuro.** Senza la stessa chiave non puoi aggiornare l'app: Android
  rifiuta un APK firmato diversamente, e l'unica strada sarebbe disinstallare, **perdendo i giocatori e lo storico**.
- Chi ha la chiave può firmare aggiornamenti a tuo nome: non condividerla.

## Test

```bash
(cd ../core && npx vitest run)       # motore: parità con Python, range, storico, Nash, ICM, shove multiway, tavolo, suggerimenti   (164)
npx vitest run                       # archivio a eventi, guasti del registro, tavolo, nomi, stili, suggerimenti, rotte, storico, Nash, ICM, multiway (105)
node e2e/webview-flow.mjs 9222       # interfaccia completa nella WebView (vedi intestazione del file)
```

`e2e/webview-flow.mjs` richiede un'installazione nuova dell'app (`adb shell pm clear com.mcampana.pokeradvisor`) e una
build di test; con Chrome da desktop usa una porta di debug diversa per ogni esecuzione.

## Dati sul telefono

Registro a eventi in `localStorage` (`poker.events.v1`), un evento per riga con checksum: una riga danneggiata o
troncata fa perdere solo quell'evento (resta nel file ma viene ignorata). Se la memoria del telefono è piena la modifica viene rifiutata con un messaggio (errore 507) e il registro resta identico; salvare due volte la stessa mano non la duplica. Annulla, modifica ed eliminazione di una mano sono nuovi eventi, non
sovrascritture. I backup di Android sono disattivati (`allowBackup=false`): i dati non lasciano il telefono, ma
non si recuperano da un backup dopo una disinstallazione.
