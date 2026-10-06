# Plan: Virtueller Leistungsanalysator für TurmericLab

> Stand: 2026-10-06. Reines Vorbereitungsdokument, **keine Implementierung**.
> Liegt im Scratchpad, bis die parallelen Themen abgeschlossen sind.

---

## 1. Ziel und Abgrenzung

Ein in die Simulation eingebundenes Messgerät, das sich wie ein echter
Leistungsanalysator anfühlt (Messintervalle, Update-Rate, Mittelung, Hold,
Bereichsüberschreitung, Σ-Funktionen, Zeigerdiagramm) und dessen Oberfläche so
gekapselt ist, dass sie später als Frontend für ein reales Gerät dienen kann.

**Im Umfang:**

- 4 Messkanäle (Elemente) mit je Spannung + Strom.
- Kanäle 1 bis 3 als Gruppe für einphasig, dreiphasig 3-Leiter, dreiphasig 4-Leiter.
- Kanal 4 unabhängig (typisch DC-Zwischenkreis bzw. Eingang eines Umrichters).
- Pro Kanal: RMS, Gleichrichtwert, DC-Mittelwert, AC-Anteil, Spitzenwerte,
  Crest-/Formfaktor, P, S, Q, λ, φ, Frequenz, Grundschwingungsgrößen, THD.
- Σ-Werte der Dreiphasengruppe, Wirkungsgrad Kanal 4 gegen Σ.
- Tabelle + Plot (Wellenform und Trend), Cursor zeigt Werte zum Zeitpunkt t.
- Zeigerdiagramm für dreiphasige Auswertung.
- Kanalzuordnung über Probe-Modus oder Signalliste.

**Nicht im ersten Umfang (später möglich):**

- Vollständige Oberschwingungsanalyse nach EN 61000-4-7 (Gruppierung, Interharmonische).
- Motor-Auswertung (Drehzahl/Moment), Energie-Integration (Wh, Ah).
- Echtzeit-Streaming während der Simulation (hängt am Shared-API-PoC, siehe
  `POC-ECHTZEIT-NGSPICE.md` im Repo).
  Die Architektur wird aber bereits blockweise/streamingfähig ausgelegt.

---

## 2. Marktrecherche: Was reale Geräte zeigen

| Gerät | Auffälligkeiten, die wir übernehmen sollten |
|---|---|
| **Yokogawa WT5000 / WT1800E / WT500** | Messfunktionen pro Element: `Urms, Umn, Udc, Urmn, Uac`, gleiches für I, `P, S, Q, λ, φ, Pc`, Spitzenwerte `U+pk, U-pk`, Crest-/Formfaktor `CfU, CfI, FfU, FfI`, Frequenzen `fU, fI`, alles auch als Σ. Konfigurierbare **Data Update Rate** (10 ms bis 20 s), **Sync Source** (U, I eines Elements, Ext, None), **Mittelung** exponentiell (Dämpfungskonstante K) oder gleitend (N Werte). Numerik-Ansicht mit 4/8/16/alle Werte, Wellenform-, Trend- und Vektoransicht. Verdrahtungsmodi 1P2W, 1P3W, 3P3W, 3V3A, 3P4W, Gruppen A/B. Vorzeichen von Q und φ aus Lead/Lag. |
| **Hioki PW8001 / PW3390** | Verdrahtung 1P2W, 1P3W, **3P3W2M** (Aron/Zwei-Wattmeter, fehlende Leitergröße per Vektorrechnung ergänzt), **3P3W3M** (drei Leiterspannungen, per Vektorrechnung in Strangspannungen umgerechnet), 3P4W. Ausgeprägte **Vektoransicht** mit Tabelle der Grundschwingungsamplituden/-winkel, Unsymmetrie (Unb), Drehfeldrichtung. Mittelung exponentiell oder linear. |
| **ZES Zimmer LMG600 (heute R&S)** | **Zyklussynchrone Messung**: Messintervall wird auf ganze Signalperioden der Sync-Quelle gerundet (Zykluszeit min. 10 ms). Duale Pfade (Breitband / Schmalband für Grundschwingung/Harmonische). Viele Ansichten parallel, frei konfigurierbare Wertetabellen. |
| **Tektronix PA4000** | Einfache, große Numerik mit frei wählbarer Werteliste je Kanal, Σ-Spalte. Gut als Vorbild für Lesbarkeit. |

**Gemeinsame UI-Muster:**

1. Kopfzeile mit Verdrahtung, Messbereichen, Sync-Quelle, Update-Rate, Mittelung, Status-LEDs (`OVR`, `SYNC`, `AVG`, `HOLD`).
2. Numerik als Matrix: Zeilen = Messgröße, Spalten = Element 1..n + Σ.
3. Wellenform (u, i je Element) und Trend (ausgewählte Numerikwerte über die Zeit).
4. Vektoransicht mit Grundschwingungszeigern, separaten Skalen für U und I, Begleittabelle.
5. `HOLD` friert die Anzeige ein, `SINGLE` löst genau ein Messintervall aus.
6. Bereichsüberschreitung wird pro Wert markiert (`-OL-` bzw. blinkend), nicht verschwiegen.

---

## 3. Mathematische Grundlagen

### 3.1 Signalbasis: von ngspice zu Geräte-Abtastwerten

ngspice liefert in `.tran` **nicht äquidistante** Zeitpunkte (adaptive
Schrittweite, TRTOL). Ein reales Gerät liefert äquidistante Samples mit fester
Abtastrate `fs`. Damit der Gerätekern später 1:1 mit echter Hardware arbeiten
kann, gilt:

- **Der Kern rechnet ausschließlich auf äquidistanten Sample-Blöcken.**
- Der **Simulationsadapter** resampelt die ngspice-Vektoren auf `fs`
  (lineare Interpolation reicht, da ngspice zwischen Stützstellen ebenfalls
  linear interpoliert). Alle Vektoren teilen sich die ngspice-Zeitachse, das
  Resampling ist also pro Zeitpunkt nur eine Binärsuche + n Lerps.
- `fs` ist eine Geräteeinstellung (Default z.B. 1 MS/s bzw. automatisch
  `≥ 20 / tstep`). Simulierter Speicherbedarf: 8 Signale × 1 MS/s × 50 ms
  = 400 k Werte, unkritisch.
- Hinweis an den User, wenn `tmax` der `.tran` größer als `1/fs` ist (bei PWM
  sonst Aliasing/Schaltflanken verschliffen).

Optional (Phase 3, "realistischer Modus"): Quantisierung auf N Bit im
gewählten Messbereich, Bandbreitenbegrenzung (Tiefpass 1. Ordnung), Rauschen.
Default bleibt "ideal".

### 3.2 Messintervall und Synchronisation

Ein Leistungsanalysator berechnet alle Werte über ein **Messintervall**. Damit
RMS, P usw. bei periodischen Signalen nicht schwanken, wird das Intervall auf
eine **ganze Zahl von Perioden** der Sync-Quelle gelegt:

