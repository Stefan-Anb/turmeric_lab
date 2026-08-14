* Leistungs-Probe (P = U*I) als eigenes Probe-Werkzeug (aktuell nur per Formel)
* AC-Analyse ebenfalls grafisch konfigurierbar machen (aktuell nur .tran/.dc/.op)
* PWM-Generator: Totzeit ist über verschobene Vergleichsschwellen gelöst, weil
  der WASM-Build kein `delay()` kennt. Falls eine spätere Engine-Version die
  Funktion mitbringt, kann das Referenzmodell direkt genutzt werden.
* Thyristor: dV/dt-Zündung und Rückwärts-Durchbruch sind im Latch-Modell nicht
  abgebildet.
* Netzbenennung: Ein expliziter Netzname gewinnt in `getTempNetName()` gegen die
  GND-Erkennung. Ein Netz, das ein Massesymbol trägt und zusätzlich benannt ist,
  landet dadurch nicht auf Knoten 0 und hängt in der Simulation in der Luft
  ("singular matrix"). GND sollte immer gewinnen.
