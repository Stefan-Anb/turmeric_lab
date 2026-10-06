# CLAUDE.md — Projektregeln für TurmericLab

Diese Datei ist für Claude-Instanzen, die in diesem Repo arbeiten. Für die
technische Tiefe (Algorithmen, Netzliste, bekannte Bugs, Architekturkonzepte)
siehe **[DOKUMENTATION.md](DOKUMENTATION.md)** — dort nicht duplizieren,
sondern verlinken/ergänzen.

## Nicht verhandelbare Regeln

1. **Kein `git commit` und kein `git push` ohne explizite Anweisung des Users
   in der jeweiligen Aufgabe.** Eine frühere Freigabe gilt nicht automatisch
   für die nächste Änderung — jedes Mal neu fragen bzw. abwarten, bis der User
   es verlangt. Das gilt auch für scheinbar triviale Änderungen (Doku, Typos).
2. **Claude/KI-Agenten nie als GitHub-Collaborator zum Repo hinzufügen** oder
   entsprechende Einladungen/Berechtigungen einrichten — unabhängig davon, ob
   ein Commit gerade ansteht oder nicht. Das ist getrennt von der
   Commit-Trailer-Konvention (`Co-Authored-By: ...`), die beim tatsächlichen
   Committen weiterhin gilt, sobald ein Commit explizit freigegeben wurde.
3. **`TODO.md` ist eine persönliche Notizdatei des Users, kein Auftrag an
   Claude.** Nicht als Arbeitsliste interpretieren oder unaufgefordert
   abarbeiten, nicht automatisch pflegen/umsortieren/abhaken. Nur anfassen,
   wenn der User explizit danach fragt.

## Projektüberblick

TurmericLab ist ein browserbasierter Schaltplaneditor mit SPICE-Netzliste und
NGSpice-WASM-Simulation. **Kein Build-Schritt, kein Framework, keine
npm-Dependencies** — alles läuft über klassische `<script>`-Tags direkt aus
`schematics.html`. Ladereihenfolge (wichtig, da alle Dateien sich einen
globalen Scope teilen):

```
js/components.js → js/schematic.js → js/netlist.js → js/app.js → js/simulation.js
  → js/power-analyzer-core.js → js/power-analyzer-ui.js → js/power-analyzer-sim.js
```

| Datei | Rolle |
|---|---|
| `js/schematic.js` | Datenmodell `S`, reine Geometrie-/Netz-Logik, kein DOM |
| `js/components.js` | Bauteilbibliothek `CD`, SVG-Zeichenhelfer, Mini-Markdown-Renderer |
| `js/netlist.js` | SPICE-Netzlistengenerierung |
| `js/app.js` | Rendering, Events, Tools, Undo, Copy/Paste, Import/Export, Persistenz |
| `js/simulation.js` | NGSpice-WASM-Anbindung, Plot (uPlot) |
| `js/power-analyzer-core.js` | Leistungsanalysator: Messkern, portabel (kein DOM, keine App-Globals) |
| `js/power-analyzer-ui.js` | Leistungsanalysator: Dialog, portabel (nur Core + Datenquellen-Interface) |
| `js/power-analyzer-sim.js` | Leistungsanalysator: Anbindung an Simulation/Probes (TurmericLab-Glue) |
| `js/power-analyzer-worker.js` | Leistungsanalysator: Web Worker für große Datensätze (nicht per `<script>` geladen) |
| `css/styles.css` | Styling (`css/power-analyzer.css` für den Analysator) |

Globaler Zustand statt Module/Klassen: `S` (Schaltplandaten), `CD`
(Bauteildefinitionen), `view`/`undoStack`/UI-States in `app.js`. Kapselung ist
rein konventionell — beim Ändern eines Namens in einer Datei prüfen, ob er in
einer anderen Datei als globaler Bezeichner erwartet wird.

## Lokal starten / testen

Kein Build nötig, aber **nicht per `file://` öffnen** — relative `<script
src>`-Pfade und manche Fetches funktionieren dann nicht zuverlässig. Stattdessen
den vorhandenen Dev-Server nutzen (cache-frei, `.claude/serve.py`):

```bash
python .claude/serve.py 8765
```

oder über die Preview-Tooling-Konfiguration `.claude/launch.json` (Eintrag
`"schematic"`, Port 8765). Automatisierte Tests gibt es nur für den Analysator-Kern
(`node poc/pa-core-test.js`, siehe DOKUMENTATION.md Kapitel 10), sonst erfolgt die Verifikation
erfolgt manuell im Browser (Platzieren, Selektieren, Ziehen, Undo/Redo,
Export/Import-Roundtrip, `NETLIST`-Button für die generierte Netzliste
prüfen).

## Kernkonventionen im Datenmodell