1. Sync-Quelle wählen: `U1`, `I1`, ..., `U4`, `I4`, `fest (f vorgeben)`, `keine`.
2. Sync-Signal DC-frei machen (Mittelwert über das Update-Intervall abziehen),
   optional Tiefpass (Line Filter / Frequency Filter).
3. Nulldurchgänge mit **Hysterese** (z.B. 5 % des Bereichs) detektieren,
   steigende Flanken, Zeitpunkt per linearer Interpolation zwischen zwei Samples
   (Subsample-genau).
4. Innerhalb eines Update-Intervalls `T_upd` (z.B. 50 ms, 100 ms, 200 ms, 500 ms,
   1 s, ... in Simulationszeit) das Intervall vom ersten bis zum letzten
   erkannten Nulldurchgang nehmen → `M` ganze Perioden.
5. Keine Periode erkannt (DC, zu niedrige Frequenz): ganzes `T_upd` verwenden,
   Status `SYNC`-LED rot, `f = ---`.

Frequenz: `f = M / (t_last - t_first)`.

Die Integration über nicht ganzzahlige Samples erfolgt mit Randgewichten
(Trapez mit interpolierten Rändern), damit kein Fehler von ±1 Sample/Periode
entsteht. Alternativ (Yokogawa EAMP-Ansatz) kann statt Periodensynchronisation
ein digitaler Tiefpass über die Momentanleistung gelegt werden; das ist als
späterer Modus interessant, nicht für Phase 1.

### 3.3 Grundgrößen pro Kanal (Spannung, analog für Strom)

Mit `N` Samples im Messintervall, `u[n]` Momentanwerte:

| Größe | Formel | Bezeichnung (Yokogawa-Stil) |
|---|---|---|
| Effektivwert | `Urms = sqrt( (1/N) Σ u[n]² )` | `Urms` |
| Gleichanteil | `Udc = (1/N) Σ u[n]` | `Udc` |
| Gleichrichtwert | `Urmn = (1/N) Σ |u[n]|` | `Urmn` |
| Gleichrichtwert, auf RMS kalibriert | `Umn = (π / (2√2)) · Urmn` | `Umn` (für Sinus gleich `Urms`) |
| AC-Anteil | `Uac = sqrt( Urms² - Udc² )` | `Uac` |
| Spitzenwerte | `U+pk = max u[n]`, `U-pk = min u[n]`, `Upp = U+pk - U-pk` | |
| Crestfaktor | `CfU = max(|U+pk|, |U-pk|) / Urms` | `CfU` (Sinus: √2 ≈ 1,414) |
| Formfaktor | `FfU = Urms / Urmn` | `FfU` (Sinus: π/(2√2) ≈ 1,111) |
| Frequenz | aus Nulldurchgängen (3.2) | `fU` |

`Umn` und `Urmn` sind beide üblich; `Umn` ist das, was ein "Mittelwert-Messgerät"
anzeigen würde, die Differenz zu `Urms` zeigt Verzerrung an.

### 3.4 Leistungsgrößen pro Kanal

Momentanleistung `p[n] = u[n] · i[n]`.

| Größe | Formel | Anmerkung |
|---|---|---|
| Wirkleistung | `P = (1/N) Σ u[n]·i[n]` | exakt, unabhängig von Kurvenform |
| Scheinleistung | `S = Urms · Irms` | |
| Blindleistung (Gerätedefinition) | `Q = s · sqrt( S² - P² )` | `s = +1` induktiv (I eilt nach), `s = -1` kapazitiv; enthält Verzerrungsblindleistung. Bei Yokogawa und Hioki identisch (verifiziert, siehe 3.5.2) |
| Leistungsfaktor | `λ = P / S` | optional mit Vorzeichen `s·|P/S|` (Hioki-Stil) |
| Phasenwinkel | `φ = s · arccos|λ|`, bei `P < 0`: `s · |180° - arccos|λ||` | Anzeige mit `G`/`D` bzw. `ind`/`kap` |
| Grundschwingungs-Blindleistung | `Q1 = U1 · I1 · sin(φ1)` | nach DIN 40110 / IEEE 1459 |
| Verschiebungsfaktor | `cos φ1 = P1 / S1` | |
| Verzerrungsleistung | `D = sqrt( S² - P² - Q1² )` | Budeanu-Rest, informativ |

**Vorzeichen `s`:** aus der Phasendifferenz der Grundschwingungen
`φ1 = arg(U1) - arg(I1)` (Bereich -180°..180°). `φ1 > 0` → induktiv.

**Grundschwingung per Einzel-DFT** über `M` ganze Perioden (Np Samples/Periode,
`N = M · Np`):

```
X1 = (2/N) Σ x[n] · e^(-j·2π·M·n/N)        komplexe Amplitude
X1_rms = |X1| / √2,   arg(X1) = Phasenwinkel relativ zum Intervallstart
```

Wegen Resampling ist `Np` im Allgemeinen nicht ganzzahlig; dann entweder die
DFT als Integral mit Trapezregel über die exakten Intervallgrenzen rechnen oder
pro Messintervall gezielt auf `Np = 2^k` Samples/Periode nachresampeln (sauberste
Lösung, wie viele Geräte mit PLL-Abtastung). Empfehlung: **PLL-Resampling pro
Intervall** im Kern als Option, weil es dann auch die Harmonischen-Analyse (FFT)
trägt.

THD (bezogen auf Grundschwingung, `IEC`):
`THD_U = sqrt( Urms² - Udc² - U1² ) / U1` (Gesamtverzerrung ohne DC-Anteil,
Bandbreite = Abtastrate; die bandbegrenzte Variante bis zur 40./50. Harmonischen
kommt mit Phase 3).

### 3.5 Dreiphasige Verdrahtungen

Kanäle 1..3 bilden Gruppe Σ. Bezeichnungen L1/L2/L3 bzw. Phase a/b/c.

#### 3.5.1 Verdrahtungsmodi und Elementbelegung

Bei Yokogawa liegt 3P3W auf den Elementen 1 und 3, bei Hioki (3P3W2M) auf CH1 und
CH2. Wir nehmen die Hioki-Belegung (Elemente 1 und 2), weil Element 3 dann für
die berechnete dritte Leitergröße frei bleibt und die Tabelle lückenlos ist.

| Modus (Yokogawa / Hioki) | Messung | Elemente | PΣ |
|---|---|---|---|
| `1P2W` | je Kanal unabhängig | 1, 2, 3 einzeln | keine Gruppe |
| `3P4W` | Strangspannungen `u1N, u2N, u3N`, Leiterströme | 1, 2, 3 | `PΣ = P1 + P2 + P3` |
| `3P3W` / `3P3W2M` (Aron) | `u13, u23` und `i1, i2` | 1, 2 | `PΣ = P1 + P2` |
| `3V3A` / `3P3W3M` | alle drei Leiterspannungen + alle drei Ströme | 1, 2, 3 | siehe 3.5.2 |

