# SchematicForge: Code-Review und technische Dokumentation

> Stand: 2026-06-22. Diese Datei dokumentiert die Codebasis, die verwendeten
> mathematisch-algorithmischen Prinzipien, gefundene Inkonsistenzen sowie
> Konzepte für eine generische Netzlistengenerierung und die Einbindung von
> NGSpice-WASM. Es werden in diesem Dokument **keine** Code-Änderungen
> ausgeführt; die Umsetzung erfolgt nach menschlichem Review.

---

## 1. Überblick und Architektur

SchematicForge ist ein reiner Browser-Schaltplaneditor ohne Build-Schritt und
ohne externe Abhängigkeiten. Eingebunden wird alles statisch über
[schematics.html](schematics.html).

| Datei | Zeilen | Rolle |
|-------|-------:|-------|
| [js/schematic.js](js/schematic.js) | ~181 | Datenmodell `S`, reine Geometrie- und Netz-Logik (kein DOM) |
| [js/components.js](js/components.js) | ~335 | Bauteilbibliothek `CD`, SVG-Zeichenhelfer, Custom-Components |
| [js/netlist.js](js/netlist.js) | ~326 | SPICE-Netzlistengenerierung |
| [js/app.js](js/app.js) | ~2147 | Rendering, Eventhandling, Tools (Wire, Probe, Select), Undo, Copy/Paste, Import/Export, Persistenz |
| [css/styles.css](css/styles.css) | - | Darstellung |

**Ladeordnung** (relevant, da globale Variablen geteilt werden):
`components.js` → `schematic.js` → `netlist.js` → `app.js`.

**Globaler Zustand.** Alles hängt an drei Modulglobalen:

- `S` (in `schematic.js`): das gesamte Schaltplan-Datenmodell.
- `CD` (in `components.js`): die Bauteildefinitionen (Component Definitions).
- `view`, `undoStack`, diverse UI-States (in `app.js`).

Es gibt keine Kapselung über Module/Klassen; die Trennung erfolgt rein
konventionell ("kein DOM in schematic.js"). Das ist für die Projektgröße
vertretbar, erschwert aber Tests.

### 1.1 Datenmodell

```text
S.components[]  = { id, type, x, y, label, value, rot, mirror, props, ...modeParams }
S.wires[]       = { id, points:[{x,y}...], from, to, net?, showLabel? }
S.junctions[]   = { id, x, y, wires:[wireId...] }
```

- `from`/`to` einer Wire referenzieren einen Anschluss:
  `{type:'pin',compId,pinIdx}` oder `{type:'junction',id}` oder `null` (offenes Ende).
- Koordinaten sind immer Vielfache von `GRID = 20`.
- Ein "Netz" ist nicht explizit gespeichert, sondern wird bei Bedarf per
  Graphtraversierung über verbundene Wires/Junctions/Pins **abgeleitet**
  (siehe Abschnitt 2.5). Lediglich ein optionaler Netzname `wire.net` wird
  persistiert.

Eine Bauteildefinition in `CD`:

```js
resistor:{
  lbl:'R', val:'1k', hitW:100, hitH:40,
  props:{ label:{l:'Reference'}, value:{l:'Value'} },
  pins:[{x:-40,y:0,n:'A'},{x:40,y:0,n:'B'}],
  draw(g,v){ /* SVG zeichnen relativ zu (0,0) */ }
}
```

---

## 2. Mathematisch-algorithmische Prinzipien

### 2.1 Grid-Snapping

`snap(v) = round(v / GRID) * GRID` ([schematic.js:21](js/schematic.js)).
Rundet jede Koordinate auf das nächste Rastervielfache. Garantiert, dass Pins,
Wire-Endpunkte und Junctions exakt aufeinanderfallen, was den
Gleichheitsvergleich `x===y` als Konnektivitätskriterium überhaupt erst
zuverlässig macht.

### 2.2 Pin-Transformation: Rotation und Spiegelung

`xfPin(px,py,rot,mir)` ([schematic.js:33](js/schematic.js)) bildet eine
bauteillokale Pinkoordinate auf den Weltversatz ab:

```
wenn mir:  px → -px            (Spiegelung an der y-Achse)
r = rot·π/180
c = round(cos r),  s = round(sin r)
x' = px·c - py·s
y' = px·s + py·c
```

Das ist die Standard-2D-Drehmatrix

```
[ x' ]   [ cos r   -sin r ] [ px ]
[ y' ] = [ sin r    cos r ] [ py ]
```

kombiniert mit einer vorgeschalteten Spiegelung `diag(-1, 1)`.

**Wichtiger Trick:** `cos`/`sin` werden gerundet. Da nur Vielfache von 90 Grad
auftreten, liefert die Rundung exakt `{-1, 0, 1}` und vermeidet
Gleitkomma-Drift (z. B. `cos(90°)=6.12e-17`). Dadurch bleiben transformierte
Pins exakt auf dem Raster. Die Reihenfolge (erst Spiegeln, dann Drehen) muss mit
der SVG-Render-Transform in `renderComps` (`rotate` dann `scale(-1,1)`)
konsistent sein, was sie aktuell ist.

### 2.3 Orthogonales Routing (Manhattan-Wires)

`ortho(p1,p2)` ([schematic.js:45](js/schematic.js)) erzeugt aus zwei Punkten
einen rechtwinkligen Pfad: liegen sie bereits achsengleich, direkte Strecke;
sonst ein Zwischenpunkt `{x:p2.x, y:p1.y}` (L-förmig). `buildWirePath`
verkettet mehrere Wegpunkte und respektiert optional eine bevorzugte
Startrichtung (`startDir` 'h'/'v'), die aus der Pin-Geometrie abgeleitet wird
(`|tp.x| > |tp.y| → horizontal`).

### 2.4 Pfadvereinfachung (Kollineare-Punkte-Elimination)

`simplifyPath(pts)` ([schematic.js:49](js/schematic.js)) entfernt
- Duplikatpunkte und
- mittlere Punkte dreier kollinearer, achsenparalleler Punkte
  (`prev.y===cur.y===next.y` oder `prev.x===cur.x===next.x`).

Das hält Polylinien minimal und verhindert "Geisterknicke". Algorithmisch ist
es ein linearer Durchlauf mit Lookahead, O(n).

### 2.5 Netz-Konnektivität als Graphtraversierung

Das Herzstück. Ein Netz ist die Zusammenhangskomponente eines Graphen, dessen
Knoten Wire-Enden/Junctions/Pins und dessen Kanten geometrische Inzidenzen
sind. Zwei Funktionen implementieren eine Breitensuche (BFS):

