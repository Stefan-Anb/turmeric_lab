# TurmericLab

**[Live-Demo auf GitHub Pages](https://stefan-anb.github.io/turmeric_lab/)**

TurmericLab ist ein browserbasierter Schaltplaneditor: Bauteile per Drag&Drop
platzieren, verdrahten, als SPICE-Netzliste exportieren und direkt im
Browser per NGSpice-WASM simulieren, ganz ohne Installation, Login oder
Server-Backend. Alles läuft lokal in deiner Browser-Registerkarte.

> Für den Codeaufbau, Algorithmen und interne Architekturentscheidungen siehe
> [DOKUMENTATION.md](DOKUMENTATION.md). Diese README ist eine
> Bedienungsanleitung.

## Inhalt

- [Was das Programm macht](#was-das-programm-macht)
- [Loslegen](#loslegen)
- [Bedienoberfläche](#bedienoberfläche)
- [Bauteile platzieren und verdrahten](#bauteile-platzieren-und-verdrahten)
- [Bauteilbibliothek](#bauteilbibliothek)
- [Eigene Bauteile (Custom Components)](#eigene-bauteile-custom-components)
- [Simulation](#simulation)
- [Netzliste](#netzliste)
- [Speichern, Laden, Exportieren](#speichern-laden-exportieren)
- [Tastaturkürzel](#tastaturkürzel)

## Was das Programm macht

- Schaltpläne zeichnen auf einem Raster mit klassischen Bauteilsymbolen
  (Widerstand, Kondensator, Diode, Transistor, Quellen, Op-Amp, Schalter, …).
- Automatische Erkennung von Netzen/Verbindungen anhand der Verdrahtung.
- Generierung einer SPICE-kompatiblen Netzliste aus dem Schaltplan.
- Simulation direkt im Browser über NGSpice, kompiliert nach WebAssembly
  (Transient-, AC-, DC-Sweep- und Arbeitspunkt-Analyse).
- Interaktives Plotten von Spannungen, Strömen und selbst definierten
  Formeln/Messungen.
- Import/Export als SVG (inklusive eingebetteter Schaltplandaten) sowie
  automatisches Zwischenspeichern im Browser (`localStorage`).

## Loslegen

Die einfachste Variante ist die [Live-Demo](https://stefan-anb.github.io/turmeric_lab/) — dort läuft alles direkt im
Browser, ohne Installation.

Für die lokale Entwicklung/Nutzung: Repo klonen und über einen lokalen
Webserver öffnen (nicht per Doppelklick/`file://`, da relative Skript-Pfade
sonst nicht zuverlässig laden):

```bash
python .claude/serve.py 8765
```

Anschließend `http://localhost:8765` im Browser öffnen.

## Bedienoberfläche

Die Oberfläche gliedert sich in vier Bereiche:

- **Toolbar (oben):** Werkzeugwahl (Select/Wire/Probe), Löschen, Alles
  löschen, Custom-Component-Verwaltung, Speichern/Laden (SVG), Netzliste
  anzeigen, Ansicht einpassen sowie Start/Stopp der Simulation.
- **Sidebar (links):** Bauteilpalette zum Platzieren per Klick oder Drag&Drop,
  gegliedert nach passiven/aktiven Bauteilen, Quellen, Sonstigem sowie
  reinen Zeichen-/Beschriftungselementen (Rahmen, Text, Notiz, Bild).
- **Zeichenfläche (Mitte):** der eigentliche Schaltplan auf einem Raster.
  Bei laufender/abgeschlossener Simulation öffnet sich darunter ein
  Plot-Bereich (Größe per Ziehen am Trenner anpassbar).
- **Eigenschaften-Panel (rechts):** zeigt und bearbeitet die Properties des
  aktuell ausgewählten Elements (Wert, Referenzbezeichner, Rotation,
  bauteilspezifische Parameter). Ohne Auswahl zeigt es stattdessen die
  Simulationseinstellungen.
- **Statusleiste (unten):** aktuelle Cursor-Position, Anzahl Bauteile/Leitungen
  sowie kontextabhängige Hinweise zum aktiven Werkzeug.

## Bauteile platzieren und verdrahten

1. Ein Bauteil in der Sidebar anklicken oder per Drag&Drop auf die
   Zeichenfläche ziehen. Der Editor wechselt in den Platzier-Modus; ein
   halbtransparentes Vorschausymbol folgt dem Cursor.
2. Mit Klick auf der Zeichenfläche wird das Bauteil gesetzt (einrastend auf
   das 20px-Raster). Während des Platzierens: `R` rotiert, `E` spiegelt das
   Vorschausymbol.
3. Mit dem **Wire**-Werkzeug (Symbol in der Toolbar oder Taste `W`) Leitungen
   zwischen Pins ziehen. Klicks setzen Zwischenpunkte, ein Klick auf einen
   anderen Pin/eine andere Leitung schließt die Verbindung ab, `Esc` bricht
   das Ziehen ab. Kreuzen sich Leitungen an einem Punkt, entsteht dort
   automatisch eine Verbindungsstelle (Junction), sobald tatsächlich
   elektrischer Kontakt besteht.
4. Im **Select**-Werkzeug (Taste `V` oder `Esc`) lassen sich Bauteile und
   Leitungen anklicken, per Rahmen mehrfach auswählen, verschieben (auch als
   Gruppe), rotieren (`R`), spiegeln (`E`) und löschen (`Entf`/`Backspace`).
   Ausgewählte Bauteile zeigen zusätzlich Anfasser zum Verschieben von
   Pins/Resize/Zuschneiden (je nach Bauteiltyp).
5. Mit dem **Probe**-Werkzeug (Taste `P`) auf einen Netz-Punkt oder ein
   Bauteil klicken, um dessen Spannung bzw. Strom testweise anzuzeigen bzw.
   für die Simulation vorzumerken (siehe [Simulation](#simulation)).
6. Rechtsklick öffnet bei den meisten Elementen ein Kontextmenü mit weiteren
   Optionen (z. B. Kopieren, Löschen, Rotieren).

Kopieren/Ausschneiden/Einfügen funktioniert wie gewohnt per `Strg+C` /
`Strg+X` / `Strg+V`, auch über mehrere Bauteile hinweg. `Strg+V` fügt
zusätzlich Bilder aus der Systemzwischenablage direkt als Bild-Element ein.

## Bauteilbibliothek

| Kategorie | Bauteile |
|---|---|
| Passiv | Widerstand, Kondensator, Spule, Transformator |
| Halbleiter | Diode, LED, Zenerdiode, Thyristor (SCR), NPN-/PNP-Transistor, N-MOSFET |
| Aktiv/Sonstiges | Operationsverstärker, Schalter, PWM-Generator |
| Quellen/Referenz | Spannungs-/Stromquelle, Masse (GND), Versorgung (VCC) |
| Netzlisten-Hilfen | Netz-Verbinder (benannter Netzknoten), Parameter (`.param`) |
| Zeichnen/Beschriften | Rahmen/Blanket, Textbeschriftung, Notiz (Markdown), Bild |

Eigenschaften jedes Bauteils (Referenzbezeichner, Wert, bauteilspezifische
Parameter wie z. B. Modell oder Frequenz) werden im Eigenschaften-Panel
rechts bearbeitet, sobald das Bauteil ausgewählt ist. Änderungen wirken
sofort, ein Bestätigen-Button ist nicht nötig.

Die reinen Zeichen-/Beschriftungselemente (Rahmen, Text, Notiz, Bild) haben
keine elektrische Funktion und tauchen nicht in der Netzliste auf, sie dienen
nur der Dokumentation innerhalb des Schaltplans.

## Eigene Bauteile (Custom Components)

Über den Toolbar-Button **CUSTOM** lässt sich ein eigener Bauteiltyp
anlegen: Name, Präfix für den Referenzbezeichner, beliebig viele Pins
(links/rechts), Beschreibung sowie ein zugehöriges SPICE-Subcircuit/Modell.
Eigene Bauteile erscheinen danach zusätzlich in der Sidebar, lassen sich
einzeln oder gesammelt als JSON exportieren und in ein anderes Projekt bzw.
mit anderen Nutzern teilen (Import über denselben Dialog).

## Simulation

Über den **SIMULATION**-Button in der Toolbar öffnen sich die
Simulationseinstellungen im Eigenschaften-Panel:

- **Analyseart:** Transient (`.tran`), AC-Sweep (`.ac`), DC-Sweep (`.dc`),
  Arbeitspunkt (`.op`) oder eine manuell eingegebene Direktive.
- **Signalauswahl:** einzelne Signale per Probe-Werkzeug markieren, oder über
  die Schnellauswahl alle Knotenspannungen bzw. alle verfügbaren Signale
  (inkl. Ströme) plotten.
- **Formeln:** eigene Ausdrücke über vorhandene Signale definieren (z. B.
  Leistungsberechnung).
- **Messungen:** automatisierte Messwerte aus dem Simulationsergebnis
  extrahieren (z. B. Anstiegszeit, Maximum, Mittelwert).

Mit **RUN** (Toolbar) wird die Simulation gestartet; das Ergebnis erscheint
als interaktiver Plot unterhalb der Zeichenfläche (Zoomen, Verschieben,
Anpassen der Achsen über die **FIT**/**FIT X**/**FIT Y**-Buttons). Das
generierte NGSpice-Log sowie die tatsächlich simulierte Netzliste lassen
sich über "NGSpice log / netlist" am unteren Rand des Einstellungsbereichs
einsehen, das ist besonders hilfreich bei Simulationsfehlern.

## Netzliste

Der Toolbar-Button **NETLIST** öffnet ein Fenster mit der aus dem Schaltplan
generierten SPICE-Netzliste, samt Button zum Kopieren in die Zwischenablage.
Nützlich, um die Netzliste in einem externen SPICE-Simulator
weiterzuverwenden oder das Verdrahtungsergebnis zu prüfen.

## Speichern, Laden, Exportieren

- Der Schaltplan wird laufend automatisch im Browser gespeichert
  (`localStorage`) und bleibt beim erneuten Öffnen der Seite erhalten
  (an dasselbe Gerät und denselben Browser gebunden).
- **SAVE** exportiert den Schaltplan als SVG-Datei. Die Datei ist ein
  gültiges, in jedem Vektorprogramm anzeigbares SVG *und* enthält
  eingebettet die vollständigen Schaltplandaten für den Re-Import.
- **LOAD** importiert eine zuvor mit **SAVE** exportierte SVG-Datei wieder
  vollständig editierbar.
- **CLEAR** löscht den gesamten aktuellen Schaltplan (mit Rückfrage).

## Tastaturkürzel

| Taste | Wirkung |
|---|---|
| `W` | Wire-Werkzeug (Leitung zeichnen) |
| `P` | Probe-Werkzeug (Signal markieren/anzeigen) |
| `V` / `Esc` | Zurück zum Select-Werkzeug, bricht laufende Aktion ab |
| `R` | Rotieren (Vorschau beim Platzieren, sonst Auswahl) |
| `E` | Spiegeln (Vorschau beim Platzieren, sonst Auswahl) |
| `Entf` / `Backspace` | Auswahl löschen |
| `Strg`+`C` | Auswahl kopieren |
| `Strg`+`X` | Auswahl ausschneiden |
| `Strg`+`V` | Einfügen (intern kopierte Elemente oder Bild aus Systemzwischenablage) |
| `Strg`+`Z` | Rückgängig |
| `Strg`+`Y` / `Strg`+`Shift`+`Z` | Wiederholen |

Tastaturkürzel sind deaktiviert, solange der Fokus in einem Text- oder
Eingabefeld liegt (z. B. beim Bearbeiten eines Eigenschaftswerts).

## Lizenz

Apache License 2.0, siehe [LICENSE](LICENSE).