Fehlende Größen per Kirchhoff (auf Momentanwerten, nicht nur auf Zeigern):

- 3-Leiter: `i3 = -(i1 + i2)`, `u12 = u13 - u23`.
- Leiter- aus Strangspannungen (3P4W): `u12 = u1N - u2N` usw.
- Strang- aus Leiterspannungen (3V3A, gedachter Sternpunkt). Hioki macht das
  pro Sample: `u1N = (u12 - u31) / 3`, `u2N = (u23 - u12) / 3`, `u3N = (u31 - u23) / 3`
  (verifiziert, PW3390 Kap. 10.6). Für 3P3W2M zeigt Hioki die Werte der
  Einzelkanäle ausdrücklich nur als "Zwischenergebnisse"; aussagekräftig sind
  allein die Summenwerte. Das übernehmen wir als Hinweis in der Tabelle
  (Einzelwerte gedimmt).

#### 3.5.2 Σ-Formeln der Hersteller (verifiziert)

**Yokogawa** (Handbuch IM WT310-01EN, Appendix 1; die Σ-Werte gelten so für die
ganze WT-Serie, TYPE 1):

| Größe | 1P3W | 3P3W | 3V3A | 3P4W |
|---|---|---|---|---|
| UΣ | `(U1+U3)/2` | `(U1+U3)/2` | `(U1+U2+U3)/3` | `(U1+U2+U3)/3` |
| IΣ | `(I1+I3)/2` | `(I1+I3)/2` | `(I1+I2+I3)/3` | `(I1+I2+I3)/3` |
| PΣ | `P1+P3` | `P1+P3` | `P1+P3` | `P1+P2+P3` |
| SΣ | `S1+S3` | `(√3/2)(S1+S3)` | `(√3/3)(S1+S2+S3)` | `S1+S2+S3` |
| QΣ | `Q1+Q3` | `Q1+Q3` | `Q1+Q3` | `Q1+Q2+Q3` |
| λΣ, φΣ | `PΣ/SΣ`, `cos⁻¹(PΣ/SΣ)` | | | |

Plausibilisierung für ein symmetrisches System mit Leiterspannung `UL` und
Strom `I`: 3P3W `(√3/2)·2·UL·I = √3·UL·I`, 3V3A `(√3/3)·3·UL·I = √3·UL·I`. Passt.

**Yokogawa: drei Rechenarten für S und Q** (Features Guide IM WT5000-01EN,
Kap. 8; FAQ "Type1 vs Type2"), wählbar am Gerät:

| Typ | Pro Phase | Σ |
|---|---|---|
| TYPE 1 (klassisch) | `S = U·I`, `Q = s·sqrt(S² - P²)` | `SΣ = ΣS`, `QΣ = ΣQ` (vorzeichenbehaftet) |
| TYPE 2 | `S = U·I` | `SΣ = ΣS`, `QΣ = sqrt(SΣ² - PΣ²)` (keine Lead/Lag-Erkennung nötig) |
| TYPE 3 (aus Harmonischen) | `Q` direkt aus Oberschwingungen | `QΣ = ΣQ`, `SΣ = sqrt(PΣ² + QΣ²)` |

Bei TYPE 1 kann die Lead/Lag-Erkennung bei stark verzerrten Signalen versagen
und QΣ verfälschen; deshalb gibt es TYPE 2. Beim WT300 ist zusätzlich wählbar,
ob `S` aus `Urms·Irms`, `Umn·Irms` oder `Udc·Idc` gebildet wird.