- `getNetWires(startId)` ([schematic.js:156](js/schematic.js)): sammelt alle
  Wires desselben Netzes über (a) gemeinsame Endpunkte und (b) Junctions.
- `findAllConnectedWires(startId)` ([schematic.js:115](js/schematic.js)):
  reichhaltigere Variante, die zusätzlich **T-Verbindungen** berücksichtigt,
  bei denen ein Wire-Ende mitten auf einem Segment eines anderen Wire liegt
  (`pointOnSeg`).

`pointOnSeg(p,a,b)` ([schematic.js:106](js/schematic.js)) ist ein
spezialisierter Punkt-auf-Strecke-Test, der nur achsenparallele Segmente
behandelt (Bounding-Box-Vergleich auf der relevanten Achse). Für nicht
orthogonale Segmente liefert er `false`, was bei diesem Editor (nur Manhattan)
ausreichend ist.

### 2.6 Netz-Bereinigung `cleanupNet`

`cleanupNet(startWireId)` ([schematic.js:121](js/schematic.js)) ist der
komplexeste Algorithmus. Nach jeder Wire-Änderung wird das betroffene Netz
komplett neu aufgebaut. Pipeline:

1. **Sammeln:** alle Segmente des Netzes als Linienliste `{p1,p2}` extrahieren;
   altes Netz (Wires + Junctions) löschen.
2. **Entrümpeln:** Nullstrecken und exakte Duplikate (auch
   richtungsverdreht) entfernen.
3. **Kollineares Verschmelzen:** Zwei kollineare Segmente mit gemeinsamem
   Endpunkt werden zu einem zusammengefasst, sofern an diesem Punkt kein
   weiteres Segment und kein Pin hängt (Greedy-Schleife bis Fixpunkt).
4. **Subset-Entfernung:** Segmente, die vollständig in einem anderen liegen,
   werden verworfen.
5. **T-Aufspaltung:** Endet ein Segment mitten auf einem anderen, wird letzteres
   gesplittet und der Punkt als Junction-Kandidat vermerkt.
6. **Knotengrad-Analyse:** Punkte mit Grad >= 3 werden zu Junctions.
7. **Polylinien-Rekonstruktion:** Aus der Liniensuppe werden über eine
   Adjazenzliste maximale Ketten gebildet. Ein Punkt ist ein "Break" (Kettenende),
   wenn er Junction ist, Grad != 2 hat, oder auf einem Pin liegt. Zwischen zwei
   Breaks entsteht eine neue Wire.
8. **Neuverdrahtung:** Endpunkte werden wieder an Pins/Junctions gebunden, der
   Netzname (falls vorhanden) wird übernommen.

Das ist im Kern eine **Kantenkontraktion plus Graphzerlegung in maximale Pfade**
über Knotengrade. Korrekt, aber teuer: mehrere geschachtelte Schleifen, im
Worst Case grob O(n²) bis O(n³) in der Segmentanzahl pro Netz. Für interaktive
Schaltpläne unkritisch, bei sehr großen Netzen aber ein potenzieller Hotspot.

### 2.7 Selektionsgeometrie

`finishSelection` ([app.js:90](js/app.js)) implementiert die aus CAD-Tools
bekannte Richtungssemantik:
- **Links-nach-rechts-Aufzug:** nur vollständig enthaltene Objekte
  (`rectContainsRect`).
- **Rechts-nach-links-Aufzug:** auch geschnittene Objekte (`rectIntersects`,
  Separating-Axis-Test als Negation der Trennbedingung).

Rotierte Bauteile werden über vertauschte `hitW`/`hitH` bei 90/270 Grad korrekt
umschlossen. `nearSeg` ([schematic.js:101](js/schematic.js)) berechnet den
Abstand Punkt-zu-Strecke über die projizierte Parameter-Klammerung
`t = clamp(((p-a)·(b-a))/|b-a|², 0, 1)`, die kanonische Methode.

### 2.8 Undo/Redo per Snapshot-Stack

`snapshotState` serialisiert das Modell zu JSON; `pushState`/`undo`/`redo`
verwalten zwei Stacks ([app.js:14-63](js/app.js)). Bewusst ausgeschlossen:
View (Pan/Zoom). `undo` verlangt mindestens zwei Einträge, da der oberste
Eintrag den aktuellen Zustand repräsentiert. Speichergrenze `HISTORY_MAX=200`.
Einfaches, robustes Memento-Muster; Kosten sind volle Tiefenkopien pro Aktion.

### 2.9 Zoom-to-Fit

`zoomToFit` ([app.js:1736](js/app.js)) bildet die Bounding-Box aller Bauteile
(rotationskorrigiert) und Wire-Punkte, addiert Padding und setzt
`zoom = min(W/bw, H/bh, 5)` sowie eine Zentrierung über die `viewBox`. Klassische
Fit-to-Content-Rechnung.

---

## 3. Netzlistengenerierung: Ist-Zustand und Prüfung gegen NGSpice

Die Funktion `generateNetlist()` ([netlist.js:151](js/netlist.js)) emittiert
zunächst feste Modellkarten und durchläuft dann `S.components` in einer großen
`if`-Kette pro Typ.

### 3.1 Geräte-Mapping (geprüft gegen NGSpice Manual v44/46)

