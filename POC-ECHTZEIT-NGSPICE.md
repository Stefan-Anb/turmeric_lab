# Proof-of-Concept: Echtzeit-Eingriff in ngspice-WASM (Weg B)

> Stand: 2026-06-24. Dieses Dokument beschreibt einen umsetzbaren Plan, um in der
> WASM-Simulation **pro Zeitschritt** auf Vektoren zuzugreifen und eine
> Spannungsquelle in Echtzeit zu steuern. Es werden hier **keine** Code-Änderungen
> ausgeführt; die Umsetzung erfolgt nach menschlichem Review.

---

## 1. Ziel und Abgrenzung

**Ziel:** Eine durchgehende Transientensimulation, bei der

1. nach jedem akzeptierten Zeitschritt die aktuellen Vektorwerte ins UI
   gestreamt werden (Live-Plot), und
2. eine oder mehrere Spannungsquellen ihren Wert **pro Zeitschritt** aus einer
   JS-Callback-Funktion beziehen (z.B. ein Schieberegler, ein Funktionsgenerator
   oder ein Regelkreis im Browser).

**Warum Weg B und nicht die jetzige Engine:** Die eingebundene
`eecircuit-engine` baut ngspice als Standalone-Konsolen-Binary und liefert nur
ein fertiges Batch-Ergebnis (`out.raw`). Es gibt keinen Per-Zeitschritt-Hook.
Siehe [DOKUMENTATION.md](DOKUMENTATION.md) und die Analyse in
[js/simulation.js](js/simulation.js).

**Kernidee von Weg B:** ngspice mit der **Shared-Library-Schnittstelle**
(`--with-ngshared`) nach WASM bauen. Die Callbacks `SendData` (Datenstrom) und
`GetVSRCData` (externe Quelle) feuern **synchron aus der C-Laufschleife** und
brauchen **keinen** Hintergrund-Thread. Damit ist echtes Per-Zeitschritt-Verhalten
auch im single-threaded WASM erreichbar.

**Abgrenzung:** Das beliebige Ändern *anderer* Parameter (z.B. `alter R1=...`)
*während* eines durchgehenden Laufs braucht entweder Segmentierung
(`tran`/`alter`/`resume`) oder echte Threads (`bg_run` im Worker). Das ist
**nicht** Teil dieses PoC. Der PoC fokussiert auf die externe Quelle plus
Live-Daten, weil das die ursprüngliche Frage am direktesten beantwortet.

---

## 2. Die relevante ngspice-Shared-API

Quelle: <https://ngspice.sourceforge.io/shared.html>

### 2.1 Initialisierung und Datenstrom

```c
int ngSpice_Init(SendChar*, SendStat*, ControlledExit*,
                 SendData*, SendInitData*, BGThreadRunning*, void* userdata);
```

- `SendInitData(pvecinfoall, ident, userdata)`: einmal zu Beginn des Laufs,
  liefert Namen und Reihenfolge aller Ausgabevektoren.
- `SendData(pvecvaluesall, count, ident, userdata)`: **pro akzeptiertem
  Zeitschritt**, liefert die aktuellen Werte aller Vektoren (inkl. Zeit).
- `SendChar`: stdout/stderr von ngspice (Logzeilen).
- `ControlledExit`: ngspice signalisiert Abbruch/Quit.

### 2.2 Externe Quelle (der eigentliche Echtzeit-Eingriff)

```c
int ngSpice_Init_Sync(GetVSRCData*, GetISRCData*, GetSyncData*,
                      int* ident, void* userdata);
```

- Eine Spannungsquelle, die im Netlist mit dem Schlüsselwort `external`
  deklariert ist, ruft **pro Zeitschritt** `GetVSRCData(double* retvalue,
  double time, char* nodename, int ident, void* userdata)` auf.
- Der Callback schreibt den gewünschten Spannungswert nach `*retvalue`.
- Damit steuert JS den Quellwert in Abhängigkeit von Zeit **und** (falls
  gewünscht) von zuvor per `SendData` empfangenen Messwerten. Das ergibt sogar
  einen geschlossenen Regelkreis im Browser.

