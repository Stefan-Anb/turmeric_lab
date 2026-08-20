* Leistungs-Probe (P = U*I) als eigenes Probe-Werkzeug (aktuell nur per Formel)
* PWM-Generator: Totzeit ist über verschobene Vergleichsschwellen gelöst, weil
  der WASM-Build kein `delay()` kennt. Falls eine spätere Engine-Version die
  Funktion mitbringt, kann das Referenzmodell direkt genutzt werden.
* Thyristor: dV/dt-Zündung und Rückwärts-Durchbruch sind im Latch-Modell nicht
  abgebildet.
* Schalter: `getNetName()` behandelt den Schalter wie GND/VCC/NetConn und gibt
  für Pin A dessen Label als Netznamen zurück. Ein Schalter SW1 erzeugt damit
  ein Netz namens "SW1" (`SSW1 SW1 n000 …`) statt das angeschlossene Netz zu
  nutzen. Der Schalter gehört aus dieser Liste entfernt.


* Step Parameter, Multisimulation, Graphenschar im Plot, Auswahl einzelner Graphen, Berechnung von Kennlinien aus Multisimulation
* alle Platzhalter entfernen oder setzen -> kann verwirren
* Default range vom PWM-Generator auf 1V