| Typ | erzeugte Zeile (Schema) | NGSpice-Sollsyntax | Bewertung |
|-----|-------------------------|--------------------|-----------|
| resistor/capacitor/inductor | `<label> n1 n2 <val>` | `Rxxx n1 n2 val` | Pinreihenfolge ok; Präfix nur korrekt, wenn `label` mit R/C/L beginnt |
| vcc | `V<k> net 0 DC <v>` | `Vxxx n+ n- DC val` | ok als Quelle gegen Masse |
| source DC | `V<ref> n1 n2 DC <val>` | ok | aber Netzauflösung fehlerhaft (3.2 #1) |
| source AC | `V<ref> n1 n2 SIN(vo va f td theta phi)` | `SIN(...)` ist Transientenform, nicht `.ac` | funktional ok, Bezeichnung "AC" irreführend |
| source PULSE | `V<ref> n1 n2 PULSE(...)` | ok (7 bis 8 Parameter) | ok |
| source BEHAV | `E/G<ref> n1 n2 cur = '<eq>'` | E braucht `vol=`, G braucht `cur=` | **falsch für E** (3.2 #2) |
| diode/led | `D<label> nA nK <model>` | `Dxxx n+ n- model` | Pinreihenfolge ok; Modell- und Präfixproblem (3.2) |
| npn/pnp | `Q<label> nC nB nE <model>` | `Qxxx nc nb ne model` | Pinreihenfolge **korrekt** |
| nmos/pmos | `M<label> nD nG nS <model>` | VDMOS: `Mxxx nd ng ns model` (3 Pins) | Pinreihenfolge und 3-Pin-Form **korrekt** für VDMOS |
| sw | `S<label> nA nB n(-) n(+) <model>` | `Sxxx N+ N- NC+ NC- model` | **Steuerknoten vertauscht** (3.2 #3) |
| custom_* | `X<label> nets... <subname>` | `Xxxx nodes subckt` | ok, aber `.subckt`-Rumpf ist Platzhalter |
| opamp | (keine Ausgabe) | bräuchte Subcircuit | **fehlt komplett** (3.2 #6) |
| zener *(neu 2026-08-14)* | `D<label> nA nK zm_<ref>` + eigene `.model … D(BV=…)` | `Dxxx n+ n- model` | ok; Durchbruchspannung je Instanz |
| scr *(neu 2026-08-14)* | `X<label> nA nG nK scr_<ref>` + verhaltensbasierter `.subckt` | `Xxxx nodes subckt` | ok; Latch-Modell, siehe 3.4 |
| pwmgen *(neu 2026-08-14)* | `X<label> IN OUTH COMH OUTL COML pwmgen_<ref>` + `.subckt` | `Xxxx nodes subckt` | ok; B-Source-Modell, siehe 3.4 |

### 3.4 Zusammengesetzte Bauteile (Modellkarten und Subcircuits)

Diese drei Typen bringen ihr Simulationsmodell selbst mit; die Karten werden am
Ende der Netzliste emittiert, jeweils pro Instanz, damit die Parameter direkt
als Literale eingesetzt werden können (keine `params:`-Expansion nötig).

**Z-Diode (`zenerModelCard`).** Ein gewöhnliches Diodenmodell mit der
Durchbruchspannung der Instanz: `.model zm_dd1 D(IS=1e-14 N=1.6 RS=… CJO=100p
BV=<Vz> IBV=<Iz>)`. Verifiziert per `.dc`-Sweep: bei `BV=5.1` klemmt die
Ausgangsspannung eines 1 k/Z-Shuntreglers ab ca. 10 V Eingangsspannung auf
5.10 … 5.16 V, bei `BV=12` entsprechend auf ~12 V.

**Thyristor (`scrSubckt`).** Das klassische Zwei-Transistor-Makromodell wurde
verworfen: mit festen Stromverstärkungen ist α_npn + α_pnp > 1 bei *jedem*
Strom, das Modell zündet also von selbst (gemessen: 7 … 25 mA Sperrstrom, egal
wie Rgk, BF oder ISE gewählt werden). Stattdessen wird der Latch-Zustand
explizit geführt: eine B-Source setzt `st`, wenn V(G,K) > Vgt, und hält ihn,
solange der über `Vsense` gemessene Anodenstrom > Ih ist; `st` steuert einen
Schalter in Reihe mit einer Diode (Durchlassspannung). Das RC am Zustandsknoten
bricht die algebraische Rückkopplung auf. Verifiziert: 1 µA Sperrstrom, Zünden
per Gate-Puls, Halten nach dem Puls, Verlöschen bei Stromunterbrechung und
Sperren bis zum nächsten Gate-Puls.

**PWM-Generator (`pwmGenSubckt`).** Ports `IN OUTH COMH OUTL COML`: IN und der
Modulator liegen fest auf echtem Massepotential (Knoten 0, in Subcircuits
global), jeder Ausgang treibt gegen seinen eigenen Rückleiter — OUTH/COMH für
die High Side (kann mit dem Schaltknoten mitfahren), OUTL/COML für die Low
Side. Sägezahn per B-Source, Vergleich gegen
V(IN); IN = 0 … Range ergibt 0 … 100 % Tastgrad. Die Totzeit wird **nicht** über
`delay()` eingefügt (das Vorlagenmodell nutzt das, aber dieser WASM-Build kennt
die Funktion nicht: `no such function 'delay'` → `exit(1)`, die Engine bleibt
hängen), sondern über verschobene Vergleichsschwellen: der Sägezahn steigt pro
Periode um `Range`, eine Totzeit `dt` entspricht also dem Spannungsversatz
dv = dt·f·Range. High-Side leitet für dv < saw < V(IN), Low-Side für
saw > V(IN) + dv — beide Einschaltflanken verzögert, Ausschaltflanken
unverändert. Verifiziert: 10 kHz, IN = 1 V bei Range 5 V → 17,9 % statt 20 %
(2 µs Totzeit), kein Überlappen der Ausgänge.

Strommessung an diesen Subcircuits: NGSpice legt die Ströme der Bauteile
*innerhalb* eines Subcircuits als `i(v.xscr1.vsense)` bzw. `i(b.xpwm1.bouth)`
ab, darüber sind Anodenstrom (SCR) und Ausgangsströme (PWM, jeweils an OUTH/COMH
und OUTL/COML) probebar.

Die 3-Pin-VDMOS-Form ist laut Manual gültig ("the fourth node of the vdmos
instance can be removed"), siehe Quellen unten. Die NPN/PNP-Reihenfolge
(Collector, Base, Emitter) stimmt mit `Qxxx nc nb ne` überein.

### 3.2 Konkrete Fehler in der Netzlistengenerierung

**#1 (kritisch) Doppelte Präfixbuchstaben bei Q/M/D/S.**
`label` wird in `placeComp` ([app.js:952](js/app.js)) als `def.lbl + count`
gesetzt, also z. B. `Q1`, `M1`, `D1`, `SW1`. In `netlist.js` wird dann der
SPICE-Präfix erneut vorangestellt: `'Q'+ref` → `QQ1`, `'M'+ref` → `MM1`,
`'D'+ref` → `DD1`, `'S'+ref` → `SSW1`. Passive Bauteile stellen dagegen
**nichts** voran (`ref + ' ' + ...`), verlassen sich also darauf, dass `label`
bereits mit R/C/L beginnt. Diese Inkonsistenz ist die Hauptmotivation für die
generische Überarbeitung (Abschnitt 5).

**#2 (teilweise behoben) Default-Modelle werden nie verwendet.**
> Update 2026-06-22: Die `.model`-Karten werden jetzt nur noch emittiert, wenn
> ein Bauteil der jeweiligen Klasse vorhanden ist (siehe
> [netlist.js](js/netlist.js), `present`-Flags). Damit ist der Fall „leeres
> Value-Feld → `*_default`" simulierbar. Der unten beschriebene Kern (Value-Feld
> doppelt als Anzeige-Teilenummer und Modellname) bleibt bis zum generischen
> Generator aus Kapitel 5 bestehen.


Für npn/pnp/nmos/diode lautet die Modellwahl
`model = c.value || '<...>_default'`. `c.value` ist aber durch den
Platzierungs-Default **immer gesetzt** (`2N2222`, `2N7000`, `1N4148`, `RED`
usw.). Damit greift nie der Fallback, und die Zeile referenziert ein Modell
(`2N2222`, `RED`, ...), für das **keine** `.model`-Karte emittiert wird. Die
sorgfältig definierten `npn_default`/`mos_n_default`/`defaultdiode`-Karten sind
praktisch toter Code. Ergebnis: nicht simulierbare Netzliste (undefiniertes
Modell). Besonders auffällig bei LED (`value='RED'` → Modell `RED`).

**#3 (hoch) Quelle nutzt `getNetName` statt `getNetNameWithTempNames`.**
[netlist.js:193-194](js/netlist.js): Liegt ein Quellpin auf einem unbenannten
Netz, liefert `getNetName` `null`, und die Zeile enthält den Literalstring
`null` (`V1 null null DC 5`). Alle anderen Bauteile verwenden die
Temp-Namen-Variante. Quelle sollte das ebenfalls tun.

**#4 (hoch) Behavioural-Quelle E mit falschem Schlüsselwort.**
[netlist.js:217-220](js/netlist.js): Es wird immer `cur = '...'` ausgegeben.
Korrekt: nichtlineare Spannungsquelle `Exxx n+ n- vol='expr'`, nichtlineare
Stromquelle `Gxxx n+ n- cur='expr'`. Für `meas==='V'` (Präfix E) ist `cur=`
falsch. (Alternativ moderner: B-Quelle `Bxxx n+ n- v=expr` / `i=expr`.)

**#5 (hoch) Vertauschte Schalter-Steuerknoten.**
[netlist.js:236](js/netlist.js): `S ... nets[3] nets[2] ...`. Pin-Index 2 ist
`'+'`, Index 3 ist `'-'`. Ausgegeben wird also `NC+ = '-'-Pin`,
`NC- = '+'-Pin`. NGSpice erwartet `Sxxx N+ N- NC+ NC- model`, die
Steuerpolarität ist damit invertiert.

**#6 (mittel) Nicht-ASCII-Einheit beim Induktor.**
Default `'10µH'` ([components.js:140](js/components.js)) enthält das
Mikro-Zeichen `µ` (U+00B5), nicht das ASCII-`u`. NGSpice erwartet `10u`.
Trailing `H` wird zwar ignoriert, aber `µ` wird nicht als Skalierungsfaktor
erkannt. Gleiches Risiko bei beliebigen Werten, die der Nutzer mit `µ` eingibt.

**#7 (mittel) opamp ohne Netzlistenausgabe.**
opamp ist platzierbar, wird aber in `generateNetlist` durch keinen Zweig
behandelt und fällt durch (`passive.indexOf('opamp') < 0 → continue`). Er
verschwindet still aus der Netzliste. Mindestens ein Subcircuit-Stub wäre nötig.

**#8 (niedrig) Fehlende `.end`-Karte und Analysedirektiven.**
Es wird kein `.end` emittiert (von NGSpice toleriert, aber unsauber) und es gibt
keine `.op`/`.tran`/`.ac`/`.dc`-Steuerung. Letzteres ist der offene TODO-Punkt
"Spice Directives".

**#9 (niedrig) Knotennamen aus VCC-Labels.**
VCC-Knoten erhält den Namen `c.label||c.value` (z. B. `+5V`). Führende `+` und
Sonderzeichen in Knotennamen sind je nach Parser problematisch; besser wären
sanitisierte Bezeichner.

**#10 (niedrig) `pmos` als toter Zweig.**
`netlist.js` behandelt `nmos||pmos`, aber `CD` definiert nur `nmos` (kein
`pmos`-Symbol, kein Sidebar-Button). Der pmos-Pfad ist nicht erreichbar.
Symmetrisch fehlt damit ein P-Kanal-Bauteil im UI.

### 3.3 Sonstige Beobachtungen zur Netzliste

- Die Temp-Netz-Namensvergabe (`getTempNetName`,
  [netlist.js:101](js/netlist.js)) cached über ein Modul-Global
  `tempNetNamesGen`, das in `generateNetlist` zurückgesetzt wird. Funktioniert,
  ist aber zustandsbehaftet und nicht reentrant.
- Masseerkennung vergibt korrekt `'0'`.
- Custom-Subcircuits werden mit Platzhalterrumpf ausgegeben; ein Feld für den
  tatsächlichen `.subckt`-Inhalt (das vorhandene `_model`) wird nicht genutzt.

---

## 4. Allgemeine Inkonsistenzen und Probleme (über die Netzliste hinaus)

> Status der Bearbeitung (2026-06-22): Punkte 1 bis 6 wurden umgesetzt. Punkte 7
> bis 10 sind bewusst offen geblieben (siehe Begründung am Ende des Abschnitts).

1. **[BEHOBEN] Doppelte DOM-IDs / doppeltes Input-Element.** In
   [schematics.html](schematics.html) erschien `id="custom-import-file"`
   **zweimal** und ein `</div>` war überzählig. Das verwaiste Duplikat und das
   überzählige schließende `</div>` wurden entfernt; die Verschachtelung ist nun
   balanciert.
2. **[BEHOBEN] `event` als implizites Global.** `selectComp` nutzte das nicht
   deklarierte globale `event`. Die Funktion nimmt nun einen expliziten
   Parameter `ev` entgegen; alle 14 HTML-`onclick`-Aufrufe und der dynamische
   Sidebar-Handler übergeben `event` explizit.
3. **[BEHOBEN] Reihenfolgeabhängige Referenznummern.** Labels wurden über
   `filter(...).length + 1` vergeben, was nach Löschen/Neuplatzieren Duplikate
   erzeugte (auch über `D`-teilende Diode/LED hinweg). Neu: `nextRefNum(prefix)`
   in [app.js](js/app.js) vergibt höchste vorhandene Nummer + 1 je SPICE-Präfix.
4. **[BEHOBEN] `localStorage` ohne Versionierung.** Der persistierte Zustand
   erhält jetzt ein `version`-Feld (`SCHEMA_VERSION`); `loadSchematic` toleriert
   ältere Saves (ohne Feld) und warnt bei neueren. Quota-Fehler waren bereits per
   `try/catch` abgefangen.
5. **[BEHOBEN/dokumentiert] Custom-Component-Persistenz speichert Funktionen
   nicht.** `draw` geht beim `JSON.stringify` verloren und wird in
   `mergeCustomComponents` rekonstruiert. Verhalten ist korrekt; die bisher
   implizite Abhängigkeit ist nun mit einem erklärenden Kommentar versehen.
6. **[BEHOBEN] Wiederholter Probe-Start-Code.** Die drei identischen Blöcke in
   `onWireDown`, `onJuncDown` und `startProbeDrag` wurden zur gemeinsamen
   Hilfsfunktion `beginProbeDrag(pt)` zusammengeführt.
7. **[OFFEN] Sehr dichte Einzeiler** (z. B. `cleanupNet`,
   `findAllConnectedWires` als Hunderte-Zeichen-Zeilen) erschweren Wartung und
   Debugging.
8. **[OFFEN] Gemischte Sprachstile:** mal `const/let` mit Arrow-Functions, mal
   `var` mit klassischen Funktionen.
9. **[OFFEN] Kein Test, kein Linter, kein Typsystem.**
10. **[OFFEN] Fehlerpfade nutzen `alert()`** direkt im Datei-Import.

**Begründung für die offenen Punkte:** 7 und 8 sind reine Reformatierungen über
große Teile der Codebasis hinweg, die ohne Tests ein hohes Regressionsrisiko
tragen. 9 ist eine Werkzeug-/Infrastrukturentscheidung (Build-Setup), kein
diskreter Bugfix. 10 ist eine UX-Verbesserung, bei der ein Ersetzen von `alert()`
durch Statuszeilen-Hinweise kritische Fehler verstecken könnte; sinnvoll erst mit
einem eigenen Fehler-Modal. Diese Punkte sollten gesondert geplant werden.

---

## 5. Konzept: Generische Netzlistengenerierung

### 5.1 Problem

Die aktuelle `if`-Kette koppelt drei Dinge, die eigentlich pro Bauteil
zusammengehören, aber an verschiedenen Stellen liegen: SPICE-Präfix,
Pin-Reihenfolge und Wert-/Modell-Formatierung. Ein neues Bauteil erfordert
heute Änderungen in `components.js` (Symbol) **und** in `netlist.js` (Sonderfall).
Genau das hat die Fehler #1, #6, #7 verursacht.

### 5.2 Leitidee: Emitter-Deskriptor am Bauteil

Jede `CD`-Definition erhält eine deklarative `spice`-Beschreibung, die direkt
neben Symbol und Pins steht. Die Netzliste wird datengetrieben erzeugt; die
`if`-Kette entfällt.

Vorschlag für das Deskriptor-Schema:

```js
// in CD[type]:
spice:{
  prefix:'Q',            // SPICE-Geräteklasse
  // Reihenfolge der Knoten in der Zeile, als Pin-Indizes (oder Pin-Namen):
  nodeOrder:[1,0,2],     // z. B. C,B,E aus pins [B,C,E]
  // Wertfeld: 'model' oder 'value' oder Custom-Formatter:
  field:'model',
  modelRef:'value',      // welches comp-Feld den Modellnamen liefert
  defaultModel:'npn_default',
  // Optional: benötigte .model-Karte(n), nur emittiert wenn referenziert:
  models:{ npn_default:'NPN (IS=1e-14 BF=200 ...)' }
}
```

Für Spezialfälle (Quelle mit Modi, custom Subcircuit) erlaubt das Schema einen
**Funktions-Emitter** als Ausweg:

```js
spice:{ emit:(ctx)=> `${ref} ${nodes.join(' ')} ...` }
```

`ctx` kapselt: aufgelöste Knотennamen (immer via einheitlicher
`resolveNode(pin)`-Funktion mit Temp-Namen), die saubere Referenz und einen
`requireModel(name, card)`-Callback, der Modellkarten dedupliziert sammelt.

### 5.3 Zentrale Referenz- und Knotenauflösung

Zwei Hilfsfunktionen lösen die heutigen Inkonsistenzen strukturell:

- `refOf(comp)`: erzeugt **genau einen** Präfix. Konvention: `label` enthält nur
  die Nummer/den Namen ohne Klassenbuchstaben, der Präfix kommt aus
  `spice.prefix`. Bestehende Daten (`Q1`) werden über eine
  Normalisierung (führenden Klassenbuchstaben strippen, falls vorhanden)
  migriert. Damit verschwindet #1 für alle Typen gleichzeitig.
- `resolveNode(comp,pinIdx)`: einheitlich `getNetNameWithTempNames`. Beseitigt
  #3 (Quelle) automatisch.

### 5.4 Skizze des Generators

```js
function generateNetlist(){
  const ctx = newNetlistContext();      // setzt Temp-Namen zurück
  const lines = ['* SPICE Netlist generated by SchematicForge'];
  const usedModels = {};
  for(const c of S.components){
    const def = CD[c.type];
    if(!def.spice) continue;             // rein visuelle Bauteile (gnd, netconn)
    const nodes = (def.spice.nodeOrder||def.pins.map((_,i)=>i))
                    .map(i => resolveNode(c,i));
    lines.push(
      def.spice.emit
        ? def.spice.emit({comp:c, nodes, ref:refOf(c), require:(n,card)=>usedModels[n]=card})
        : defaultEmit(c, def, nodes, usedModels)
    );
  }
  // Modellkarten nur für tatsächlich referenzierte Modelle voranstellen:
  const modelLines = Object.entries(usedModels).map(([n,card])=>`.model ${n} ${card}`);
  return [lines[0], ...modelLines, '', ...lines.slice(1), '.end'].join('\n');
}
```

Vorteile:
- Neues Bauteil = **eine** Stelle (`CD[type].spice`), inklusive Symbol.
- `.model`-Karten werden nur emittiert, wenn referenziert (behebt #2 sauber).
- Einheitliche Knoten- und Referenzauflösung (behebt #1, #3).
- Spezialfälle (Quelle, Subcircuit, opamp) über `emit`-Funktion sauber kapselbar
  (behebt #7).
- Testbar: `defaultEmit` und `resolveNode` sind reine Funktionen.

### 5.5 Empfohlene Begleitkorrekturen bei der Umsetzung

- Werte sanitisieren: `µ → u`, Whitespace trimmen, leere Werte abfangen (#6).
- Schalter-Steuerknoten richtig ordnen (`NC+`=`'+'`-Pin) (#5).
- E/G-Quelle: Schlüsselwort aus `meas` ableiten (`vol=` vs `cur=`) (#4).
- Referenz-Uniqueness erzwingen (laufender Zähler statt `filter().length`).
- Knotennamen sanitisieren (#9).

---

## 6. Einbindung von NGSpice als WebAssembly

> **Implementierungsstatus (2026-06-22): umgesetzt.** Das Feature ist live in
> [js/simulation.js](js/simulation.js), dem Toolbar-Button `SIMULATE` und
> [schematics.html](schematics.html). Verifiziert im Browser: die WASM-Engine
> lädt, eine `.tran`-Simulation einer RC-Schaltung liefert `time / v(n001) /
> v(n002) / i(vsrc1)`, und der interaktive uPlot-Chart wird anhand der
> Probe-Auswahl gefiltert gezeichnet.
>
> - **UI: vertikaler Split-Screen** statt Modal. `SIMULATE` (toggelt
>   `setSimView`) öffnet ein Plot-Pane unter dem Schaltplan, getrennt durch einen
>   vertikal verschiebbaren Divider (`#sim-divider`, Drag passt die Pane-Höhe an,
>   `applyView`/`uPlot.setSize` folgen). Die Simulationseinstellungen
>   (Direktiven, Probe-Liste, Run, Raw-Modus, Log) liegen im Properties-Panel
>   (`#sim-settings`).
> - **Drag-to-Zoom-Vorschau:** uPlots Auswahlrechteck (`.u-select`) ist per CSS
>   sichtbar gemacht (Akzentfarbe), da die Voreinstellung auf dunklem Grund
>   unsichtbar war.
> - **Raw-Picker:** Vorbelegung erfolgt nur einmal pro Lauf (`simRawInit`).
>   Abwählen aller Signale bleibt bestehen (kein automatisches Reselect).
> - **Dev-Server:** `.claude/serve.py` (threaded, `Cache-Control: no-store`)
>   verhindert die Browser-Cache-Probleme des nackten `python -m http.server`.
>
> - **Engine:** `eecircuit-engine@1.7.0` (ngspice als WASM), lazy via
>   dynamischem `import()` von `esm.sh` beim ersten Lauf.
> - **Plot:** `uPlot@1.6.32` (≈50 KB, Zoom per Aufziehen, Pan, Live-Cursor,
>   klickbare Legende), eingebunden per CDN-`<script>`/`<link>`.
> - **Netzauswahl:** Im Probe-Modus (`P`) togglet ein **Klick** auf Netz oder Pin
>   eine einendige Spannung `V(netz)`; ein **Drag** von Netz A nach Netz B legt
>   eine **Differenzmessung** `V(B)-V(A)` an (degradiert zu einendig, wenn ein
>   Ende Masse/ungültig ist). `S.probes` hält Objekte `{kind:'V',net}` bzw.
>   `{kind:'Vd',p,n}`. Geplottet werden nur die gewählten Signale, sonst alle
>   Knotenspannungen. `.op`/Einzelpunkt-Ergebnisse als Wertetabelle, `.ac`
>   (komplex) als Betrag mit logarithmischer x-Achse.
> - **Raw-Modus (Checkbox):** Hält alle Vektoren des Laufs vor und blendet einen
>   Vektor-Picker (Checkboxen je Signal) ein; die Plot-Auswahl erfolgt dann
>   nachträglich unabhängig von der Canvas-Probe-Auswahl.
>   *(Überholt durch die gemeinsame Signalauswahl, siehe Nachtrag unten.)*
> - **Default-Modelle bedarfsgerecht:** Es werden nur `.model`-Karten der
>   tatsächlich platzierten Bauteilklassen emittiert (siehe 3.2 #2).
> - **Direktiven:** Textfeld im Modal (`.tran`/`.op`/`.ac`/`.dc`); hier lassen
>   sich auch zusätzliche `.model`-Karten ergänzen. Vollständige Netzliste =
>   `generateNetlist()` + Direktiven + `.end`.
>
> **Nachtrag (2026-08-14), UI-Ausbau:**
> - **Panel-Umschaltung:** Plot-Pane (`simViewActive`) und Einstellungsseite in
>   der Sidebar (`simPanelOpen`) sind entkoppelt. Beim Selektieren eines Bauteils
>   tritt die Einstellungsseite automatisch zurück (`renderProps`), das Plot-Pane
>   bleibt offen; zurück per `SETTINGS`-Button im Plot-Header oder `SIMULATE`.
> - **Drag & Drop:** Sidebar-Buttons tragen `draggable`/`data-comp`; ein Drop auf
>   `#schematic-pane` platziert das Bauteil an der Drop-Position (Ghost-Vorschau
>   beim `dragover`). Klick-und-platzieren funktioniert unverändert weiter.
> - **Strommessung am Pin:** Im Probe-Modus misst ein Klick auf einen Bauteil-Pin
>   den **Strom in diesen Anschluss** (Marker: Ringsymbol + Pfeil ins Bauteil +
>   `I <DEV>.<PIN>`); nur auf Netzen/Drähten wird weiterhin die Knotenspannung
>   gemessen. `S.probes` kennt dafür `{kind:'I',compId,pinIdx}`. Die Deckliste
>   bekommt bei Bedarf `.options savecurrents`; die Vektornamen liefert
>   `currentVectorsForPin()` in [js/netlist.js](js/netlist.js) (`@r1[i]`,
>   `@q1[ic]`, `i(vsrc1)` …). Die eecircuit-Engine exportiert Geräteströme als
>   `i(@r1[i])`, deshalb probiert `findVectorKey()` beide Schreibweisen.
> - **Formeln:** Beliebige Ausdrücke über die Ergebnisvektoren
>   (`V(out)-V(in)`, `V(out)*I(R1)`, `abs(@r1[i])`, SPICE-Suffixe wie `1k`),
>   compiliert nach JS; unbekannte Bezeichner werden inline gemeldet.
> - **Analysekonfigurator:** `.tran`/`.dc`/`.op` werden per Formular gebaut
>   (`buildAnalysisDirective`, Syntax nach NGSpice-Manual:
>   `.tran Tstep Tstop [Tstart [Tmax]] [UIC]`,
>   `.dc Srcnam Vstart Vstop Vincr [Src2 …]`), Vorschau der Karte inline.
>   `Manual` überlässt die Analysekarte wieder dem Direktivenfeld.
>   Analyse, Formeln und Direktiven liegen in `localStorage['sim_settings']`.
> - **Gemeinsame Signalauswahl:** Probes und Vektor-Picker editieren *eine*
>   Auswahl (`simSelection`, Map Vektorname → true). Ein Probe-Klick trägt den
>   zugehörigen Ergebnisvektor ein (`v(net)` bzw. die aufgelöste Stromkandidate),
>   ein Häkchen im Picker denselben Eintrag; wird ein geprobtes Signal dort
>   abgewählt, verschwindet auch der Probe. `simSelectionAuto` bedeutet "der
>   Nutzer hat noch nichts gewählt" — dann wird die Auswahl je Lauf aus allen
>   Knotenspannungen abgeleitet; der erste Probe ersetzt diesen Automatiksatz.
>   Bei jedem neuen Lauf gleicht `reconcileSelection()` die Auswahl gegen das
>   Ergebnis ab: Bekanntes bleibt erhalten (die Auswahl überlebt also mehrere
>   Läufe), Verschwundenes wird still entfernt — inklusive der zugehörigen
>   Probes, weil eine geänderte Netzliste Signale legitim wegfallen lässt.
>   Die Chip-Liste zeigt entsprechend alles Geplottete, nicht nur die Probes.
>   Der Automatiksatz enthält nur Knotenspannungen der tatsächlich gezeichneten
>   Netze — Subcircuit-Interna (`v(xpwm1.saw)`, `v(xscr1.st)` …) bleiben außen
>   vor — ebenso geräteinterne Knoten wie `v(mm1#gate)` (VDMOS-Gate hinter RG) —,
>   sind aber weiterhin im Vektor-Picker anwählbar.
>   `Clear selection` leert wirklich (danach wird nichts geplottet, der
>   Plotbereich sagt das auch), `All node voltages` stellt den Automatiksatz
>   wieder her, `All signals` wählt alles inklusive Bauteilströme.
> - **Alle Signale speichern (Default):** Die Checkbox "Save & list all signals"
>   ist voreingestellt aktiv, sorgt dafür, dass Bauteilströme im Ergebnis liegen
>   und nachträglich auswählbar sind, und blendet zugleich die Vektorliste ein.
>   Der Zustand liegt in `localStorage['sim_settings']`.
>   **`.options savecurrents` ist dafür unbrauchbar:** es fordert pauschal jeden
>   Anschluss jedes Bauteils an, beim VDMOS also auch `@m1[ib]` — das Bulk gibt
>   es dort nicht, ngspice bricht daraufhin die komplette Ergebnisausgabe ab
>   ("Error during 'write': no writable vector found") und dieser WASM-Build
>   kehrt danach gar nicht mehr zurück (Simulation hängt). Stattdessen baut
>   `buildSaveVectors()` die Liste aus dem Schaltplan: `.save all` plus genau die
>   Klemmenströme, die es beim jeweiligen Bauteiltyp gibt (R/C/L/S `[i]`, D
>   `[id]`, Q `[ic]/[ib]/[ie]`, M `[id]/[ig]/[is]` **ohne** `[ib]`, Quellen
>   `i(Vx)`). Interne Quellen unserer Subcircuits deckt `all` mit ab. Ein
>   ungültiger Eintrag in `.save` ist dabei unkritisch — ngspice ignoriert ihn,
>   anders als bei `savecurrents`.
> - **Kurvenfarben in der Sidebar:** `plotResult` legt die Zuordnung
>   Serienlabel → Farbe in `simSeriesColor` ab, `applySignalColors()` färbt
>   damit Chips, Vektorliste und Formel-Swatches ein. Gefärbt wird per
>   DOM-Durchlauf (Attribut `data-siglabel`) statt per Neu-Rendern, damit der
>   Fokus in einem gerade bearbeiteten Eingabefeld nicht verloren geht.
> - **GND gewinnt:** Ein Netz mit Massesymbol wird immer zu Knoten 0, auch wenn
>   es zusätzlich einen Netznamen trägt (`netAtPointIsGnd()` in
>   [netlist.js](js/netlist.js), zusätzlich in `getTempNetName()`). Vorher gewann
>   das Label, das Netz hing in der Simulation in der Luft
>   ("singular matrix: check node …").
> - **Modellwahl:** Teilenummern am Symbol (2N2222, 1N4148, RED …) sind keine
>   SPICE-Modelle. `pickModel()` nimmt die Teilenummer nur, wenn im Direktivenfeld
>   tatsächlich ein `.model`/`.subckt` dieses Namens steht (`userDefinedModels()`),
>   sonst das eingebaute Default-Modell — mit einer Notizzeile im Deck. Damit
>   simuliert ein frisch platziertes Bauteil ohne Nacharbeit (behebt 3.2 #2).
> - **Achsenbeschriftung:** Beide Achsen wählen ein gemeinsames SI-Präfix für das
>   *sichtbare Fenster* (`axisValuesSI`), das Präfix folgt dabei der Spannweite,
>   nicht dem Absolutwert — ein 20-µs-Ausschnitt eines 5-ms-Laufs wird also in µs
>   beschriftet. Erst wenn das Fenster so weit von null entfernt liegt, dass die
>   Beschriftung über vier Vorkommastellen läuft, geht es eine Stufe hoch. Die
>   Nachkommastellen werden so gewählt, dass benachbarte Ticks unterscheidbar
>   bleiben (einheitlich über alle Ticks). Die Zeitachse trägt die Einheit direkt
>   am Tick (`0.5 ms`), logarithmische Frequenzachsen bekommen pro Dekade ihr
>   eigenes Präfix (`1 Hz`, `1 kHz`, `1 MHz`).
> - **Plot:** Wert-Tooltip am Cursor (SI-Präfixe) sowie Buttons `FIT`, `FIT X`
>   und `FIT Y`. Da uPlot die y-Skala bei jedem Commit neu autoranged, läuft der
>   vertikale Fit über den `range`-Hook der y-Skala (`simYFit`) plus `setScale`;
>   Doppelklick bzw. ein Aufzieh-Zoom verwerfen den Fit wieder.
>
> **Bekannte Einschränkungen / nächste Schritte:**
> 1. **Online-Abhängigkeit:** Engine und uPlot kommen beim ersten Lauf vom CDN.
>    Für Offline-Betrieb sollten beide ins Repo vendoriert werden.
> 2. **Main-Thread:** Die Simulation läuft im UI-Thread. Für lange
>    Transienten sollte die Engine in einen (Module-)Web-Worker ausgelagert
>    werden (siehe Architekturskizze unten).
> 3. **Default-Modelle (Kapitel 3.2 #2):** Frisch platzierte Transistoren/Dioden
>    referenzieren Teilenummern (`2N2222`, `RED` ...) ohne passende `.model`-Karte
>    und scheitern daher in der Simulation, bis der Nutzer entweder das Value-Feld
>    leert (nutzt dann `*_default`) oder eine `.model`-Karte ins Direktivenfeld
>    schreibt. Die saubere Lösung ist der generische Generator aus Kapitel 5.
> 4. **Probe-Namensbindung:** Probes werden als Netzname zum Klickzeitpunkt
>    gespeichert. Ändert sich danach die Topologie, kann ein temporärer Name
>    (`n001` ...) abweichen; dann erneut proben.

### 6.0 Ursprüngliches Konzept (zur Referenz)

### 6.1 Verfügbare Bausteine (Stand 2026)

NGSpice lässt sich als Shared Library (`libngspice`) mit Emscripten nach WASM
kompilieren. Es existieren bereits einsatzfähige Projekte:

- **eecircuit-engine / EEcircuit** (eelab-dev): browserbasierter NGSpice-Simulator
  mit fertigem npm-Paket, WebGL-Plotting und CSV-Export.
- **danchitnis/ngspice**: Build-Tooling für WASM/Linux/Windows.
- **tscircuit/ngspice**, **ngspiceX**: weitere Browser-Builds (unterstützen
  tran/ac/dc/op/noise u. a.).

Empfehlung: nicht selbst kompilieren, sondern **eecircuit-engine** als
Abhängigkeit einbinden. Eigenes Emscripten-Kompilat ist wartungsintensiv (hohe
Emscripten-Update-Frequenz, laut NGSpice-devel-Diskussion).

### 6.2 Laufzeitarchitektur

```
[SchematicForge S-Modell]
        │  generateNetlist()  (+ Analysedirektive)
        ▼
   Netlist-String
        │  postMessage
        ▼
[Web Worker]  ──►  ngspice.wasm  (libngspice via ngSpice_Circ / ngSpice_Command)
        │  Ausgabe-Vektoren (Callbacks: SendData, SendChar, GetVSRCData)
        ▼
   { time/freq, V(node)..., I(dev)... }
        │  postMessage
        ▼
[Plot-Layer]  (Canvas/WebGL: Spannungs-/Stromverläufe)
```

Wesentliche Punkte:
- **Web Worker zwingend.** Eine Transientensimulation blockiert sonst den
  UI-Thread. Der Worker lädt das `.wasm`-Modul einmalig und hält die
  NGSpice-Instanz warm.
- **API-Fluss:** `ngSpice_Init(callbacks)` → `ngSpice_Circ(netlistZeilen[])` →
  `ngSpice_Command("bg_run")` → Ergebnisvektoren via `ngGet_Vec_Info` bzw. die
  `SendData`-Callbacks einsammeln.
- **Ausgabe-Callbacks:** `SendChar` (Log/Fehler), `SendStat` (Fortschritt),
  `SendData` (Datenpunkte je Zeitschritt). Diese auf `postMessage` mappen.

### 6.3 Was SchematicForge dafür liefern muss

1. **Analysedirektiven** (offener TODO-Punkt "Spice Directives"): UI für `.op`,
   `.tran tstep tstop`, `.ac dec n fstart fstop`, `.dc src start stop step`.
   Diese ans Ende der Netzliste hängen.
2. **Korrekte, simulierbare Netzliste** also zuerst Abschnitt 5 (Generik) und
   die Fehler aus 3.2 umsetzen. Ohne #2 (Modellkarten) scheitert jede
   Simulation an undefinierten Modellen.
3. **Knoten-/Probe-Bezug:** Das vorhandene Probe-Feature liefert bereits
   Netznamen. Diese als `.save V(node)` / Plotauswahl wiederverwenden, damit der
   Nutzer Messpunkte direkt im Schaltplan wählt.
4. **`.subckt`-Rümpfe** für opamp und Custom-Components (Feld `_model` als
   Quelle nutzen), sonst sind diese Bauteile nicht simulierbar.

### 6.4 Inkrementeller Umsetzungsplan

1. Netzliste generisch und korrekt machen (Abschnitt 5 + 3.2). Voraussetzung
   für alles Weitere.
2. Direktiven-UI ergänzen (mindestens `.op` und `.tran`).
3. `eecircuit-engine` in einem Worker prototypisch laden, eine fest verdrahtete
   RC-Netzliste simulieren, Rohausgabe in der Konsole verifizieren.
4. Ergebnis-Parsing und ein minimaler Plot (eine Spannung über Zeit).
5. Probe-Punkte mit Plotauswahl verbinden; Fehler-/Logausgabe von `SendChar` im
   UI anzeigen.
6. AC/DC-Analysen und Mehrkanal-Plots.

### 6.5 Risiken

- Lizenz: NGSpice ist überwiegend BSD-artig, einige Teile (XSPICE,
  KLU-Anbindung) gesondert prüfen, falls Auslieferung geplant ist.
- `.wasm`-Größe (mehrere MB): Lazy-Load erst bei erstem Simulationsklick.
- Versions-/API-Drift der WASM-Builds: konkrete Version pinnen.

---

## Quellen (NGSpice / WASM)

- Ngspice User's Manual v46 (HTML): <https://ngspice.sourceforge.io/docs/ngspice-html-manual/manual.xhtml>
- Power MOSFET (VDMOS) Modell: <https://nmg.gitlab.io/ngspice-manual/mosfets/powermosfetmodel_vdmos.html>
- Switch Model (SW/CSW): <https://nmg.gitlab.io/ngspice-manual/circuitelementsandmodels/elementarydevices/switchmodel_sw_csw.html>
- README.vdmos (imr/ngspice): <https://github.com/imr/ngspice/blob/master/README.vdmos>
- EEcircuit (WASM-Simulator): <https://github.com/eelab-dev/EEcircuit>
- danchitnis/ngspice (WASM-Tooling): <https://github.com/danchitnis/ngspice>
- NGSpice WASM-Build Patch #99: <https://sourceforge.net/p/ngspice/patches/99/>