Netlist-Beispiel:

```spice
* externe Quelle: Wert kommt pro Zeitschritt aus dem JS-Callback
Vin in 0 dc 0 external
R1 in out 1k
C1 out 0 1u
.tran 10u 20m
```

### 2.3 Steuerkommandos

```c
int ngSpice_Command(char* command);   // z.B. "tran 10u 20m", "bg_halt", "alter ..."
pvector_info ngGet_Vec_Info(char* vecname);
char* ngSpice_CurPlot(void);
char** ngSpice_AllVecs(char* plotname);
```

`SendData` deckt den Live-Datenstrom bereits vollständig ab; `ngGet_Vec_Info`
ist optional für gezielte Einzelabfragen.

---

## 3. Build: ngspice als Shared-Lib nach WASM

Als Vorlage dienen der eelab-dev-Docker-Build, der
[ngspice WASM-Patch #96](https://sourceforge.net/p/ngspice/patches/96/) und
[wokwi/ngspice-wasm](https://github.com/wokwi/ngspice-wasm). Gegenüber dem
bestehenden Build sind nur zwei Dinge zu ändern: `--with-ngshared` statt
Standalone, und die Shared-API exportieren.

> **Empfohlener Weg: CI statt lokaler Docker.** Der Build läuft als GitHub
> Action ohne lokale Docker-Installation, siehe Abschnitt 8 und
> [.github/workflows/build-ngspice-wasm.yml](.github/workflows/build-ngspice-wasm.yml).
> Die folgenden Unterabschnitte erklären die einzelnen Schritte, die der
> Workflow ausführt.

### 3.1 configure

```sh
emconfigure ../configure \
  --with-ngshared \
  --disable-debug --disable-openmp --disable-xspice --disable-osdi \
  --without-x --with-readline=no
```

**Wichtig: `--enable-shared=no` NICHT setzen**, auch wenn das naheliegend
wirkt ("wir wollen doch nur ein statisches Archiv"). `--with-ngshared` trägt
intern selbst `-shared` in die `CFLAGS` **jeder** kompilierten Datei ein
(`configure.ac`: `AC_SUBST([STATIC], [-shared])`). Erzwingt man zusätzlich
`--enable-shared=no`, widersprechen sich beide Einstellungen: Libtool bricht
im Compile-Modus mit `"cannot build a shared library"` ab. Sichtbar wird davon
aber nur ein unabhängiger, echter Libtool-Tippfehler
(`func__fatal_error: command not found` statt `func_fatal_error`, siehe
[bug-libtool #23872](https://lists.gnu.org/archive/html/bug-libtool/2016-06/msg00001.html)),
der die eigentliche Fehlermeldung unlesbar macht. Das hat den ersten
CI-/Docker-Lauf dieses PoC tatsächlich blockiert, siehe Abschnitt 8.3.

Ohne `--enable-shared=no` kompiliert und linkt ngspice sauber durch, **jedoch
entsteht dabei kein `libngspice.a`**: ngspice deklariert für
`--with-ngshared` nur ein `LTLIBRARIES`-Ziel (die `.so`), keinen separaten
Archiv-Schritt. Das ist unten (3.2) entsprechend berücksichtigt.

### 3.2 emcc-Linkerflags

ngspice linkt mit `--with-ngshared` bereits selbst per `emcc -shared` zu einem
vollständigen WASM-Modul: `src/.libs/libngspice.so.X.Y.Z` (trotz `.so`-Endung
ein fertiges WASM-Binary, kein ELF). Das ist der Input für den eigenen
finalen `emcc`-Link, der die Shared-API-Funktionen gezielt exportiert und
`MODULARIZE`/`EXPORT_ES6` erzwingt:

```sh
emcc src/.libs/libngspice.so.X.Y.Z -O2 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s MODULARIZE=1 -s EXPORT_ES6=1 \
  -s ENVIRONMENT="web,worker" \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","addFunction","removeFunction","FS","UTF8ToString","stringToUTF8","getValue","setValue","HEAPF64"]' \
  -s EXPORTED_FUNCTIONS='["_ngSpice_Init","_ngSpice_Init_Sync","_ngSpice_Command","_ngSpice_Circ","_ngGet_Vec_Info","_ngSpice_CurPlot","_ngSpice_AllVecs","_ngSpice_running","_malloc","_free"]' \
  -o spice-shared.mjs
```

Wichtig:

- `ALLOW_TABLE_GROWTH=1` ist Pflicht, damit `addFunction` zur Laufzeit
  JS-Funktionspointer in die WASM-Tabelle eintragen kann (das sind die
  Callbacks).
- `ASYNCIFY` wird für diesen Foreground-PoC nicht benötigt (im verifizierten
  Build weggelassen). Nur nötig, falls man später Segmentierung/`bg`-Verhalten
  ergänzt.
- Kein `-pthread`. Der PoC ist absichtlich single-threaded.

### 3.3 Verifikation des Builds

**Tatsächlich durchgeführt und erfolgreich** (2026-08-12, ngspice-44.2,
Emscripten 3.1.61, lokal via Docker): Compile, Link und ein funktionaler
Node-Smoketest (echte `.op`-Analyse über `ngSpice_Command("run")`) liefen
durch. `ngSpice_Init` gab `rc=0` zurück, das ngspice-Log zeigte
`Circuit: * test`, `Doing analysis at TEMP = ...`, `No. of Data Rows : 1`
ohne Fatal Error.

Zum Nachprüfen in der Browser-Konsole nach `const m = await Module()`:

```js
typeof m._ngSpice_Init      // "function"
typeof m._ngSpice_Init_Sync // "function"
typeof m.addFunction        // "function"
```

> **Node-Besonderheit:** Ein Smoketest per `node -e` (statt Browser) muss den
> WASM-Bytecode explizit als `wasmBinary`-Option übergeben. Das Modul ist mit
> `ENVIRONMENT="web,worker"` gebaut (kein `"node"`), daher lädt der Glue-Code
> das `.wasm` normalerweise per `fetch()` — und Node implementiert `fetch()`
> für `file://`-URLs nicht. Betrifft nur Node-seitige Tests, nicht den
> eigentlichen Browser-Einsatz:
> ```js
> const wasmBinary = fs.readFileSync('./spice-shared.wasm');
> const m = await factory({ wasmBinary });
> ```

---

## 4. JS-Bindings (das Herzstück)

Datei-Vorschlag: `js/ngspice-rt.js` (neu), parallel zur bestehenden
[js/simulation.js](js/simulation.js). So bleibt der Batch-Pfad unangetastet und
der Echtzeit-Pfad ist klar getrennt.

### 4.1 Callback-Signaturen für `addFunction`

Emscripten-Signaturkürzel: `i`=int32, `d`=double, `p`/`i`=Pointer.

| C-Callback | addFunction-Signatur | Zweck |
|------------|----------------------|-------|
| `SendChar(char*, int, void*)` | `"iiii"` | Logausgabe |
| `SendInitData(pvecinfoall, int, void*)` | `"iiii"` | Vektornamen einlesen |
| `SendData(pvecvaluesall, int, int, void*)` | `"iiiii"` | Werte pro Zeitschritt |
| `ControlledExit(int, bool, bool, int, void*)` | `"iiiiii"` | Abbruchbehandlung |
| `GetVSRCData(double*, double, char*, int, void*)` | `"ipdiii"` | Quellwert liefern |
| `BGThreadRunning(bool, int, void*)` | `"iiii"` | Status (im PoC ungenutzt) |

> Die exakten Structlayouts (`vecvaluesall`, `vecvalues`, `vecinfo`) stehen im
> ngspice-Header `sharedspice.h`. Beim Parsen der Pointer mit `getValue(ptr,
> 'double')` bzw. `getValue(ptr, 'i32')` arbeiten und die Offsets aus dem Header
> ableiten. Das ist der fummeligste, aber gut dokumentierte Teil.
>
> **Verifiziert (2026-08-12, Browser-Test von [poc/ngspice-rt-poc.html](poc/ngspice-rt-poc.html)):**
> Die Vektornamen in `vecvalues.name` sind **nackte Knotennamen**
> (`"in"`, `"out"`, `"time"`, `"vin#branch"`), **nicht** `"v(in)"`/`"v(out)"`.
> Die `V(...)`-Schreibweise ist nur eine Anzeigekonvention von `print`/`plot`
> bzw. der `.raw`-Datei, keine interne Vektorbezeichnung. Beim Zugriff auf
> `row[...]` entsprechend die bloßen Namen verwenden.

### 4.2 Ablaufskizze

```js
// 1) Modul laden
const Module = (await import('./spice-shared.mjs')).default;
const m = await Module();

// 2) Datenstrom-Callback: pro Zeitschritt
const onSendData = m.addFunction((pvals, count, ident, user) => {
  // pvals -> vecvaluesall { veccount, vecindex, vecsa[] }
  // vecsa[i] = { name, creal, cimag, is_scale, is_complex }
  // Werte auslesen und an den Live-Plot pushen
  pushLivePoint(parseVecValues(m, pvals));
  return 0;
}, 'iiiii');

// 3) Externe Quelle: pro Zeitschritt Wert liefern
const onGetVSRC = m.addFunction((retPtr, time, nodeNamePtr, ident, user) => {
  const name = m.UTF8ToString(nodeNamePtr);
  const value = sourceController(name, time);   // <-- hier kommt der UI-Wert rein
  m.setValue(retPtr, value, 'double');
  return 0;
}, 'ipdiii');

// 4) Init + Sync registrieren
m.ccall('ngSpice_Init', 'number',
  ['number','number','number','number','number','number','number'],
  [onSendChar, 0, onControlledExit, onSendData, onSendInitData, 0, 0]);

m.ccall('ngSpice_Init_Sync', 'number',
  ['number','number','number','number','number'],
  [onGetVSRC, 0, 0, 0, 0]);

// 5) Netlist laden (Zeilen-Array, NULL-terminiert) und starten
loadCircuit(m, netlistLines);          // ngSpice_Circ
m.ccall('ngSpice_Command', 'number', ['string'], ['tran 10u 20m']);
// -> SendData feuert nun pro Zeitschritt, GetVSRC liefert den Quellwert
```

`sourceController(name, time)` ist die UI-Brücke: Sie liest z.B. den aktuellen
Schiebereglerwert, eine Funktion `f(time)` oder einen Regelausgang, der auf den
letzten `SendData`-Messwerten basiert.

### 4.3 Live-Plot

Der bestehende uPlot-Code in [js/simulation.js](js/simulation.js) plottet ein
komplettes Ergebnisarray. Für den Stream:

- einen Ringpuffer pro Vektor halten und in `pushLivePoint` anhängen,
- `simPlot.setData(...)` gedrosselt aufrufen (z.B. via
  `requestAnimationFrame`, nicht bei jedem Zeitschritt), sonst wird das UI vom
  Callback-Takt überrollt.

---

## 5. Reentrancy und Fallstricke

- **Nicht** aus `SendData` heraus `ngSpice_Command` aufrufen. Mess- und
  Steuerlogik im Callback halten, schwergewichtige Kommandos nur zwischen Läufen.
- **Foreground-Blockade:** `ngSpice_Command("tran ...")` kehrt erst **nach**
  dem kompletten Lauf zurück. Die Echtzeit passiert *innerhalb* via Callbacks;
  das UI-Hauptthread ist während des Laufs blockiert. Für lange Läufe daher
  besser in einem **Web Worker** ausführen (Modul ist mit
  `ENVIRONMENT="web,worker"` gebaut). UI-Werte gehen dann per `postMessage`
  bzw. `SharedArrayBuffer` an den `sourceController`.
- **String-Lebensdauer:** Mit `ccall`/`cwrap` und Typ `'string'` kümmert sich
  Emscripten um temporäre Buffer. Bei manuellem `stringToUTF8` selbst `_malloc`
  und `_free`.
- **addFunction-Leaks:** Pointer am Ende mit `removeFunction` freigeben, wenn
  die Engine neu initialisiert wird.
- **Structoffsets:** Hauptfehlerquelle. Gegen `sharedspice.h` der **exakt**
  gebauten ngspice-Version verifizieren, nicht gegen die Onlinedoku raten.

---

## 6. Meilensteine

1. **M1 Build:** ✅ Erledigt und verifiziert (2026-08-12, lokal via Docker,
   Abschnitt 3.3/8.3). Shared-Lib-WASM per GitHub Action oder
   [poc/build-ngspice-wasm.ps1](poc/build-ngspice-wasm.ps1) erzeugen, Artefakt
   nach `poc/wasm-out/` bzw. `js/`.
2. **M2 Smoke-Test:** `ngSpice_Init` + `SendChar` + simple `.op`/`tran` ohne
   externe Quelle. Logzeilen erscheinen in JS. Beweist, dass Callbacks feuern.
3. **M3 Datenstrom:** `SendInitData`/`SendData` parsen, Werte in die Konsole
   loggen. Beweist Per-Zeitschritt-Zugriff. **Das ist der Kernbeweis.**
4. **M4 Externe Quelle:** Netlist mit `Vin ... external`, `GetVSRCData`
   liefert `sin`/Rampe, im Plot sichtbar. Beweist Echtzeit-Eingriff.
5. **M5 UI-Kopplung:** Schieberegler -> `sourceController`, Live-Plot via
   Ringpuffer. End-to-End-Demo.
6. **M6 (optional):** Worker-Auslagerung gegen UI-Blockade.

M1 bis M4 sind der eigentliche PoC. M5/M6 sind Integration.

---

## 7. Aufwandseinschätzung

| Block | Aufwand |
|-------|---------|
| Build (M1) | 0,5 bis 1 Tag, wenn der eelab-dev-Docker-Build als Basis dient |
| Bindings + Structparsing (M2 bis M4) | 1 bis 2 Tage, dominiert vom Structlayout |
| UI/Live-Plot (M5) | 0,5 bis 1 Tag |
| Worker (M6) | 1 Tag, optional |

Gesamt für einen belastbaren PoC (M1 bis M5): grob 3 bis 4 Tage.

---

## 8. CI-Build via GitHub Actions

Damit kein lokaler Docker nötig ist, läuft der Build als GitHub Action:
[.github/workflows/build-ngspice-wasm.yml](.github/workflows/build-ngspice-wasm.yml).

### 8.1 Was der Workflow tut

1. **Trigger:** manuell über `workflow_dispatch` (mit Eingabefeldern für
   ngspice-Tag und Emscripten-Version) und automatisch bei Änderung der
   Workflow-Datei selbst.
2. **Prerequisites:** `autoconf automake libtool bison flex gperf` per apt.
3. **Emscripten:** via `mymindstorm/setup-emsdk` (inkl. Cache), gepinnte
   Version.
4. **Quelle:** `git clone` des Mirrors `danchitnis/ngspice-sf-mirror` auf den
   gewählten Tag (Standard: `ngspice-44.2`).
5. **configure:** `--with-ngshared` (ohne `--enable-shared=no`, Abschnitt 3.1).
6. **make:** `emmake make` linkt ngspice selbst per `emcc -shared` zu
   `src/.libs/libngspice.so.X.Y.Z` (ein fertiges WASM-Binary).
7. **Link:** separater `emcc`-Aufruf mit den Shared-API-Exporten
   (Abschnitt 3.2) erzeugt `spice-shared.mjs` + `.wasm`.
8. **Smoke-Check:** lädt das Modul in Node (mit `wasmBinary`-Übergabe, siehe
   3.3) und lässt eine echte `.op`-Analyse durchlaufen.
9. **Artifact:** `ngspice-wasm-shared` (enthält `wasm-out/`).

### 8.2 Bedienung

- In GitHub unter **Actions → Build ngspice WASM (shared API) → Run workflow**
  starten, optional Tag/Emscripten-Version überschreiben.
- Nach dem Lauf das Artifact `ngspice-wasm-shared` herunterladen und die beiden
  Dateien nach `js/` (oder einen `vendor/`-Ordner) legen. Die Bindings aus
  Abschnitt 4 importieren dann `spice-shared.mjs`.

### 8.3 Erwartbare Iterationspunkte

Die Kombination `ngspice-44.2` + Emscripten `3.1.61` + die hier dokumentierte
`configure`-Zeile ist **verifiziert** (2026-08-12, lokal via Docker):
Compile, Link und eine echte `.op`-Analyse laufen erfolgreich durch. Auf dem
Weg dahin trat ein konkreter, gelöster Fehler auf, der dokumentiert bleibt,
weil er bei anderen ngspice-/Emscripten-Versionen wieder auftreten kann:

- **Gelöst — `--enable-shared=no` widerspricht `--with-ngshared`:** Der
  erste Versuch scheiterte mit
  `../../libtool: line 2711: func__fatal_error: command not found` beim
  Kompilieren einfachster Dateien (z.B. `mktemp.lo`). Ursache:
  `--with-ngshared` trägt selbst `-shared` in die `CFLAGS` jeder Datei ein;
  in Kombination mit `--enable-shared=no` bricht Libtool im Compile-Modus mit
  `"cannot build a shared library"` ab, sichtbar nur als der besagte
  Libtool-Tippfehler (echter, unabhängiger Bug, siehe
  [bug-libtool #23872](https://lists.gnu.org/archive/html/bug-libtool/2016-06/msg00001.html)).
  **Fix:** `--enable-shared=no`/`--enable-static=yes` ersatzlos weglassen
  (siehe Abschnitt 3.1). Bereits in Dockerfile, PowerShell-Script und diesem
  Workflow umgesetzt.
- **ngspice-Version:** Nicht jeder Tag baut zwangsläufig identisch sauber
  unter emscripten. Falls ein anderer Tag als `ngspice-44.2` zickt, zuerst
  prüfen, ob derselbe Libtool-Fehler auftritt (dann greift derselbe Fix),
  sonst ältere Tags oder `pre-master-*`-Branches des Mirrors probieren.
- **Emscripten-Version:** `addFunction`/`ALLOW_TABLE_GROWTH`-Verhalten
  variiert zwischen emsdk-Versionen; `3.1.61` ist verifiziert.
- **Node-Smoketest:** Schlägt der Smoke-Check mit `TypeError: fetch failed` /
  `not implemented... yet...` fehl, fehlt die `wasmBinary`-Übergabe
  (Abschnitt 3.3) — kein Problem des WASM-Moduls selbst.

> **Hinweis:** Der Workflow erzeugt nur das WASM-Modul; er wird **nicht**
> automatisch gepusht oder deployt. Das Einbinden ins Projekt (Dateien nach
> `js/` kopieren, committen) bleibt ein bewusster, manueller Schritt.

### 8.4 Alternative: lokaler Build via Docker

Für schnelle Iteration ohne GitHub-Actions-Lauf abzuwarten, spiegelt
[poc/Dockerfile.ngspice-wasm](poc/Dockerfile.ngspice-wasm) exakt dieselben
Schritte lokal:

```powershell
./poc/build-ngspice-wasm.ps1
```

Optionale Parameter: `-NgspiceRef <tag>`, `-EmsdkVersion <version>`,
`-NoCache`. Das Script baut das Image, extrahiert die Artefakte per
`docker create` + `docker cp` und legt `spice-shared.mjs`/`.wasm` direkt neben
[poc/ngspice-rt-poc.html](poc/ngspice-rt-poc.html) ab. Voraussetzung: Docker
Desktop läuft. Die Iterationspunkte aus 8.3 gelten hier identisch.

---

## 9. Referenzen

- ngspice Shared library: <https://ngspice.sourceforge.io/shared.html>
- ngspice WASM-Patch #96: <https://sourceforge.net/p/ngspice/patches/96/>
- wokwi/ngspice-wasm: <https://github.com/wokwi/ngspice-wasm>
- eelab-dev/EEcircuit-engine (Build-Vorlage): <https://github.com/eelab-dev/EEcircuit-engine>
- Emscripten `addFunction`/`ccall`: <https://emscripten.org/docs/api_reference/preamble.js.html>