- **Raster:** alle Koordinaten sind Vielfache von `GRID = 20` (`snap()`).
  Konnektivität wird über exakte Koordinatengleichheit erkannt — krumme
  Werte brechen das.
- **Bauteil-Anker:** elektrische Bauteile in `CD` sind an ihrem **Zentrum**
  verankert (`x,y` = Mitte, Symbol relativ dazu gezeichnet, `hitW`/`hitH`
  zentriert). Die reinen UI-Elemente `blanket`/`image`/`note` sind bewusst an
  der **oberen linken Ecke** verankert (`x,y` = Ecke + explizites `w`/`h`) —
  vereinfacht die Resize-Mathematik. Siehe DOKUMENTATION.md Kapitel 7 für die
  Details und warum `compBBox()` beide Fälle kennen muss.
- **Neuer Bauteiltyp = ein `CD[type]`-Eintrag** (`lbl`, `val`/Default, `hitW`/`hitH`
  oder `w`/`h`, `props`, `pins`, `draw(g,v)`). Rein visuelle Elemente ohne
  Netzlistenrelevanz bekommen `pins:[]` und **keinen** `if(c.type==='...')`-Zweig
  in `netlist.js` — reicht, um sie aus der Simulation komplett herauszuhalten.
- **Properties-Panel ist generisch** über `def.props`: `type:'enum'` (Radios),
  `type:'bool'` (Checkbox), `type:'textarea'` (mehrzeilig), sonst
  Freitext-`<input>`. Alles läuft ohne Apply-Button live über
  `input`/`change`-Listener direkt auf `comp[key]`. Ein neues Property braucht
  in der Regel **keinen** Code in `renderProps()`, nur einen Eintrag in
  `CD[type].props`.
- **Undo/Redo, Speichern (`localStorage`), SVG-Export/Import** sind vollständig
  generisch über `S.components`/`S.wires`/`S.junctions` — ein neuer
  Komponententyp braucht dafür keine Anpassung, solange er sich sauber
  JSON-serialisieren lässt (keine Funktionen/DOM-Referenzen in `comp`-Feldern).

## Beim Ändern von app.js/components.js beachten

- `S.drag` ist eine State-Machine für **alle** Drag-Interaktionen (Komponente
  verschieben, Wire-Segment ziehen, Resize, Crop, Gruppen-Drag) — dispatcht in
  `onDragMove`/`onDragEnd` über `S.drag.target.type`. Ein neuer Drag-Typ ist
  ein neuer `if(S.drag.target.type==='...')`-Zweig dort, nicht ein eigener
  Mechanismus.
- Handles/Hooks (Resize, Crop, Pins) werden nur gerendert, wenn die Komponente
  selektiert ist, und **nach** `def.draw()` an die fertige `<g>` angehängt
  (siehe `renderComps()`), nie in `draw()` selbst — `draw()` kennt den
  Selektionszustand nicht.
- Bekannter Stolperstein: `e.preventDefault()` auf einem `keydown`-Handler für
  Ctrl+V unterdrückt in Chromium/Firefox das native `paste`-Event komplett.
  Clipboard-Verhalten (intern vs. OS-Bild) gehört daher in den
  `paste`-Event-Handler, nicht in `keydown`.
- Der globale `keydown`-Handler muss `INPUT` **und** `TEXTAREA` im
  Fokus-Guard ausschließen, sonst frisst `Backspace`/`Delete` beim Tippen in
  einem Properties-Feld versehentlich die selektierte Komponente.

## Sonstiges

- Lizenz: Apache 2.0.
- Deploy läuft über `.github/workflows/deploy-pages.yml` (GitHub Pages) — wird
  nicht durch lokale Änderungen ausgelöst, sondern erst nach Push auf `main`.
- `POC-ECHTZEIT-NGSPICE.md` und `.github/workflows/build-ngspice-wasm.yml`
  gehören zu einem separaten, noch nicht integrierten Experiment
  (WASM-Build mit Shared-API) — siehe TODO.md.
- `lib/`: Beispiel-/Default-Dateien für das Custom-Component-Feature. Kein
  Laufzeit-Build-Bestandteil, wird nur per `fetch()` vom Dev-Server geladen
  (daher `file://` auch hier ungeeignet). `lib/default_components.json` wird
  beim Start automatisch in die persistente Bauteilbibliothek eingelesen
  (`seedLibraryFromDefaults()` in js/app.js, nur fehlende Keys werden
  ergänzt); `lib/example_subckt.lib` ist ein Rohtext-SPICE-Subcircuit zum
  Testen des "Load file…"-Modell-Imports im Component-Editor. Siehe
  DOKUMENTATION.md Kapitel 8 für die Bibliothek-vs-Inline-Architektur.