**Hioki** (Bedienungsanleitung PW3390, Kap. 10.6 "Specifiche della formula di
calcolo"):

| Größe | 1P3W | 3P3W2M | 3P3W3M | 3P4W |
|---|---|---|---|---|
| U | `(U1+U2)/2` | `(U1+U2)/2` | `(U1+U2+U3)/3` | `(U1+U2+U3)/3` |
| P | `P1+P2` | `P1+P2` | `P1+P2+P3` (mit umgerechneten Strangspannungen) | `P1+P2+P3` |
| S TYPE1 | `S1+S2` | `(√3/2)(S1+S2)` | `S1+S2+S3` (Strangspannungen) | `S1+S2+S3` |
| S TYPE2 | | | `(√3/3)(U1·I1 + U2·I3 + U3·I2)` (Leiterspannungen, Hioki-Kanalzuordnung) | |
| Q TYPE1 | `Q1+Q2` | `Q1+Q2` | `Q1+Q2+Q3` | `Q1+Q2+Q3` |
| Q TYPE2 | | | `s·sqrt(S² - P²)`, `s` aus Q TYPE1 | |

Hioki-TYPE2 bei 3P3W3M ist ausdrücklich dazu da, mit dem 3V3A-Ergebnis anderer
Hersteller (also Yokogawa) übereinzustimmen. Bei Sinus sind TYPE1 und TYPE2
gleich, Unterschiede gibt es bei PWM mit Gleichrichtwert-Messung.

**Vorzeichenkonvention (beide Hersteller gleich):**

- `s = +1` bei nacheilendem Strom (induktiv, "LAG", ohne Vorzeichen angezeigt),
  `s = -1` bei voreilendem Strom (kapazitiv, "LEAD", mit "-").
- Hioki setzt das Vorzeichen auch auf λ: `λ = s·|P/S|`; Yokogawa zeigt λ
  ohne Vorzeichen und φ mit `G`/`D` (lag/lead).
- Hioki-Phasenwinkel: `φ = s·cos⁻¹|λ|` für `P ≥ 0`, sonst `s·|180° - cos⁻¹|λ||`
  (Rückspeisung landet im Bereich 90°..180°).
- Das Vorzeichen der Σ-Werte wird aus dem Vorzeichen von QΣ abgeleitet.

#### 3.5.3 Unser Σ-Umschalter

Daraus ergibt sich die Geräteeinstellung "S/Q-Formel":

| Einstellung | SΣ | QΣ | Zweck |
|---|---|---|---|
| `TYPE1` (Default) | Herstellerformel nach Verdrahtung (Tabelle Yokogawa) | `ΣQ` mit Vorzeichen | kompatibel zu üblichen Geräten |
| `TYPE2` | wie TYPE1 | `sqrt(SΣ² - PΣ²)` | robust bei Verzerrung |
| `TYPE3` | `sqrt(PΣ² + QΣ²)` | `ΣQ` (Q aus Grundschwingung bzw. Harmonischen) | vektoriell |
| `IEEE1459` | `Se = 3·Ue·Ie` | `sqrt(Se² - PΣ²)` (Nicht-Wirkleistung N) | unsymmetrische, verzerrte Lasten |

Da wir die Momentanwerte aller drei Phasen haben, rechnen wir bei 3V3A die
Leistung zusätzlich per Strangspannungen (Hioki-Weg) und können bei Bedarf
beide Ergebnisse vergleichen. Das ist ein Simulationsvorteil gegenüber echten
Geräten.

#### 3.5.4 IEEE 1459

IEEE 1459 effektive Größen:

```
4-Leiter:  Ie = sqrt( (I1² + I2² + I3² + IN²) / 3 )
           Ue = sqrt( ( 3·(U1N² + U2N² + U3N²) + (U12² + U23² + U31²) ) / 18 )
3-Leiter:  Ie = sqrt( (I1² + I2² + I3²) / 3 )
           Ue = sqrt( (U12² + U23² + U31²) / 9 )
```

`Se` beschreibt ein gedachtes symmetrisches System mit gleichen Leitungsverlusten
und ist für unsymmetrische, verzerrte Lasten die aussagekräftigste Größe.
`λΣ = PΣ / SΣ`.

#### 3.5.5 Zusätzliche Dreiphasengrößen

- **Symmetrische Komponenten** (Fortescue) aus den Grundschwingungszeigern,
  `a = e^(j120°)`:
  ```
  U0 = (U1 + U2 + U3) / 3
  U+ = (U1 + a·U2 + a²·U3) / 3
  U- = (U1 + a²·U2 + a·U3) / 3
  ```
  Spannungsunsymmetrie `u2 = |U-| / |U+|` (in %), analog für Strom.
  Hioki rechnet die Unsymmetrie ohne Winkel nur aus den drei
  Grundschwingungs-Leiterspannungen (Formel nach IEC 61000-4-30):
  ```
  β    = (U12⁴ + U23⁴ + U31⁴) / (U12² + U23² + U31²)²
  Uunb = sqrt( (1 - sqrt(3 - 6β)) / (1 + sqrt(3 - 6β)) ) · 100 %
  ```
  Beide Wege liefern dasselbe Ergebnis; die β-Formel braucht keine Winkel und
  dient im Kern als Gegenprobe.
- **Drehfeldrichtung**: Vorzeichen von `arg(U2) - arg(U1)` (≈ -120° → rechtsdrehend).
- **Neutralleiterstrom** (3P4W): `iN = -(i1 + i2 + i3)` sofern nicht separat gemessen.

### 3.6 DC-Kanal (Element 4) und Wirkungsgrad

Element 4 nutzt dieselbe Berechnung, sinnvoll sind dort `Udc, Idc, P` und die
Welligkeit `Uac`. Restwelligkeit wie bei Hioki:
`Urf = (U+pk - U-pk) / (2·Udc) · 100 %` (analog `Irf`).
Wirkungsgrad mit wählbarer Richtung:

- Wechselrichter: `η = PΣ / P4`
- Gleichrichter / PFC: `η = P4 / PΣ`
- Verlustleistung `Pv = |P_in - P_out|`

### 3.7 Mittelung

Verifiziert im WT5000 Features Guide (Kap. 6, "Averaging"):

- **Direkt gemittelt** werden `Urms, Umn, Udc, Urmn, Uac, Irms, Imn, Idc, Irmn,
  Iac, P, S, Q`, die Grundschwingungswerte (`Ufnd, Ifnd, Pfnd, Sfnd, Qfnd`) und
  die Frequenzen.
- **Aus den gemittelten Werten neu berechnet** werden `λ, φ, λfnd, φfnd, CfU,
  CfI` (aus gemitteltem Urms, Irms, P, S, Q).
- **Nicht gemittelt** werden Spitzenwerte (`U±pk, I±pk, P±pk`) und Energie-Integrale.
- Bei Harmonischen wird nur exponentiell gemittelt; `λ(k), φ(k)` kommen aus
  gemitteltem `P(k), Q(k)`.

So passt λ immer zu P/S. Abweichung von Yokogawa bei uns: RMS-Werte quadratisch
mitteln (`Urms²`), weil das bei schwankender Amplitude physikalisch korrekt ist.
Am Gerät wird der angezeigte RMS-Wert linear gemittelt. Wir übernehmen das als
Default (Kompatibilität) und bieten "quadratisch" als Option.

| Modus | Formel | Parameter |
|---|---|---|
| Aus | `Dn = Mn` | |
| Exponentiell | `Dn = Dn-1 + (Mn - Dn-1) / K`, `D1 = M1` | `K ∈ {2, 4, 8, 16, 32, 64}` (Dämpfungskonstante) |
| Gleitend | `Dn = (Mn-(m-1) + ... + Mn-1 + Mn) / m` | `m ∈ {8, 16, 32, 64}` (WT3000 bis 256) |

Yokogawa erlaubt im Update-Modus "Auto" nur exponentielle Mittelung. Die
Ansprechzeit eines Geräts beträgt bis zu 2 × Update-Rate (WT3000-Datenblatt).

**Entscheidung:** Update-Rate Default **"Auto = 1 Periode"** der Sync-Quelle,
manuell auf feste Zeiten (in Simulationszeit) umstellbar. Mittelung Default
**exponentiell, K = 8**. Ein Bereichswechsel oder eine Konfigurationsänderung
setzt die Mittelung zurück.

### 3.8 Cursor: Werte zum Zeitpunkt t

Der Analysator erzeugt bei der Auswertung eine **Historie** von
Update-Intervallen (Zeitstempel = Intervallende). Der Cursor im Plot liefert:

- **Momentanwerte** bei `t`: `u_k(t), i_k(t), p_k(t)`, Σp(t) (interpoliert).
- **Anzeigewerte zum Zeitpunkt t**: den Datensatz des letzten bis `t`
  abgeschlossenen Update-Intervalls (also genau das, was das Display damals
  gezeigt hätte, inkl. Mittelungszustand).

Die Tabelle bekommt dafür eine Ansicht "Cursor" (statt "Aktuell"), Zeilen für
Momentanwerte werden dort zusätzlich eingeblendet. Mit zwei Cursoren
(analog zur bestehenden Plot-Cursorlogik) kann optional eine **Auswertung über
das Cursorfenster** angeboten werden (alle Größen über `[t1, t2]` neu berechnet,
ohne Sync). Das ist sehr nützlich für Simulation, bei echten Geräten unüblich;
daher als eigene Spalte kennzeichnen.

### 3.9 Messbereiche und Überlast

Pro Element Spannungs- und Strombereich (Auto oder fest aus Reihe
`1-2-5`). Überlast, wenn `|pk| > 2 · Bereich` (Crestfaktor 2 ist ein üblicher
Gerätewert) oder `rms > 1,1 · Bereich`. Anzeige `-OL-` in der Zelle und `OVR`-LED.
Auto-Range: nach 2 Intervallen hochschalten, nach 3 Intervallen < 30 % runter
(Hysterese). In der Simulation ist das primär Realismus und
Plausibilitätsprüfung; für die spätere Hardware-UI ist es Pflicht.

### 3.10 Validierungsfälle (für die Umsetzung)

| Fall | Erwartung |
|---|---|
| Sinus 230 V an R = 52,9 Ω | `P = 1000 W`, `λ = 1`, `CfU = 1,414`, `FfU = 1,111` |
| RL-Last, `ωL = R` | `φ = +45°` (induktiv), `Q = P` |
| RC-Last, `1/(ωC) = R` | `φ = -45°`, Q negativ |
| Brückengleichrichter mit C-Last | `CfI` ≫ 1,414, `λ < cos φ1`, D > 0 |
| Symmetrische Drehstromlast 3P4W | `PΣ = 3 P1`, `u2 ≈ 0`, Zeiger 120° versetzt |
| Gleiche Last in 3P3W (Aron) | `PΣ` identisch zu 3P4W, `P1 ≠ P2` bei `φ ≠ 0` |
| Unsymmetrische Last | `Se > SΣ_arith`, `u2`/`i2 > 0` |
| PWM-Wechselrichter mit DC-Kanal 4 | η plausibel, Warnung bei grobem `tmax` |

---

## 4. Architektur: portabel und hardwaretauglich

### 4.1 Schichten

```
┌────────────────────────────────────────────────────────────┐
│ js/power-analyzer-ui.js   (DOM, Dialog, Tabelle, Plot,     │
│                            Vektor-SVG; kennt nur PA.Core   │
│                            + eine DataSource-Schnittstelle)│
├────────────────────────────────────────────────────────────┤
│ js/power-analyzer-core.js (reine Mathematik + Geräte-      │
│                            zustand: Sync, Intervalle,      │
│                            Mittelung, Σ, Bereiche; kein    │
│                            DOM, lauffähig in Worker/Node)  │
├────────────────────────────────────────────────────────────┤
│ DataSource (Interface)                                     │
│   ├─ SimSource   → im TurmericLab-Glue (simulation.js)     │
│   └─ später: ScpiSource (WebSerial/WebSocket), FileSource  │
└────────────────────────────────────────────────────────────┘
```

**Regeln für Portabilität:**

- Beide PA-Dateien sind **IIFEs**, die genau einen globalen Namen
  (`window.PowerAnalyzer`) exportieren; kein Zugriff auf `S`, `CD`,
  `simLastResult`, `fmtEng` o.Ä. Formatierung (SI-Präfixe) bringt das Modul selbst mit.
- uPlot wird per Option injiziert (`opts.uPlot || window.uPlot`), nicht implizit vorausgesetzt.
- Der Dialog wird in ein übergebenes Host-Element gerendert; Styles mit eigenem
  Präfix (`.pa-…`) und CSS-Variablen, eigene Datei `css/power-analyzer.css`.
- Konfiguration ist ein reines JSON-Objekt (serialisierbar, im Projekt speicherbar,
  später 1:1 als Geräte-Setup-Datei).
- Kern arbeitet **blockweise** (`pushSamples(block)`), nicht auf "dem ganzen
  Ergebnis". Für die Simulation werden die Blöcke einfach schnell hintereinander
  eingespeist; für Echtzeit/Hardware kommen sie getaktet. Gleicher Code.

### 4.2 DataSource-Schnittstelle (Entwurf)

```js
// Liefert Kanalliste und Samples. Simulation und echte Hardware
// implementieren dieselbe Form.
DataSource = {
  kind: 'sim' | 'hw',
  // Welche Signale gibt es (für Zuordnungsdialog)?
  listSignals()            -> [{id, label, unit:'V'|'A'}],
  // Für Hardware: Messwerte kommen schon fertig vom Gerät
  capabilities: { rawSamples: true, computedValues: false },
  // Rohdaten-Modus (Simulation, Scope-artige Hardware)
  start({fs, channels:[{u:id, i:id}, ...]}, onBlock),   // onBlock({t0, fs, u:[Float64Array], i:[...]})
  stop(),
  // Optional: Hardware liefert fertige Numerik (SCPI :NUMeric?)
  onValues?(cb)            // cb({t, values:{'Urms1':..., 'P1':...}})
}
```

Wichtig: Ein echtes Gerät rechnet selbst; die UI muss also auch **nur Werte**
(ohne Rohsamples) anzeigen können. Deshalb ist die Ergebnisstruktur des Kerns
gleich der, die ein `ScpiSource` liefern würde (flache Map `Größe+Element →
Wert` + Status). Die UI hängt nur an dieser Map + optional Wellenformen.

### 4.3 Ergebnisformat (ein Update-Intervall)

```js
{
  t: 0.0450,              // Intervallende (Gerätezeit)
  tStart: 0.0250, periods: 1, f: 50.0, sync: 'ok' | 'none',
  el: [                   // Element 1..4
    { Urms, Umn, Udc, Urmn, Uac, Upk, Umk, CfU, FfU, fU,
      Irms, Imn, Idc, Irmn, Iac, Ipk, Imk, CfI, FfI, fI,
      P, S, Q, lambda, phi, U1:{re,im}, I1:{re,im}, P1, Q1, cosPhi1, THDU, THDI,
      ovr:{u:false, i:false} }, ...
  ],
  sigma: { P, Q, S, lambda, Se, Ue, Ie, Upos, Uneg, U0, unbU, unbI, rot:'cw'|'ccw', IN },
  eta: 0.973,
  avg: { mode:'exp', K:8, n:12 }
}
```

### 4.4 Einbindung in TurmericLab (Glue)

- Ladereihenfolge: `… → js/simulation.js → js/power-analyzer-core.js →
  js/power-analyzer-ui.js`, der SimSource-Glue lebt in `simulation.js` (bzw.
  einem kleinen `js/pa-sim-bridge.js`), weil er `simLastResult`, `S.probes`,
  `probeVectorKey()`, `resolveCurrentProbe()` und die Formeln (`evalFormula`) nutzt.
- Formeln sind hier **erlaubt** (anders als bei `.measure`), weil der Analysator
  clientseitig auswertet. Damit gehen z.B. `V(a)-V(b)` oder eine Summe von Strömen.
- Konfiguration wird mit den Sim-Settings persistiert (`saveSimSettings()`), und
  ins Schaltplan-State (`state.sim.powerAnalyzer`) übernommen, damit sie beim
  SVG-Export/Import mitreist.
- Nur für `.tran` aktiv; bei `.ac`/`.dc`/`.op` zeigt der Dialog "Benötigt
  Transientenanalyse".
- Nach jedem Simulationslauf: SimSource meldet neue Daten → Kern läuft neu durch
  → Historie, Anzeige springt auf "letztes Intervall".

---

## 5. UI-Konzept

### 5.1 Dialogverhalten

Der User wünscht einen modalen Dialog. Konflikt: Für die Kanalzuordnung per
Probe muss der Schaltplan klickbar bleiben. Vorschlag (gleiches Muster wie das
bestehende Measure-Overlay):

- Großer Dialog (ca. 90 % Viewport) mit halbtransparentem Backdrop, per
  Kopfzeile verschiebbar, Größe per Ecke änderbar.
- Klick auf ein Zuordnungsfeld → Dialog geht in **Zuordnungsmodus**: Backdrop
  verschwindet, Dialog schrumpft auf eine kompakte Kanalleiste am Rand, PROBE-Modus
  wird aktiviert, jeder Probe-Klick füllt das aktive Feld und springt zum
  nächsten (U1 → I1 → U2 → I2 …), `Esc`/"Fertig" kehrt zurück.
- `Esc` schließt, Zustand bleibt erhalten.

### 5.2 Gesamtlayout

```
┌─ Power Analyzer PA-4 ─────────────────────────────────────────── [_][×] ┐
│ Wiring [3P4W ▾]  Sync [U1 ▾]  Update [Auto ▾]   AVG [EXP K=8 ▾]        │
│ S/Q [TYPE1 ▾]  η [Σ/4 ▾]  fs [1 MS/s]   ● SYNC  ○ OVR  ● AVG  [HOLD] [SINGLE] │
├─────────────────────────────────────────────────────────────────────────┤
│ [Numerik+Plot] [Vektor] [Kanäle]                         Anzeige: (●)Aktuell ( )Cursor │
├──────────────────────────────────┬──────────────────────────────────────┤
│  NUMERIK                          │  PLOT                                │
│        │ CH1 │ CH2 │ CH3 │ Σ │CH4│  ┌ Wellenform ─────────────────────┐ │
│ Urms ☑ │230.0│229.8│230.1│   │ ☐ │  │ u1 u2 u3 i1 i2 i3 (Sinus)       │ │
│ Irms ☑ │4.348│4.351│4.347│   │ ☐ │  │            ┆ Cursor t=12.4 ms  │ │
│ Udc  ☐ │ 0.0 │ ... │     │   │   │  └─────────────────────────────────┘ │
│ P    ☐ │ 1000│ ... │     │3000│  │  ┌ Trend (Update-Intervalle) ─────┐ │
│ S    ☐ │ ... │     │     │   │   │  │ P1, PΣ als Treppenkurve        │ │
│ Q    ☐ │     │     │     │   │   │  └─────────────────────────────────┘ │
│ λ    ☐ │1.000│     │     │   │   │                                      │
│ φ    ☐ │0.0° │     │     │   │   │  Legende / Achsen je Einheit          │
│ CfU …  │     │     │     │   │   │                                      │
│ f      │50.00│     │     │   │   │                                      │
│ [+ Werte wählen…]                 │                                      │
└──────────────────────────────────┴──────────────────────────────────────┘
```

### 5.3 Numerik-Tabelle

- Zeilen = Messgrößen, Spalten = CH1, CH2, CH3, Σ, CH4 (Σ steht direkt neben der
  Gruppe, CH4 abgesetzt, damit die Gruppierung sichtbar ist). Bei `1P2W` entfällt Σ.
- Zeilen gruppiert und einklappbar: **Spannung**, **Strom**, **Leistung**,
  **Formfaktoren**, **Grundschwingung**, **Dreiphasig** (nur Σ-Spalte), **DC/η**.
- Welche Zeilen sichtbar sind: "Werte wählen…" (Preset-Listen wie am Gerät:
  "Basis" = Urms, Irms, P, S, Q, λ, φ, f; "Kurvenform" = Cf, Ff, pk, THD; "Alle").
- **Haken pro Zelle** (☐) = Größe plotten. Kleines Checkbox-Feld links in der
  Zelle, Farbe der Kurve wird nach dem Plotten als Zellrand übernommen (gleiches
  Sticky-Farbprinzip wie `assignSimColors`). Haken an der Zeilenbeschriftung =
  alle Kanäle dieser Größe.
- Default angehakt: `u` und `i` der belegten Kanäle (als Wellenform).
- Zahlenformat: 5 signifikante Stellen mit SI-Präfix und Einheit (wie am Gerät),
  monospaced, rechtsbündig. Überlast `-OL-`, keine Daten `---`, nicht anwendbar leer.
- Werte flackern nicht: Aktualisierung höchstens im Takt der (simulierten)
  Update-Rate, bei "Playback" (siehe 5.7) sieht man das Gerät "laufen".

### 5.4 Plot

Zwei gestapelte uPlot-Instanzen mit **synchronisiertem Cursor** (uPlot `cursor.sync`):

1. **Wellenform**: Momentanwerte `u_k(t)`, `i_k(t)`, `p_k(t)`, Σp(t).
   Achse links V, rechts A; W bei Bedarf als dritte Skala (oder `p` normiert).
2. **Trend**: alle angehakten Numerikgrößen (RMS, P, λ, …) als Treppenkurve
   über die Update-Intervalle. Je Einheit eine Skala, max. 2 sichtbare Achsen,
   weitere Größen auf versteckten Skalen mit Wert in der Legende.

Ein Haken an einer Momentanwert-Größe (u, i, p) landet im Wellenform-Plot, an
einer Intervall-Größe im Trend-Plot. Leerer Trend-Plot wird ausgeblendet.

Cursor: Klick setzt Cursor 1, zweiter Klick Cursor 2 (wie im bestehenden
Simulationsplot), Doppelklick setzt Zoom und Cursor zurück. Markierung der
Update-Intervalle als dezente vertikale Bänder im Wellenform-Plot (zeigt, über
welches Fenster die angezeigten Werte gerechnet sind; sehr lehrreich).

### 5.5 Tabellenmodus "Cursor"

- Umschalter `Aktuell | Cursor | Cursor-Fenster`.
- `Cursor`: Tabelle zeigt die Anzeigewerte des Intervalls, das zum Zeitpunkt `t`
  aktiv war, plus zusätzliche Zeilen `u(t)`, `i(t)`, `p(t)` (Momentanwerte).
  Kopfzeile zeigt `t = 12.40 ms, Intervall 10.00 ms … 20.00 ms`.
- `Cursor-Fenster` (nur bei zwei Cursoren): alle Größen über `[t1, t2]`
  ohne Sync und ohne Mittelung neu gerechnet, Spaltenkopf markiert.

### 5.6 Vektordiagramm (Tab "Vektor", nur bei 3P3W/3V3A/3P4W)

```
┌─────────────────────────────────┬──────────────────────────────┐
│            90°                  │      │ Betrag  │ Winkel       │
│         ╱  U2                   │ U1   │ 230.0 V │   0.0°       │
│   I2 ╱                          │ U2   │ 229.8 V │ -120.1°      │
│ 180° ─────●───── U1  0°         │ U3   │ 230.1 V │  119.9°      │
│        ╲   ╲ I1                 │ I1   │ 4.348 A │ -30.0°       │
│   U3    ╲  I3                   │ …                             │
│            -90°                 │ φ1/φ2/φ3 : 30.0° 30.1° 29.9°  │
│  ○ U-Skala  ○ I-Skala (auto)    │ U+ 230.0 V  U- 0.12 V  u2 0.05 %│
│  [Ref: U1 ▾] [☐ Leiterspg.]     │ Drehfeld: rechts ↻           │
└─────────────────────────────────┴──────────────────────────────┘
```

- Grundschwingungszeiger (RMS-Länge), Referenz `U1` auf 0° (wählbar),
  mathematisch positiver Drehsinn, Winkel in Grad.
- Spannungen als dicke Pfeile, Ströme dünn/gestrichelt in derselben Farbe der
  Phase (L1 braun/rot, L2 schwarz/gelb, L3 grau/blau, passend zum dunklen Theme
  angepasst). Getrennte, automatisch skalierte Ringe für U und I, Skalenwerte
  an den Ringen.
- Optional: Leiterspannungen `U12, U23, U31` als Dreieck einblenden.
- Bei 3P3W: gemessene Leiterspannungen + berechneter Sternpunkt, gekennzeichnet.
- Begleittabelle rechts mit Beträgen/Winkeln, φ je Phase, symmetrischen
  Komponenten, Unsymmetrie, Drehfeldrichtung.
- Reines SVG, folgt Cursor (Zeiger des Intervalls zum Zeitpunkt t).

### 5.7 "Echtes Gerät"-Gefühl

- **Playback**: Nach dem Simulationslauf "läuft" das Gerät die Historie mit
  wählbarem Zeitfaktor ab (z.B. 1 Update pro 300 ms Wandzeit), Display
  aktualisiert sich im Gerätetakt, Mittelung schwingt sichtbar ein. Schalter
  `▶ Live-Wiedergabe` vs. `⏭ Endwert` (Default: Endwert, damit es schnell ist).
- `HOLD` friert ein, `SINGLE` zeigt genau das nächste Intervall.
- Status-LEDs, Bereichsanzeige pro Kanal (`U: 300 V  I: 5 A`), `-OL-`.
- Optional: Gerätefront-Optik (dunkle Anzeige, 7-Segment-artige Monospace-Ziffern).
  Bewusst dezent, damit es zur App passt und später für Hardware tauglich bleibt.

### 5.8 Tab "Kanäle" (Zuordnung)

```
 Element │ Spannung          │ Strom            │ Bereich U │ Bereich I │ Faktor
 CH1     │ [V(l1)      ▾][⌖] │ [I(R1)     ▾][⌖] │ Auto      │ Auto      │ 1.0
 CH2     │ [V(l2)      ▾][⌖] │ [I(R2)     ▾][⌖] │ …
 CH3     │ [V(l3)      ▾][⌖] │ [I(R3)     ▾][⌖] │
 CH4     │ [V(dcp,dcn) ▾][⌖] │ [I(Vdc)    ▾][⌖] │
 Neutral │ [0 / gnd    ▾]                         (nur 3P4W: Bezugspunkt der Strangspannungen)
```

- Dropdown aus derselben Signalliste wie der reguläre Plot (Vektoren + Formeln).
- `⌖` = Probe-Zuordnung (Zuordnungsmodus aus 5.1). Spannung akzeptiert
  `V`/`Vd`-Probes, Strom nur `I`-Probes.
- **Vorzeichen-Schalter** je Strom (Probe-Richtung vs. Verbraucherzählpfeil), mit
  Hinweis, wenn `P < 0` an einem Lastkanal auftaucht.
- **Auto-Vorschlag**: wenn genau drei Spannungs- und drei Stromprobes existieren,
  werden sie der Reihe nach vorbelegt.
- Faktor (Wandler-/Shunt-Verhältnis) für Realismus und spätere Hardware.

---

## 6. Umsetzungsplan (Phasen)

**Phase 1: Kern (ohne UI)**
1. `power-analyzer-core.js`: Resampling-Helfer, Nulldurchgangs-Sync, Intervall-
   bildung, Grundgrößen 3.3/3.4, Einzel-DFT, Mittelung, Historie.
2. Testseite `poc/pa-core-test.html` mit den Validierungsfällen aus 3.10
   (synthetische Signale, keine ngspice-Abhängigkeit).

**Phase 2: Dialog Grundgerüst**
3. `power-analyzer-ui.js` + `css/power-analyzer.css`: Dialog, Kopfzeile,
   Kanal-Tab, Numerik-Tabelle (Aktuell), Wellenform-Plot mit Default-Haken.
4. SimSource-Glue in TurmericLab, Button "Power Analyzer" in der Sim-Pane,
   Persistenz der Konfiguration.
5. Probe-Zuordnungsmodus.

**Phase 3: Dreiphasig + Cursor**
6. Verdrahtungsmodi, Σ-Werte, IEEE 1459, symmetrische Komponenten.
7. Trend-Plot, Haken pro Zelle, Cursor-Modi der Tabelle.
8. Vektordiagramm.

**Phase 4: Realismus und Ausbau**
9. Playback, HOLD/SINGLE, Bereiche/OVR, Auto-Range.
10. Optional: Quantisierung/Bandbreite, Harmonische bis 50. Ordnung (FFT,
    Balkendiagramm als weiterer Tab), Energie-Integration.
11. Doku-Kapitel in DOKUMENTATION.md (Mathematik verlinken statt duplizieren).

**Später:** `ScpiSource` (WebSerial an z.B. Yokogawa WT/Hioki über SCPI, nur
fertige Numerik), Echtzeit-Simulation über Shared-API-PoC.

### 6.1 Umsetzungsstand (2026-10-06)

Erledigt: Phasen 1 bis 3 komplett, aus Phase 4 Punkt 9 (Wiedergabe,
HOLD/SINGLE, Bereiche mit Auto-Range und OVR) und Punkt 11 (DOKUMENTATION.md
Kapitel 10). Abweichungen vom Plan:

- Kerntest als Node-Skript `poc/pa-core-test.js` statt HTML-Testseite
  (42 Prüfungen, alle Fälle aus 3.10).
- Bridge als eigene Datei `js/power-analyzer-sim.js` statt in `simulation.js`.
- UI-Texte auf Englisch, passend zur restlichen App.
- Sync-Kopplung zusätzlich wählbar ('ac' zieht den Mittelwert ab), Default 'ac',
  damit auch Signale mit Offset synchronisieren. Bisher nur per Konfiguration,
  nicht in der Bedienleiste.
- Mittelung: RMS-Werte werden linear gemittelt wie am Gerät; die in 3.7
  erwähnte quadratische Option ist noch nicht umgesetzt.

Nachtrag (2026-10-06, zweiter Schritt): Phase 4 ist abgeschlossen.

- Harmonische bis Ordnung 50 (einstellbar bis 100) per PLL-Abtastung und DFT,
  eigener Tab mit Balkendiagramm (% der Grundschwingung oder absolut, linear
  oder logarithmisch, optional DC) und Tabelle, auch für P(k). THD jetzt aus
  den Harmonischen.
- Energie-Integration WP, WP+, WP−, q, q+, q−, Integrationszeit (Tabellengruppe
  "Integration", plotbar im Trend).
- Realistischer Eingang: Bandbreite, ADC-Auflösung, Rauschen, Clipping.
- Quadratische RMS-Mittelung als Option.
- Setup-Tab mit Sync-Kopplung, Hysterese, Nulldurchgangsfilter, S-Basis,
  λ-Vorzeichen, Crestfaktor, Harmonische, Integrationsstart, Eingangsstufe.
- Auswertung im Web Worker ab 1 Mio. Abtastwerten.
- Kerntest auf 65 Prüfungen erweitert.

Offen bleibt nur noch der Punkt "Später": `ScpiSource` für echte Geräte und
Echtzeit über den Shared-API-PoC.

Im Browser geprüft (3-Phasen-RL-Last 230 V, 10 Ω + 31,8 mH, plus DC-Zweig):
3P4W, 3P3W (Aron) und IEEE 1459 liefern PΣ = 7935 W, SΣ = 11222 VA, φ = 45°;
Zeigerdiagramm, Cursor (pΣ(t) konstant), Cursorfenster, Wiedergabe,
Probe-Zuordnung per Klick/Drag, OVR, Betrieb ohne Sync.

---

## 7. Risiken und offene Punkte

- **Einschwingen**: Simulationen starten meist mit Transienten. Option
  "Auswertung ab t =" (Default = `tstart` der `.tran`) bzw. Hinweis im Trend.
- **Wenige Perioden**: bei `tstop = 5 ms` und 50 Hz gibt es keine einzige volle
  Periode. Klare Meldung, Vorschlag `tstop ≥ 10 Perioden`.
- **PWM/Schaltvorgänge**: Rechenaufwand bei feinem `tmax` und langer Laufzeit;
  Kern im Worker laufen lassen (ist DOM-frei, also problemlos).
- **Stromvorzeichen** der ngspice-Branch-Currents (`@r1[i]`, `i(v1)`) sind nicht
  intuitiv; Vorzeichenschalter + P<0-Hinweis.
- **Lead/Lag-Erkennung** bei verzerrten Signalen (bekanntes Geräteproblem, das
  Yokogawa mit TYPE 2 umgeht). Wir bestimmen `s` aus der Grundschwingungs-DFT,
  das ist robuster als die Flankenmethode realer Geräte; bei `|φ1| < 1°` oder
  sehr kleiner Grundschwingung `s = +1` setzen und Wert markieren.
- **Σ-Formeln**: erledigt, gegen Yokogawa WT310/WT5000 und Hioki PW3390 verifiziert (3.5.2).

## 8. Entscheidungen (mit dem User abgestimmt am 2026-10-06)

1. **Dialog:** modal mit Backdrop; zum Zuordnen per Probe wechselt er in einen
   kompakten Modus ohne Backdrop (Muster wie das Measure-Overlay).
2. **Update-Rate:** Default "Auto = 1 Periode" der Sync-Quelle, manuell auf
   feste Zeiten in Simulationszeit umstellbar. Mittelung exponentiell, K = 8.
3. **Name/Optik:** neutral "PA-4", keine Herstellermarken in der UI, dezente
   Geräteoptik passend zum App-Theme.
4. **Kein Schaltplan-Bauteil** in der ersten Version; Zugang über einen Button
   in der Simulations-Pane. Ein rein visuelles Symbol (`pins:[]`) kann später
   ergänzt werden, die Architektur braucht dafür nichts Zusätzliches.
5. **Harmonischen-Analyse später** (Phase 4). Die PLL-Abtastung pro Intervall
   (3.4) wird aber gleich so gebaut, dass die FFT später direkt darauf aufsetzt.
6. **Σ-Formel-Default:** TYPE1 mit den Yokogawa-Faktoren je Verdrahtung,
   umschaltbar auf TYPE2, TYPE3 und IEEE 1459 (3.5.3).

---

## Quellen

- [Yokogawa WT5000 Spezifikationen (PDF, Messfunktionen Urms/Umn/Udc/Urmn/Uac, Cf/Ff, Σ)](https://nbn.at/cdn/shop/files/Spezifikationen_-_WT5000.pdf)
- [Yokogawa WT5000 Produktseite](https://tmi.yokogawa.com/us/solutions/products/power-analyzers/wt5000)
- [Yokogawa WT5000 User Manual IMWT5000-02EN](https://cores.research.asu.edu/sites/default/files/2022-07/IMWT5000-02EN.pdf)
- [Yokogawa WT5000 Features Guide IM WT5000-01EN (Mittelung Kap. 6, S/Q-Typen Kap. 8)](https://cdn.tmi.yokogawa.com/1/7117/files/IMWT5000-01EN.pdf)
- [Yokogawa WT310/WT330 User's Manual IM WT310-01EN (Appendix 1: Σ-Formeln je Verdrahtung, Umn, Q, Cf)](https://cdn.tmi.yokogawa.com/IMWT310-01EN.pdf)
- [Yokogawa FAQ: Type1 vs Type2 bei Blind- und Scheinleistung](https://tmi.yokogawa.com/library/resources/faqs/what-is-the-difference-between-type1-and-type2-with-regards-to-reactive-power-apparent-power-and-other-formulas/)
- [Yokogawa WT3000 Datenblatt (Mittelung, Messperiode, Ansprechzeit)](https://atecorp.com/getmedia/0e83bf9e-368e-4b5d-9399-58251bcf17e6/yokogawa-wt3000_datasheet_1.pdf)
- [Hioki PW3390 Bedienungsanleitung, italienisch (Kap. 10.6 Rechenformeln, Kap. 5.6 TYPE1/TYPE2)](https://www.hioki.com/download/37896)
- [Yokogawa FAQ: Exponential Average for Measuring Period (EAMP)](https://tmi.yokogawa.com/ca/library/resources/faqs/what-is-the-exponential-average-for-measuring-period-eamp)
- [Hioki Bedienungsanleitung (Verdrahtungsmodi 3P3W2M/3P3W3M/3P4W)](https://www.hioki.com/download/28782)
- [Hioki PW6001 Instruction Manual](https://assets.testequity.com/te1/Documents/pdf/hioki/hioki-pw6001-instruction-manual.pdf)
- [R&S / ZES Zimmer LMG600 Series](https://www.rohde-schwarz.com/es/_334339.html)
- [IEEE 1459-2010 effektive Scheinleistung, Übersichtsartikel (MDPI Energies)](https://www.mdpi.com/1996-1073/18/12/3214)
- [Effective Apparent Power Measurement Based on Unbalanced and Nonlinear Load](https://ph02.tci-thaijo.org/index.php/eit-researchjournal/article/view/242262)
