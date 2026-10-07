# TurmericLab: Code-Review und technische Dokumentation

> Stand: 2026-10-07. Diese Datei dokumentiert die Codebasis, die verwendeten
> mathematisch-algorithmischen Prinzipien, gefundene Inkonsistenzen sowie
> Konzepte für eine generische Netzlistengenerierung und die Einbindung von
> NGSpice-WASM. Es werden in diesem Dokument **keine** Code-Änderungen
> ausgeführt; die Umsetzung erfolgt nach menschlichem Review.

---

## 1. Überblick und Architektur

TurmericLab ist ein reiner Browser-Schaltplaneditor ohne Build-Schritt und
ohne externe Abhängigkeiten. Eingebunden wird alles statisch über
[schematics.html](schematics.html).

| Datei | Zeilen | Rolle |
|-------|-------:|-------|
| [js/schematic.js](js/schematic.js) | ~182 | Datenmodell `S`, reine Geometrie- und Netz-Logik (kein DOM) |
| [js/components.js](js/components.js) | ~612 | Bauteilbibliothek `CD` (inkl. der vier UI-Annotationstypen, Kapitel 7), SVG-Zeichenhelfer, Mini-Markdown-Renderer, Custom-Components |
| [js/netlist.js](js/netlist.js) | ~754 | SPICE-Netzlistengenerierung |
| [js/app.js](js/app.js) | ~2625 | Rendering, Eventhandling, Tools (Wire, Probe, Select, Resize/Crop), Undo, Copy/Paste, Import/Export, Persistenz |
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
| source RAMP *(neu)* | `V/I<ref> n1 n2 PWL(0 s [td s] {td+dur} e)` | `PWL(t1 v1 t2 v2 ...)`, Zeiten strikt steigend | ok; Haltepunkt bei `td` entfällt, wenn TDelay 0 ist; Duration 0 ergibt einen ngspice-Fehler |
| source DC, Show = Current, Load mode *(neu)* | `B<ref> n1 n2 I = '(I)*min(max(v(n1,n2)/0.05,0),1)'` | B-Quelle mit `I=` | ok; Strom fließt nur bei v(n+,n-) > 0 (weiches 50-mV-Knie), analog LTspice "load" |
| diode/led | `D<label> nA nK <model>` | `Dxxx n+ n- model` | Pinreihenfolge ok; Modell- und Präfixproblem (3.2) |
| npn/pnp | `Q<label> nC nB nE <model>` | `Qxxx nc nb ne model` | Pinreihenfolge **korrekt** |
| nmos/pmos | `M<label> nD nG nS <model>` | VDMOS: `Mxxx nd ng ns model` (3 Pins) | Pinreihenfolge und 3-Pin-Form **korrekt** für VDMOS |
| sw | `S<label> nA nB n(-) n(+) <model>` | `Sxxx N+ N- NC+ NC- model` | **Steuerknoten vertauscht** (3.2 #3) |
| custom_* | `X<label> nets... <subname>` | `Xxxx nodes subckt` | ok, aber `.subckt`-Rumpf ist Platzhalter |
| opamp | (keine Ausgabe) | bräuchte Subcircuit | **fehlt komplett** (3.2 #6) |
| zener *(neu 2026-08-14)* | `D<label> nA nK zm_<ref>` + eigene `.model … D(BV=…)` | `Dxxx n+ n- model` | ok; Durchbruchspannung je Instanz |
| scr *(neu 2026-08-14)* | `X<label> nA nG nK scr_<ref>` + verhaltensbasierter `.subckt` | `Xxxx nodes subckt` | ok; Latch-Modell, siehe 3.4 |
| pwmgen *(neu 2026-08-14)* | `X<label> IN OUTH COMH OUTL COML pwmgen_<ref>` + `.subckt` | `Xxxx nodes subckt` | ok; B-Source-Modell, siehe 3.4 |
| indmotor / clarke / park / svm / pi / integrator / mathblk *(Motor Control)* | `X<label> <Pins in CD-Reihenfolge> <typ>_<ref>` + `.subckt` | `Xxxx nodes subckt` | ok; B-Source-Modelle, siehe 3.5 |

**Quellen-Properties (`CD.source`).** `meas` (V/I) schaltet im Properties-Panel die Beschriftungen um ("(V)" wird "(A)", "Voltage" wird "Current", `Vinitial`/`Von` werden `Iinitial`/`Ion`), siehe `renderProps()` in `js/app.js`. Props können neben `modes` auch `meas:['I']` tragen und erscheinen dann nur bei dieser Messgröße (genutzt für `load`). Die SPICE-Präfixe stehen in `buildSpiceRefMap()`; `B` kommt nur beim Load-Modus vor und wird bei der `.save`-Liste wie `I`/`G` behandelt (`@ref[i]`).

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

*Flanken (Stand 2026-10-06/07).* Die Ausgänge sind keine harten `?:`-Sprünge
mehr, sondern 10-ns-Rampen (`min(max(x/eps,0),1)`-Produkte, `eps` = 10 ns in
Sägezahnspannung umgerechnet). Unstetige B-Quellen trieben den Solver am Gate
(Cgs/Cgd) auf "timestep too small". Der Low-Side-Ausgang schaltet kurz vor dem
Sägezahn-Reset (`saw = Range`) ab, damit der Reset keinen Sprung erzeugt.
Standard-Totzeit ist 200n (`pwm_deadtime`).

Strommessung an diesen Subcircuits: NGSpice legt die Ströme der Bauteile
*innerhalb* eines Subcircuits als `i(v.xscr1.vsense)` bzw. `i(b.xpwm1.bouth)`
ab, darüber sind Anodenstrom (SCR) und Ausgangsströme (PWM, jeweils an OUTH/COMH
und OUTL/COML) probebar.

Die 3-Pin-VDMOS-Form ist laut Manual gültig ("the fourth node of the vdmos
instance can be removed"), siehe Quellen unten. Die NPN/PNP-Reihenfolge
(Collector, Base, Emitter) stimmt mit `Qxxx nc nb ne` überein.

### 3.5 Motor-Control-Blöcke (`indmotor`, `clarke`, `park`, `svm`)

Reine Signalblöcke für eine FOC-Simulation, jeweils ein Subcircuit pro Instanz
(`MC_SUBCKT` in js/netlist.js, Portreihenfolge = Pinreihenfolge in `CD`).
Alle Signale sind Knotenspannungen in SI-Einheiten (1 V = 1 A / 1 rad / 1 rad/s /
1 N·m). Pins ohne Draht bekommen einen eigenen Knoten (`nc_<ref>_<pin>`), weil
sonst alle offenen Pins auf dem gemeinsamen Fallback `n000` zusammenfielen und
zwei offene Ausgänge kurzgeschlossen würden. Eingänge haben 1 G nach Masse.

**Asynchronmotor.** Käfigläufer im ruhenden αβ-Koordinatensystem,
amplitudeninvariante Clarke-Skalierung (2/3), Stern mit schwebendem Sternpunkt.
Zustände: Stator- und Rotorflussverkettung (4 Integratoren), Drehzahl, Winkel.
Ein Integrator ist eine B-Stromquelle in einen Kondensator von 1 F (J für die
Drehzahl). Gleichungen: dψs/dt = vs − Rs·is, dψr/dt = −Rr·ir + j·p·ω·ψr,
Te = 1,5·p·(ψsα·isβ − ψsβ·isα), J·dω/dt = Te − TL − B·ω. Die Ableitungen sind
mit `(time>0)` maskiert, damit der Arbeitspunkt unabhängig von den Spannungen bei
t=0 der Ruhezustand ist; jeder Zustandsknoten hat 1 G nach Masse (sonst singulär).
Pins: `A B C` (Stator), `TL` Lastmoment (Eingang), `TE` inneres Moment, `W`
Drehzahl [rpm], `TH` mechanischer Winkel [Grad] (intern rad/s und rad; für Park: rad = Grad·π/180, ×p), `IA IB IC`
Phasenströme als Spannung 1 V/A (positiv in die Maschine). Defaults: 4 kW /
400 V / 50 Hz Standardmotor (Rs 1,405 Ω, Rr 1,395 Ω, Lls = Llr = 5,839 mH,
Lm 172,2 mH, J 13,1·10⁻³ kg·m², p = 2).
Verifiziert: 3×325 V / 50 Hz Hochlauf auf 156,9 rad/s (Synchrondrehzahl 157,08),
mit 20 N·m Last 152 rad/s. **Zeitschritt beachten:** die Trapezintegration lässt
den simulierten Rotorfluss bei großem Schritt zu langsam drehen (bei Tmax = 1 ms
ca. 0,8 % Drehzahlfehler, bei 100 µs vernachlässigbar). Mit PWM-Takt ohnehin
kein Thema.

**Clarke.** `IA IB IC → ALPHA BETA`, α = 2/3·(a − b/2 − c/2), β = (b − c)/√3.
Option "Two inputs only": c = −a−b, dann α = a, β = (a + 2b)/√3.

**Park.** `IN1 IN2 TH → OUT1 OUT2`, TH = d-Achsenwinkel in rad. Vorwärts
d = α·cosθ + β·sinθ, q = −α·sinθ + β·cosθ; rückwärts (Option "dq → αβ")
α = d·cosθ − q·sinθ, β = d·sinθ + q·cosθ.

**Raumzeigermodulation.** `VALPHA VBETA VDC → OUTA OUTB OUTC`. Aus αβ werden die
drei Phasenspannungen gebildet, Nullsystem-Injektion −(max+min)/2 ergibt exakt
die SVPWM-Tastgrade d = 0,5 + (v − (max+min)/2)/Vdc, begrenzt auf 0…1,
ausgegeben als d·Range (Default 1 V = 100 %, passend zum PWM-Generator-Eingang).
Vdc kommt aus der Property, oder vom Pin VDC, sobald dort mehr als 1 V anliegen.
Verifiziert: Clarke → Park mit θ = ωt liefert d = 0, q = −10 für eine
sin-Dreiphasenquelle (10 V), und die Tastgradeinträge erfüllen
dA − dB = (vA − vB)/Vdc exakt.

**PI-Regler.** `REF FB → OUT`, e = REF − FB, OUT = clamp(Kp·e + xi) mit
xi' = Ki·e. Anti-Windup per bedingter Integration: der Integrator hält an, solange
der Ausgang am Limit ist und der Fehler weiter in die Begrenzung schiebt.
Verifiziert: Kp = 2, Ki = 100, Eingang 0,1 V liefert 0,2 V + 10·t.

**Integrator.** `IN → OUT`, OUT = K·∫IN dt, Start bei 0 (wie die Motorzustände
mit `(time>0)` maskiert).

**Funktionsblock (`mathblk`).** `IN1 IN2 IN3 → OUT`, frei wählbarer Ausdruck in
`in1`, `in2`, `in3` und `time` (wird zu einer B-Voltage-Source mit `v(INx)`).
Dient für Referenzverläufe, Summen, Verstärkungen und den gemittelten
Wechselrichter. Ein Ausdruck mit unbekanntem Bezeichner lässt dieses
WASM-ngspice hängen statt einen Fehler zu melden (Stop-Button nutzen).

**Beispiel `library/foc_induction_motor.svg`.** Indirekte feldorientierte Regelung
(IFOC) des 4-kW-Motors: Drehzahl-PI liefert iq*, ein Funktionsblock id* (12 A
Vorflussung bis 80 ms, danach 5,5 A), Schlupf ωsl = Rr/Lr·iq*/id*,
ωe = p·ω + ωsl (Funktionsblock rechnet rpm → rad/s um), θe = ∫ωe. Die Phasenströme (1 V/A vom Motor) laufen über
Clarke und Park(θe) in id/iq, zwei Strom-PI (Kp 30 V/A, Ki 7000) liefern vd/vq,
Rück-Park und Raumzeigermodulation die Tastgrade. Der Wechselrichter ist
**gemittelt** (Phasenspannung = (d − 0,5)·600 V über Funktionsblöcke). Verifiziert
(Tmax 50 µs, 4 s Rechenzeit für 0,5 s): Drehzahlsprung 0 → 950 rpm bei 0,1 s
mit ca. 2 % Überschwingen, id folgt id*, bei 15 N·m Last ab 0,35 s Einbruch auf
ca. 900 rpm und Ausregelung, Te = 15,2 N·m.
Die Verdrahtung läuft über Netznamen (Draht-Stubs mit gleichem Namen = ein Knoten).
Eine schaltende Variante (3 × PWM-Generator + 6 VDMOS an 600 V) bricht in
ngspice bei 182 µs mit "Timestep too small" am ersten MOSFET ab; sie ist nicht
Teil der Bibliothek.

**ESR/DCR an C und L.** Kondensator und Spule haben das optionale Property `esr`
("Serienwiderstand"). Ist es ungleich 0, emittiert `generateNetlist()` statt
`C1 a b val` die Kette `C1 a n_C1_esr val` und `RC1_esr n_C1_esr b esr`; der
Bauteilstrom `@C1[i]` bleibt der Strom durch beide.

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
  const lines = ['* SPICE Netlist generated by TurmericLab'];
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
[TurmericLab S-Modell]
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

### 6.3 Was TurmericLab dafür liefern muss

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

## 7. UI-Annotationselemente: Blanket, Image, Text-Label, Notiz

> **Implementierungsstatus (2026-08-29): umgesetzt.** Vier reine
> UI-Elemente ohne jede Netzliste-/Simulationsrelevanz: `blanket` (Gruppierungsrahmen
> mit Titeltext), `image` (eingebettetes Bild, croppable), `textlabel`
> (einzeiliger Freitext) und `note` (mehrzeilige Notiz mit Markdown). Alle vier
> sind normale Einträge in `S.components` — Undo/Redo, `saveSchematic`,
> `exportSVG`/`importSVG` laufen unverändert generisch über dieses Array, da
> keiner der vier Typen in `netlist.js` referenziert wird (`pins:[]`,
> kein `if(c.type==='...')`-Zweig).

### 7.1 Datenmodell und Anker-Konvention

Elektrische Bauteile sind an ihrem **Zentrum** verankert (`x,y` = Mittelpunkt,
Symbol wird relativ dazu gezeichnet). `blanket`, `image` und `note` durchbrechen
das bewusst und sind an der **oberen linken Ecke** verankert (`x,y` = Ecke,
explizites `w`/`h`), da das die Resize-Mathematik erheblich vereinfacht (Ecke
ziehen = `w += dx; h += dy`, kein Verschieben des Zentrums nötig). `textlabel`
bleibt wie ein Bauteil an einem Punkt verankert (Textursprung), hat aber kein
`w`/`h` — seine Hitbox wird nach jedem Render live per `text.getBBox()`
vermessen und in `comp._mx/_my/_mw/_mh` zwischengespeichert (reiner
Laufzeit-Cache, kein Persistenzfeld im eigentlichen Sinn, wird aber der
Einfachheit halber mitgespeichert und beim nächsten Render ohnehin überschrieben).

```text
blanket:   { id, type:'blanket', x, y, w, h, label, halign, valign }
image:     { id, type:'image',   x, y, w, h, src, natW, natH, crop:{x,y,w,h}, label }
textlabel: { id, type:'textlabel', x, y, label, fontSize, bold, italic, strike }
note:      { id, type:'note',    x, y, w, h, text }
```

Zwei neue Konstanten in [app.js](js/app.js) kapseln diese Sonderfälle generisch:
`UI_ANNOTATION_TYPES` (alle vier — u. a. verwendet, um Rotation/Spiegelung für
diese Typen zu unterbinden, siehe 7.2) und `TOPLEFT_BOX_TYPES` (`blanket`,
`image`, `note`). Eine gemeinsame Hilfsfunktion `compBBox(c)` liefert die
Weltkoordinaten-Bounding-Box für **jeden** Komponententyp (Ecke+Größe für die
Box-Typen, gemessene Bbox für `textlabel`, sonst wie bisher zentriert um
`hitW`/`hitH`) und ersetzt damit die vorher an drei Stellen duplizierte
hitW/hitH-Logik in `finishSelection`, `renderComps` und `zoomToFit`.

### 7.2 Blanket: immer im Hintergrund, nur am Titel selektierbar

Ein rein visuelles Gruppierungsrechteck für Blockschaltbilder. Zwei
Anforderungen widersprechen dem generischen Rendering-/Selektionsmodell und
wurden strukturell statt per Sonderfall-Flag gelöst:

- **Immer im Hintergrund, unabhängig von Einfügereihenfolge.** Statt eine
  z-Order über die Position in `S.components` zu pflegen, bekommt Blanket einen
  eigenen SVG-Layer `#lyr-blankets`, der in [schematics.html](schematics.html)
  strukturell **vor** `#lyr-wires`/`#lyr-comps` liegt. `renderBlankets()`
  zeichnet ausschließlich `type==='blanket'`-Einträge dorthin;
  `renderComps()` überspringt sie (`if(comp.type==='blanket')continue;`).
  Da die Layer-Reihenfolge im DOM fix ist, ist Blanket damit *strukturell*
  garantiert hinter allem anderen — kein Re-Sortieren nötig.
- **Nur der Titeltext ist klickbar/verschiebbar, nie die ganze Gruppen-Selektion.**
  `renderBlankets()` hängt den Drag-Handler (`onBlanketTitleDown`) gezielt nur
  an das `<text class="blanket-title">`-Element; der Rahmen selbst bekommt
  `pointer-events:none` (CSS) und keinen Group-Mousedown-Handler — Klicks
  fallen also zu darunterliegenden Bauteilen durch. Zusätzlich überspringt
  `finishSelection()` `type==='blanket'` explizit in der Marquee-Schleife, sodass
  ein Rubber-Band-Aufzug über den ganzen Rahmen das Blanket **nie** mitselektiert
  (nur enthaltene Bauteile, ohne jede Parent/Child-Beziehung — das Blanket trackt
  seinen Inhalt bewusst nicht, rein optisch).

Resizable über einen Eck-Handle unten rechts (`addResizeHandle`, nur gerendert
wenn selektiert), frei in Breite/Höhe (kein Aspect-Ratio-Zwang, anders als
Image, siehe 7.3). Titel-Ausrichtung (`halign`/`valign`) und Breite/Höhe sind
zusätzlich als normale Text-Properties editierbar.

### 7.3 Image: nicht-destruktiver Crop und Aspect-Ratio-Resize

Eingebettet als `src` (data-URI, base64), einfügbar über Sidebar-Button
(File-Picker → `insertImageViaFilePicker()`), Drag&Drop einer Bilddatei auf den
Canvas (`pane`-`drop`-Handler in `initCompDnD()` erkennt `e.dataTransfer.files`
vor der Sidebar-Typ-Logik) und Ctrl+V der OS-Zwischenablage (siehe 7.6). Alle
drei Wege laufen durch `placeImageFromFile()` → `placeImageComp()`.

**Crop-Mechanik.** `crop:{x,y,w,h}` ist der sichtbare Ausschnitt in
**Originalbild-Pixelkoordinaten**. Gerendert wird ein verschachteltes `<svg>`
mit `viewBox="crop.x crop.y crop.w crop.h"` und fester `width/height = w/h`
(Box-Größe); das `<image>`-Kind darin behält immer die vollen `natW`/`natH`. Ein
verschachteltes `<svg>` clippt seinen Inhalt automatisch auf sein eigenes
Viewport (SVG-Spezifikation, `overflow:hidden` per Default) — kein manuelles
`<clipPath>` nötig. `src`/`natW`/`natH` werden nie verändert, nur `crop`
schrumpft/wächst, geklemmt auf `[0,natW]×[0,natH]` — daher jederzeit bis zum
Originalbild rückgängig zu machen.

Vier Crop-Handles (Kantenmitten, `onCropMove` in [app.js](js/app.js)) und ein
Resize-Handle (Ecke unten rechts, `onResizeMove`) teilen sich den bestehenden
`S.drag`-State-Machine-Mechanismus (`startDrag`/`onDragMove`/`onDragEnd`,
erweitert um die Target-Typen `'resize'`/`'crop'`). Mathematische Invariante:
Für jede Kante muss die Anzeige-Skalierung `Box-Größe / Crop-Größe` beim
Ziehen konstant bleiben (sonst wird das Bild sichtbar gestreckt statt
beschnitten) — Kern der Formel ist `boxDelta = deltaCrop / scale` mit
`scale = crop0.{w,h} / box0.{w,h}` zum Zeitpunkt des Drag-Starts.

> **Gefundener und behobener Bug (2026-08-29):** In den Zweigen `edge==='left'`
> und `edge==='top'` von `onCropMove` stand versehentlich
> `boxDx2 = -deltaCropW/scale` (Vorzeichen invertiert) statt
> `boxDx2 = deltaCropW/scale`. Effekt: Ziehen der linken/oberen Kante
> vergrößerte die Box, statt sie zu verkleinern (während `right`/`bottom`,
> ohne diese Negation, korrekt funktionierten) — genau umgekehrtes Verhalten
> zum beabsichtigten Crop. Nach dem Fix skaliert die Box in allen vier
> Richtungen im Gleichschritt mit dem Crop-Rechteck; die gegenüberliegende
> Kante bleibt jeweils fix (`c.x`/`c.y` werden nur bei `left`/`top`
> mitverschoben, damit die rechte/untere Kante an Ort und Stelle bleibt).

**Aspect-Ratio beim Eck-Resize.** `onResizeMove` behandelt `type==='image'`
gesondert: statt Breite und Höhe unabhängig aus `dx`/`dy` zu berechnen, wird
das Seitenverhältnis der Box zum Drag-Beginn (`S.drag.w0/S.drag.h0`) fixiert und
die dominante Zugachse (größere Bewegung von `dx` vs. `dy·ratio`) treibt beide
Dimensionen proportional. Crop bleibt dabei unverändert — nur die
Anzeigegröße skaliert gleichmäßig, keine Verzerrung. Blanket und Notiz
durchlaufen bewusst den ursprünglichen, freien (nicht seitenverhältnistreuen)
Zweig, da sie keinen Bildinhalt haben, der verzerren könnte.

**Crop- vs. Resize-Handle visuell unterscheidbar.** Beide Handle-Typen sahen
anfangs identisch aus (Kreis), was in der Praxis zu Fehlgriffen führte. Der
Eck-Resize-Handle (`addResizeHandle`) bleibt ein runder Punkt in Akzentfarbe;
die vier Crop-Handles (`addCropHandle`) sind stattdessen gelbe, gekerbte Balken
quer zur Kante (bewusst am "Kante trimmen"-Symbol aus Bildeditoren orientiert),
mit einer unsichtbaren, größeren Klickfläche als der sichtbare Balken.

### 7.4 Text-Label und Notiz

**Text-Label** (`CD.textlabel`): einzeiliges `<text>`, Formatierung
(`fontSize`, `bold`, `italic`, `strike`) direkt als Inline-Styles auf dem
Element. Verhält sich — anders als Blanket — wie ein ganz normales Bauteil:
volle Marquee-/Klick-Selektion, normale z-Order, Multi-Drag.

**Notiz** (`CD.note`): mehrzeiliger Text in einem `<foreignObject><div>`
(automatischer Zeilenumbruch durch den Browser, `white-space:pre-wrap`).
Grafisch resizable über denselben Eck-Handle-Mechanismus wie Image/Blanket
(`addResizeHandle`, frei, kein Aspect-Ratio-Zwang).

**Markdown-Rendering.** `renderMiniMarkdown(src)` in
[components.js](js/components.js) ist ein bewusst minimaler Vanilla-Parser
(keine Bibliothek): Überschriften `#`/`##`/`###`, `**fett**`/`__fett__`,
`*kursiv*`/`_kursiv_`, `` `code` ``, `~~durchgestrichen~~`, ungeordnete Listen
(`-`/`*`), nummerierte Listen (`1.`/`1)`), einfache Pipe-Tabellen (Kopfzeile,
Trennzeile mit optionaler Ausrichtung `:--`/`:-:`/`--:`, danach Zeilen mit `|`)
und Leerzeilen als Absatzumbruch. Tabellenrahmen nutzen das
Separate-Border-Modell (`border-collapse:separate`), weil verbundene Rahmen
einen halben Pixel ueber die Tabelle ragen und vom `overflow:hidden` der Notiz
je nach Rasterposition abgeschnitten werden. Die Eingabe wird **vor** dem
Parsen HTML-escaped (`&`,`<`,`>`), sodass Markdown-Quelltext kein Markup
einschleusen kann — das Ergebnis geht direkt per `innerHTML` in den
`<div>` der Notiz.

### 7.5 Generische Properties-Panel-Erweiterung: `bool` und `textarea`

`renderProps()` kannte bisher nur `type:'enum'` (Radiobuttons) und einen
impliziten Freitext-`<input>`-Fallback. Für Notiz-Text (mehrzeilig) und
Text-Label-Stilflags (Boolean) wurden zwei weitere generische Prop-Typen
ergänzt, nach demselben "kein Apply-Button, alles live"-Muster wie die
bestehenden Typen:

- `type:'bool'` → `<input type="checkbox">`, Listener setzt `comp[key]=checkbox.checked`.
- `type:'textarea'` → `<textarea class="prop-input">`, läuft über denselben
  generischen `input`-Listener wie einzeilige Text-Properties (keine
  Sonderbehandlung nötig, da `textarea.value` sich wie `input.value` verhält).

Damit funktionieren beliebige zukünftige Bauteile mit Checkbox- oder
Mehrzeilen-Properties ohne weiteren Code im Properties-Panel.

### 7.6 Gefundene und behobene Bugs abseits der Kernfeatures

Beim iterativen Testen der vier neuen Elemente traten vier Bugs auf, die alle
auf Interaktionen mit bereits bestehendem, ungeändertem App-Code
zurückzuführen waren (nicht auf die neuen Elemente selbst) — dokumentiert hier,
da sie beispielhaft für den Umgang mit SVG-Text, Formularfeldern und
`paste`/`keydown`-Interaktion in dieser Codebasis sind:

1. **Native Text-Selektion beim Ziehen von SVG-`<text>`.** Ein Drag, der über
   ein `<text>`-Element läuft (Bauteil-Label, Wire-Netznamen, Text-Label),
   löst ohne Gegenmaßnahme die native Browser-Textmarkierung über den ganzen
   Canvas aus — sichtbar als "alles blau markiert", ohne Auswirkung auf
   `S.selected`, aber verwirrend. Fix: `user-select:none` auf `#schematic-svg`
   ([styles.css](css/styles.css)).
2. **Backspace in einer fokussierten `<textarea>` löschte die ganze
   Komponente.** Der globale `keydown`-Handler prüfte nur `e.target.tagName
   ==='INPUT'`, nicht `'TEXTAREA'` — ein Feld, das es vor der Notiz im
   Properties-Panel schlicht nicht gab. Fix: Guard um `TEXTAREA` erweitert.
3. **Ctrl+V für OS-Zwischenablage-Bilder wurde vom eigenen Code unterdrückt.**
   Der bestehende `keydown`-Handler rief für Ctrl+V `e.preventDefault()`
   gefolgt von `pasteFromBuffer()` (internes Kopier-Clipboard). `preventDefault()`
   auf dem **Keydown** unterdrückt in Chromium/Firefox aber die
   Standardaktion des Tastenkombination — und die *ist* das Auslösen des
   nativen `paste`-Events. Der neue Bild-Paste-Listener bekam das Event also
   nie zu Gesicht. Fix: Keydown macht bei Ctrl+V nichts mehr; die gesamte
   Fallunterscheidung ("Bild im Clipboard? → Bild einfügen. Sonst? →
   `pasteFromBuffer()`") sitzt jetzt zentral im `paste`-Event-Handler.
4. **Crop-Vorzeichenfehler**, siehe 7.3.

---

## 8. Custom Components: Bibliothek, Editor, Modell-Import und Pin-Relinking

### 8.1 Zwei Registries statt einer: `libraryComponents` vs. `customComponents`

Custom-Component-Definitionen (`js/components.js`) leben in zwei getrennten
Objekten:

- `customComponents` — **Schematic-inline**. Genau das, was mit dem aktuellen
  Schematic gespeichert wird (`saveSchematic()`/`loadSchematic()`, seit dieser
  Änderung auch `exportSVG()`/`importSVG()`) und beim Laden eines anderen
  Schematics vollständig ersetzt wird — beabsichtigt, ein Dokument bringt
  seine eigenen Kopien mit.
- `libraryComponents` — **persistent, schematic-unabhängig**, eigener
  localStorage-Key `schematic_library`. Wird von `loadSchematic()`,
  `importSVG()` und `clearAll()` nie berührt und beim Start zusätzlich aus
  `lib/default_components.json` geseedet (`seedLibraryFromDefaults()`, nur
  fehlende Keys, damit eigene Bibliotheks-Änderungen erhalten bleiben).

`CD` (die von Rendering/Platzierung/Netzliste genutzte flache Laufzeit-Dict)
wird von `mergeCustomComponents()` aus beiden Registries gebaut, Bibliothek
zuerst, inline danach — inline gewinnt bei Namenskollision. Das ist der
eigentliche Fix für den ursprünglichen Ladekonflikt: vorher gab es nur eine
einzige `customComponents`-Registry, die `loadSchematic()`/`importSVG()`
komplett ersetzten — jede geladene Definition (egal ob absichtlich divergiert
oder zufällig gleichnamig) überschrieb faktisch, was zuvor als "die" Definition
dieses Keys galt. Mit der Trennung gibt es keine gemeinsame, überschreibbare
globale Registry mehr: ein geladenes Schematic rendert/simuliert immer mit
seiner eigenen eingebetteten Kopie, unabhängig vom aktuellen Bibliotheksstand.
Bibliothek und Inline-Kopie dürfen bewusst divergieren; der Abgleich passiert
nur explizit über "Update from Library" (8.3).

Beim ersten tatsächlichen Platzieren eines Bibliotheks-Bauteils
(`placeComp()`) wird sofort eine inline Kopie angelegt (`_libraryKey` verweist
zurück auf den Bibliotheks-Key) — jedes im Schematic verwendete Bauteil ist
dadurch von Anfang an self-contained/exportierbar.

### 8.2 `createCustomCompDef` als reiner Builder

`createCustomCompDef(providedKey,config)` baut nur noch `{key,def}` und
schreibt nirgends selbst in eine Registry — Aufrufer entscheiden explizit
(`customComponents[key]=…` oder `libraryComponents[key]=…`). Die Umkehrung,
`extractCustomCompConfig(def)`, liest eine bestehende Definition zurück in das
Editor-Konfigurationsformat; beide zusammen tragen den Editor selbst, das
Klonen, "Save to Library" und "Update from Library" — jeder dieser Wege ist
im Kern nur `extractCustomCompConfig` → (Werte anpassen) → `createCustomCompDef`
→ Zielregistry zuweisen.

### 8.3 Pin-Relinking: Namens- statt Indexmatching

Leiterbahnen referenzieren einen Pin über `{compId,pinIdx}`. `rewireComp()`
(Rotation/Spiegelung) vertraut `pinIdx` blind, weil sich dabei nur die
Position, nie Identität oder Reihenfolge der Pins ändert. Eine
Custom-Component-Bearbeitung (oder "Update from Library") kann Pins aber
hinzufügen, entfernen oder umsortieren — ein unverändert gebliebener `pinIdx`
würde beim nächsten Verschieben (`moveComp`) oder Rotieren stillschweigend auf
einen falschen oder gar nicht mehr existierenden Pin zeigen, während die
Wire-Geometrie unverändert an ihrer alten Position hängen bleibt.

`relinkCustomCompPins(typeKey, oldPins)` (js/schematic.js) löst das per
Namens-Matching zwischen dem alten Pin-Array (Snapshot vor der Änderung) und
dem gerade installierten `CD[typeKey].pins`: gleicher Name, verschobener Index
→ `pinIdx` aktualisieren und Wire-Ende per `rerouteEnd`/`compPinPos` an die
neue Position ziehen; Name nicht mehr vorhanden → Verbindung lösen
(`w.from`/`w.to = null`, die Wire bleibt geometrisch liegen, gilt aber nicht
mehr als angeschlossen). Wird für **jede** platzierte Instanz des betroffenen
Typs aufgerufen (eine Definition kann mehrfach verwendet werden) — sowohl aus
`commitCustomCompEdit()` als auch aus `updateComponentFromLibrary()`.

### 8.4 Modell-Import: Parsing und Netzlisten-Emission

`parseSubcktHeader(text)` (js/components.js) findet die erste
`.subckt NAME p1 p2 …`-Zeile (inkl. `+`-Fortsetzungszeilen), bricht die
Pin-Liste an `PARAMS:`/dem ersten `key=value`-Token ab. Der Component-Editor
ruft das beim Verlassen des Modell-Textfelds (`syncCustomPinsFromModel()`) auf
und ersetzt bei einem Treffer die Pin-Listen (erste Hälfte links, Rest rechts,
Header-Reihenfolge erhalten) — bewusst nur bei Blur, nicht bei jedem
Tastendruck, damit ein späteres manuelles Umbenennen von Pins nicht bei jeder
weiteren Modell-Textänderung wieder überschrieben wird.

In der Netzliste (`js/netlist.js`) wird ein nicht-leeres `def._model`
unverändert als Subcircuit-Definition emittiert (statt des bisherigen
"not implemented"-Stubs), und der X-Instanzzeilen-Name (`customSubcktName`)
bevorzugt den im Modell-Header deklarierten Namen. Wichtiger:  die
**Portreihenfolge** der Instanzzeile folgt, wenn ein passendes Modell mit
gleicher Pin-Anzahl vorliegt, der **Header-Reihenfolge** (Pins werden per Name
in `def.pins` nachgeschlagen) statt der visuellen Links/Rechts-Array-Reihenfolge.
Das ist eine bewusste Entkopplung: der neue Drag&Drop-Pin-Editor (siehe
Properties-Panel) erlaubt rein kosmetisches Umsortieren der Pins für die
Symbol-Optik; ohne diese Entkopplung würde ein solches Umsortieren die
SPICE-Subcircuit-Aufrufreihenfolge (rein positional) unbemerkt verfälschen.
Ohne passendes Modell (oder bei Pin-Anzahl-Mismatch) bleibt der Fallback über
`def.pins`-Reihenfolge erhalten.

---

## 9. Schematic-Dateien: interne und globale Bibliothek

**Intern (Browser-Storage).** Mehrere Schematics liegen parallel in
`localStorage`: `schematic_files` (Index `[{id,name,modified,origin?}]`),
`schematic_file_<id>` (voller Zustand im Format von `collectState()`, also
inkl. Simulations-Setup) und `schematic_current_file`. Autosave
(`saveSchematic()`) schreibt nur den Key der aktuellen Datei. Das alte
Einzel-Autosave `schematic_state` wird beim Start einmalig migriert.
`collectState()`/`applyState()` sind die gemeinsame Basis fuer SVG-Export,
Autosave und Dateiwechsel.

- LOAD legt die Datei unter ihrem Dateinamen als neue interne Datei an.
- NEW SCHEMATIC (frueher CLEAR) legt eine leere interne Datei an, die alte
  bleibt erhalten.
- Download einer **nicht** aktuellen internen Datei: `downloadInternalFile()`
  tauscht den Zustand kurz ein, exportiert (die Zeichnung kommt aus dem
  Live-Canvas) und stellt Editor-Zustand, Undo-Stack und View danach wieder her.

**Global (Projekt).** `library/library.toml` beschreibt die Vorlagen,
die SVGs liegen daneben in `library/`. Format:

```toml
[library]
name = "..."
version = "1.0.0"      # Gesamtversion, bei jeder Aenderung erhoehen

[[schematic]]
file = "rc_lowpass.svg"
name = "RC Low-Pass Filter"
description = "..."
version = "1.0.0"      # bei Aenderung dieses Schematics erhoehen
```

`parseTOML()` in `js/app.js` versteht nur diese Teilmenge (Kommentare, Tabellen,
`[[Arrays]]`, Strings/Zahlen/Bools). OPEN kopiert eine Vorlage in den internen
Speicher (`origin={file,version}`); weicht die Version in der TOML spaeter ab,
zeigt der Dialog "vX available". Die Bibliothek wird per `fetch()` geladen
(also nicht ueber `file://`) und vom Deploy-Workflow mit veroeffentlicht.

## 10. Leistungsanalysator PA-4

Ein simuliertes Messgeraet (4 Elemente: Dreiphasengruppe CH1..CH3 plus
unabhaengiger CH4), das das Ergebnis der letzten Transientenanalyse auswertet.
Theorie, Formeln, Herstellervergleich (Yokogawa WT, Hioki PW3390, IEEE 1459)
und Entscheidungen stehen in [PLAN-LEISTUNGSANALYSATOR.md](PLAN-LEISTUNGSANALYSATOR.md);
hier nur die Code-Architektur.

**Drei Dateien, bewusst entkoppelt** (Ladereihenfolge nach `simulation.js`):

| Datei | Rolle | Kennt TurmericLab? |
|---|---|---|
| `js/power-analyzer-core.js` | Messkern `PowerAnalyzer.Instrument`: Sync (Schmitt-Trigger auf Nulldurchgaengen), Messintervalle, Grundgroessen, Grundschwingungs-DFT, Mittelung, Σ-Formeln, Bereiche/OVR | nein, kein DOM, laeuft auch in Node/Worker |
| `js/power-analyzer-ui.js` | Modaler Dialog (`PowerAnalyzer.createUI`): Bedienleiste, Tabelle, Wellenform-/Trend-Plot (uPlot), Zeigerdiagramm, Kanalzuordnung | nein, nur ueber das Datenquellen-Interface |
| `js/power-analyzer-sim.js` | Datenquelle auf Basis von `simLastResult`/`S.probes`/Formeln, Probe-Weiterleitung, Persistenz | ja (Glue) |
| `js/power-analyzer-worker.js` | Web Worker: `Instrument.run()` fuer grosse Datensaetze (laedt nur den Kern per `importScripts`) | nein |

Styles in `css/power-analyzer.css` (Praefix `.pa-`, faellt auf die
TurmericLab-Variablen zurueck, wenn vorhanden).

**Datenquellen-Interface** (das, was spaeter eine echte Hardware-Anbindung
implementieren wuerde): `listSignals(kind)`, `acquire(cfg)` →
`{rec, fs, maxStep, warnings}` oder `{error}`, optional `beginPick`/`endPick`
(interaktive Zuordnung), `suggestChannels()`, `hasSignal(id)`. Ein Record ist
**aequidistant** abgetastet (`{t0, dt, n, u[4], i[4]}`); `acquire()` resampelt
dafuer die adaptiven ngspice-Zeitschritte linear auf die Geraete-Abtastrate.
Der Kern selbst ist blockweise ausgelegt (`append()`/`flush()`), die Simulation
speist nur alles in einem Block ein.

**Ergebnis-Konvention:** `values['<Groesse>:<Spalte>']`, Spalte `1`..`4` oder
`S` fuer Σ, Groessen-Katalog in `PowerAnalyzer.QUANTITIES`. Die UI rendert nur
aus dieser Map, damit auch reine Messwert-Quellen (SCPI liefert fertige
Numerik) angeschlossen werden koennen.

**Signal-IDs** in der Kanalzuordnung (persistiert, stabil ueber Laeufe):
`v:<net>`, `vd:<a>|<b>`, `ip:<compId>:<pinIdx>` (gleiche Vorzeichenlogik wie
der Strom-Probe des Plots, `resolveCurrentProbe()`), `vec:<name>`,
`f:<Formelname>`. Formeln sind hier erlaubt (anders als bei `.measure`), weil
die Auswertung clientseitig laeuft.

**Haken in den bestehenden Dateien** (alle per `typeof`-Guard, die App laeuft
auch ohne die PA-Dateien):

- `toggleProbeAt()`/`addDiffProbe()`: zuerst `paHandleProbeClick/-Drag()`.
  Waehrend der Zuordnung gehoert der Klick dem Analysator, die Plot-Probes
  bleiben unberuehrt. Im Spannungsmodus zaehlt immer das Netz (auch auf einem
  Pin), im Strommodus nur ein Bauteil-Pin.
- `finishRun()` → `paNotifyData()`: offener Dialog wertet neu aus.
- Globaler `keydown`-Guard → `paIsModal()`: keine Editor-Kuerzel hinter dem
  Dialog. Im Zuordnungsmodus (Dialog zur Leiste eingeklappt) sind sie aktiv.
- `collectState()`/`applyState()` → `sim.powerAnalyzer`. Ein Schematic ohne
  eigene Analysator-Konfiguration verwirft die Kanalzuordnung (Netze/Bauteile
  des vorherigen Schematics), behaelt aber die Geraeteeinstellungen.
  Zusaetzlich liegt die Konfiguration global in `localStorage['pa_config']`.

**Phase-4-Funktionen** (alle im Kern, Bedienung im Setup- und Harmonics-Tab):

- *Harmonische:* Jedes synchronisierte Intervall wird auf Np Punkte pro
  Periode umgetastet (PLL-Abtastung, Np = Zweierpotenz ≥ 4·(Ordnung+1)),
  danach eine DFT je Ordnung 0..N (Standard N = 50, max. 100). Die Zeiger
  werden um k·φref gedreht, damit sie ueber Intervalle mittelbar sind
  (Konvention φ(k) − k·φ(1), Kosinus-Bezug). Gemittelt wird wie am Geraet nur
  exponentiell. THD kommt dann aus den Ordnungen 2..N, ohne Harmonische
  breitbandig aus Urms, Udc und U(1). Anzeige ueber `PowerAnalyzer.harmonics(prim, 'U'|'I'|'P', e)`.
- *Energie-Integration:* laeuft kontinuierlich vom Integrationsstart bis zu
  jedem Anzeige-Update (`_integrate()`), unabhaengig von den Messintervallen
  und nicht gemittelt: WP, WP+, WP−, q, q+, q−, Integrationszeit; Σ als Summe
  der Elemente, die auch in PΣ eingehen.
- *Realistischer Eingang* (`cfg.adc`, standardmaessig aus): Tiefpass 1. Ordnung,
  Rauschen (fester Seed, also reproduzierbar, auch im Worker), Begrenzung auf
  ±CF·Bereich und Quantisierung. Greift in `prepare()`, also vor allen
  Berechnungen und auch fuer die Wellenformanzeige.
- *Quadratische RMS-Mittelung* (`cfg.avg.rmsQuad`): mittelt U², I² statt U, I.
- *Worker:* ab 1 Mio. Abtastwerten (Signale × Samples) rechnet
  `power-analyzer-worker.js`; die Seite haengt die gelieferte Historie mit
  `Instrument.attach()` an eine eigene Instanz, die die vorbereiteten Samples
  fuer Wellenform, Cursor und Cursorfenster haelt. Ein neuer Auftrag beendet
  einen laufenden; schlaegt der Worker fehl (z.B. ohne HTTP-Server), wird
  synchron gerechnet.

**Test:** `node poc/pa-core-test.js` prueft den Kern gegen die
Referenzfaelle aus dem Plan (Sinus an R, RL/RC, Verzerrung, symmetrische und
unsymmetrische Drehstromlast in 3P4W/3P3W/3V3A, DC-Kanal mit Wirkungsgrad,
Mittelung, Betrieb ohne Sync, Harmonische, Energie, quadratische Mittelung,
ADC-Stufe, `attach()`).

**Stolpersteine:**

- Simulationen starten und enden oft exakt auf einem Nulldurchgang. Der
  Schmitt-Trigger laeuft deshalb ab Datenbeginn (Nulldurchgaenge vor `tStart`
  werden erst bei der Intervallbildung verworfen), und ein steigender
  Nulldurchgang am ersten bzw. letzten Sample wird per Extrapolation
  erkannt. Sonst fehlen erste und letzte Periode.
- Die Frequenz pro Kanal (`fU`, `fI`) braucht mindestens zwei Nulldurchgaenge;
  ihr Torfenster reicht deshalb zwei Intervalllaengen zurueck.
- uPlot-Legenden sind direkt nach dem Erzeugen kurzzeitig sehr hoch; die
  CSS-Kappung (`max-height:44px`) macht die Plotgroesse unabhaengig vom
  Layout-Zeitpunkt.

## 11. Parameter und Parameter-Sweeps

**Datenmodell.** `S.params` (Schaltplanebene, in `collectState()`/`applyState()`
mitgespeichert, nicht im Undo-Stack) ist eine Liste
`{id, name, value, step:{on, type:'lin'|'dec'|'oct'|'list', start, stop, inc, pts, list}}`.
Bearbeitet wird sie im modalen Dialog hinter dem **PARAMS**-Button der
Headerbar (`js/params.js`). Jeder Eintrag erzeugt eine Zeile `.param name=value`
in `generateNetlist()`; in Wertefeldern verwendet man `{name}`. Die schon
vorhandene `param`-Komponente funktioniert weiter. Gibt es denselben Namen im
Dialog, gewinnt der Dialog (kein doppeltes `.param`).

**ƒ-Button.** `renderProps()` haengt neben jedes freie Textfeld (ausser
`PARAM_BTN_SKIP_KEYS`) einen Button, der ein Menue mit allen Parametern oeffnet
und `{name}` einfuegt (Auswahl ersetzt, Caret in Ausdruck fuegt ein, einfacher
Zahlenwert wird ersetzt). Das Feld bekommt ein normales `input`-Event, es gibt
keinen eigenen Speicherpfad.

**Sweep ohne `.step`.** eecircuit-engine liefert aus einer Raw-Datei mit
mehreren Plots nur den ersten. Deshalb laeuft der Sweep in der App:
`buildStepPlan()` (netlist.js) bildet das kartesische Produkt aller Parameter
mit `step.on` (erster Parameter im Dialog = aeusserste Schleife, Limit
`PARAM_MAX_RUNS`), `runSimulation()` (simulation.js) baut pro Lauf eine eigene
Netzliste (`buildFullNetlist(paramValues)` ueberschreibt die `.param`-Zeilen)
und schickt sie nacheinander an dieselbe Engine (`dispatchPlanRun()`,
`onEngineResult()`). Das funktioniert fuer .tran, .ac, .dc und .op gleich, und
`.measure`-Ergebnisse stehen im Info-Text jedes einzelnen Laufs (der Text ist
pro Lauf frisch). Der Watchdog (90 s) gilt je Lauf.

**Ergebnisse.** `simRuns = {names, runs:[{assign, label, result, info}]}`,
`simLastResult` bleibt der erste Lauf, damit alles, was "ein Ergebnis"
erwartet (Signalliste, Power Analyzer, Cursor-Helfer), unveraendert arbeitet.
`m.results[]` haelt je Messung ein Ergebnis pro Lauf, `m.result` das des ersten.

**Kurvenschar.** `plotResult()` ruft `buildFamilySeries()`: pro Signal und Lauf
eine Kurve. Transientlaeufe haben unterschiedliche (adaptive) Zeitraster, daher
liegen alle Laeufe auf der Vereinigung der x-Werte, fehlende Samples sind
`null` und `spanGaps:true` verbindet. Ein Signal: Farbe = Lauf. Mehrere
Signale: Farbe = Signal, Strichart = Lauf (`STEP_DASHES`).

**Measurement-Report.** Bei einem Sweep zeigt der Dialog zusaetzlich eine
Tabelle Lauf x Messung und einen Plot Messwert ueber Parameter
(`drawReportPlot()`); bei mehreren gesweepten Parametern waehlt man den
x-Parameter, die uebrigen bilden Kurvengruppen. Dezimal-/Oktav-Sweeps starten
mit logarithmischer x-Achse.

**Fallstricke.**
- `{name}` darf nicht in einem weiteren `{...}` stehen (ngspice). Wo ein
  Nutzerwert in einen Ausdruck gespleisst wird (Rampen-PWL, Transformator-L),
  entfernt `stripBraces()` die Klammern.
- Der Load-Mode (B-Quelle) nimmt `{name}` im Wert, getestet mit `.dc`.
- Eine unabhaengige I-Quelle kennt in `.save` nur `@iref[current]`, nicht
  `[i]`; `[i]` laesst den WASM-Build haengen (siehe `buildSaveVectors()`).

**Beispiele.** `library/param_load_sweep.svg` (DC-Sweep, Load-Mode-Quelle,
Strom als Parameter) und `library/param_rc_sweep.svg` (RC, R dezadisch
gesweept, Anstiegszeit ueber R im Report-Plot).

## 11a. Simulation: Fortschritt, .ac und .measure

- **Sweep-Fortschritt.** `simStatus(msg,pct)` faerbt den Statusstreifen als
  Fortschrittsbalken (CSS-Variable `--pct`). Waehrend eines Sweeps zeigt der
  Ticker (`startSimTicker()`) "Step i/n · % · ~Restzeit". Die Engine meldet
  keinen Fortschritt innerhalb eines Laufs; der Anteil des laufenden Laufs wird
  aus der Durchschnittsdauer der fertigen geschaetzt (bei 99 % gedeckelt,
  `plan.durs`, `plan.runT0`).
- **`.ac` und `.save`.** Im WASM-Build haengt jeder `@dev[...]`-Vektor in einer
  `.ac`-Analyse die Engine auf ("no writable vector found"). Deshalb fordert
  `buildSaveVectors(acOnly)` dort nur `i(Vquelle)` an; `buildFullNetlist()`
  erkennt `.ac` in Analysekarte oder Direktiven.
- **`.measure` und Stromvektoren.** Der Plot nennt Geraetestroeme `i(@l1[i])`,
  `.measure` kennt nur `@l1[i]` (mit dem `i(...)`-Mantel schlaegt es stumm
  fehl). `measureSigForSpice()` entfernt den Mantel in allen Signalfeldern
  der Messung, bevor die Direktive geschrieben wird.

## 12. Probe-Modus: Senken, Power-Probe, Gleichungen

**Klick-Prioritaet im Probe-Modus.** Pin vor Bauteilkoerper: `onCompDown()`
prueft zuerst `findPin(…,18)`; liegt ein Pin im 18-px-Radius (groesser als der
9-px-Pin-Ring), wird der Pin geprobt (Strom-Probe). Nur sonst gilt der Klick
dem Bauteil. Die Hover-Anzeige folgt derselben Grenze: der gestrichelte Rahmen
(`.power-probe-hover`) erscheint nur ueber dem Koerper, nahe am Pin uebernimmt
der Strompfeil (`drawCurrentProbeMarker`).

**Power-Probe** (`togglePowerProbe()` in simulation.js). Klick auf den Koerper
eines einfachen Bauteils legt eine Formel `P(<Ref>)` in `simFormulas` an
(Feld `powerOf` = Bauteil-ID), zweiter Klick entfernt sie. Gleichungen:
Zweipole (R, Diode, LED, Z-Diode, Schalter) `(V(a)-V(b))*I(ref)`; BJT
`Vce*I(ref.C)+Vbe*I(ref.B)`; MOSFET `Vds*I(ref.D)`. Masse-Knoten entfallen.
Nicht unterstuetzt: C, L, Trafo (speichern nur), Quellen, ICs/Subcircuits.
Die Netznamen sind in der Formel nur eine Momentaufnahme: unbenannte Netze
werden bei Umbauten umnummeriert. Deshalb leitet `refreshPowerFormulas()` am
Anfang jedes Laufs (`runSimulation()`) Ausdruck und Namen neu aus dem Bauteil
ab und entfernt die Probe, wenn das Bauteil fehlt oder beide Anschluesse auf
Masse liegen. Editiert der Nutzer den Ausdruck von Hand, wird `powerOf`
geloescht und die Formel ist eine normale. Fuer die Transistorstroeme gibt es
Formel-Aliase `I(ref.PIN)` (`formulaAliases()`, nur Pins mit Vorzeichen +1).

**Alternative Probe-Senken.** Ein Probe-Klick kann statt eines Plot-Probes ein
Signal in ein Eingabefeld schreiben. Solange eine solche Senke aktiv ist, wird
der Plot nicht veraendert (`S.probes` und `simFormulas` bleiben unberuehrt,
Komponentenklick loest keine Power-Probe aus):
- **Measurement-Dialog** (`simMeasureDraft`): `probeIntoMeasurement()` /
  `probeDiffIntoMeasurement()` fuellen nur das Signalfeld.
- **Equation-Feld** einer Behavioural-Quelle: Properties mit `eq:true`
  (`beh_eq`) merken sich das zuletzt fokussierte Feld in `eqTarget`
  (app.js, wird bei jedem `renderProps()` zurueckgesetzt). `probeIntoEquation()`
  fuegt `v(net)`, per Drag `v(a,b)` bzw. Stroeme (siehe Kapitel 13) an der
  Caret-Position ein und loest ein `input`-Event aus, sodass `comp[key]` live
  folgt. Hinweis bei unbenannten Netzen (`nNNN`), weil deren Nummer instabil ist.
Beim Testen per Skript ist zu beachten: ohne Fenster-Fokus (`document.hasFocus()`)
feuert `el.focus()` kein `focus`-Event.

## 13. Behavioural-Quellen: Gleichungen und Geraetestroeme

Mode `BEHAV` einer Quelle erzeugt `E…` (Anzeige Spannung) mit `vol='…'` bzw.
`G…` (Anzeige Strom) mit `cur='…'`. **`cur=` an einer E-Quelle laesst den
WASM-Build haengen**, das war ein frueherer Fehler in `generateNetlist()`.

ngspice kennt in B/E/G-Ausdruecken nur `v(n)`, `v(a,b)` und `i(Vquelle)`;
`@r1[i]` wird nicht akzeptiert (Engine haengt). Wie in LTspice sollen aber
Bauteilstroeme nutzbar sein. `injectDeviceCurrentSenses()` (netlist.js, laeuft
am Ende von `generateNetlist()`) erledigt das als Nachbearbeitung der Zeilen:

- Syntax: `i(R1)` (R, C, L, Diode, LED, Z-Diode: Strom in den ersten Pin,
  zweiter Pin `-i(R1)`), `i(Q1.C|B|E)`, `i(M1.D|G|S)`. Name = Label oder
  SPICE-Referenz, Gross-/Kleinschreibung egal.
- Pro benutzter Klemme wird der entsprechende Knoten der Bauteilzeile durch
  `<key>_sns` ersetzt und `VSNS_<key> <orig> <key>_sns 0` eingefuegt; im
  Ausdruck steht dann `i(VSNS_<key>)`. Elektrisch ohne Wirkung, im Schaltplan
  unsichtbar. Die Gleichung ist erlaubt in `cur=`/`vol=`/`I=`/`V=` mit
  Hochkommas (Funktionsblock `mathblk` und PWM-Subcircuits sind nicht betroffen,
  sie liegen in Subcircuits und sehen die Netze des Schaltplans nicht).
- Nicht abgedeckt: Schalter, Trafo, ICs. Dort bleibt nur der Umweg ueber eine
  0-V-Quelle in Reihe.
- Beim Probe-Klick auf einen Pin im Equation-Feld wird bei Spannungsquellen
  `i(vname)`, bei den obigen Bauteilen `i(Label)` bzw. `i(Label.PIN)` eingefuegt.

Beispiel: `library/current_source.svg` (CS4, `i(R1)+i(R2)+i(R3)`).

## 14. Transient ohne Gleichstrompfad (UIC)

Knoten, die nur ueber Kondensatoren und Stromquellen mit Masse verbunden sind
(z. B. thermische RC-Leiter an einer Stromquelle), haben keinen
Arbeitspunkt: ngspice meldet "singular matrix", scheitert an allen Hilfsverfahren
und startet mit einem unbrauchbaren "Transient op". `findFloatingDcNodes()`
(simulation.js) bildet aus den Zeilen der generierten Netzliste einen
Union-Find-Graphen (C und I zaehlen als offen; alle anderen Elemente verbinden
grosszuegig alle ihre Knoten, Subcircuit-Rumpfe werden ignoriert, damit es
nie zu Fehlalarmen kommt). `buildFullNetlist()` haengt bei `.tran` und
Treffern automatisch `uic` an und schreibt eine Notiz ins Log. Fuer `.op`,
`.ac`, `.dc` bleibt es bei der ngspice-Meldung. Die Standard-Schrittweite
(`Tstep`) ist 50n, weil PWM-Quellen sonst nicht zuverlaessig aufgeloest werden;
die Standard-Totzeit des PWM-Generators ist 200n.

## 15. Editor-Verhalten (Kopieren, Routing, Verschieben, Info-Dialog)

- **Copy/Paste:** `computePasteLabels()` vergibt neue Referenzen, ausser fuer
  `netconn` und `textlabel`: dort ist `label` der Inhalt (Netzname bzw. Text)
  und bleibt erhalten; ein Net Connector leitet seinen Namen weiterhin ueber
  `applyNetConnName()` vom Netz ab, auf dem er landet.
- **Netzname am Segment:** steht auf dem laengsten waagrechten Element der
  Leitung, nur bei rein senkrechten Leitungen gedreht (`renderWires()`).
- **Leitungsstart:** `buildWirePath()` fuehrt das erste Teilstueck immer entlang
  der Pinachse (`startDir`: senkrechter Pin = senkrecht zuerst), auch mit
  Wegpunkten; alle weiteren Teilstuecke wie bisher waagrecht zuerst.
- **Gruppen-Verschieben:** `onDragMove()` verschiebt zuerst Bauteile und
  Junctions (`moveComp`/`moveJunc` routen angehaengte Leitungsenden neu) und
  uebersetzt danach die Leitungen komplett aus ihren Startpunkten, ausser sie
  haengen mit einem Ende an etwas, das stehen bleibt (dann bleibt dieses Ende
  verankert). Unmarkierte Leitungen, die nur zwischen verschobenen Teilen
  verlaufen, werden beim Start des Drags (`startDrag()`) mit aufgenommen.
- **Info-Dialog:** Klick aufs Logo (`showAbout()`) zeigt Version, Git-Commit
  und Build-Datum aus `window.APP_BUILD` (`js/version.js`). Lokal gilt der
  Default "local build"; der Workflow `deploy-pages.yml` ueberschreibt die Datei
  im Pages-Output (Schritt "Write build info": Release-Tag bzw. Branchname,
  `github.sha`, Build-Datum). `version.js` wird vor allen anderen Skripten
  geladen.

## Quellen (NGSpice / WASM)

- Ngspice User's Manual v46 (HTML): <https://ngspice.sourceforge.io/docs/ngspice-html-manual/manual.xhtml>
- Power MOSFET (VDMOS) Modell: <https://nmg.gitlab.io/ngspice-manual/mosfets/powermosfetmodel_vdmos.html>
- Switch Model (SW/CSW): <https://nmg.gitlab.io/ngspice-manual/circuitelementsandmodels/elementarydevices/switchmodel_sw_csw.html>
- README.vdmos (imr/ngspice): <https://github.com/imr/ngspice/blob/master/README.vdmos>
- EEcircuit (WASM-Simulator): <https://github.com/eelab-dev/EEcircuit>
- danchitnis/ngspice (WASM-Tooling): <https://github.com/danchitnis/ngspice>
- NGSpice WASM-Build Patch #99: <https://sourceforge.net/p/ngspice/patches/99/>
