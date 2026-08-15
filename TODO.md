* Leistungs-Probe (P = U*I) als eigenes Probe-Werkzeug (aktuell nur per Formel)
* AC-Analyse ebenfalls grafisch konfigurierbar machen (aktuell nur .tran/.dc/.op)
* PWM-Generator: Totzeit ist über verschobene Vergleichsschwellen gelöst, weil
  der WASM-Build kein `delay()` kennt. Falls eine spätere Engine-Version die
  Funktion mitbringt, kann das Referenzmodell direkt genutzt werden.
* Thyristor: dV/dt-Zündung und Rückwärts-Durchbruch sind im Latch-Modell nicht
  abgebildet.
* Schalter: `getNetName()` behandelt den Schalter wie GND/VCC/NetConn und gibt
  für Pin A dessen Label als Netznamen zurück. Ein Schalter SW1 erzeugt damit
  ein Netz namens "SW1" (`SSW1 SW1 n000 …`) statt das angeschlossene Netz zu
  nutzen. Der Schalter gehört aus dieser Liste entfernt.


* Measurement-Statements konfigurierbar und UI dafür
* Step Parameter, Multisimulation, Graphenschar im Plot, Auswahl einzelner Graphen, Berechnung von Kennlinien aus Multisimulation
* Schneller zugänglicher Run Button, besser ersichtlicher Ablauf der Simulation -> workerthread + live update der graphen wenn möglich
* Cursor-Feature im Plot
* Signalliste collapsen auch wenn alle gespeichert werden
* Durchlaufzeit der Simulation anzeigen
* Bauteile beim kopieren neu benennen (Duplikate vermeiden)
* Irreführende Bauteilbezeichnungen entfernen/korrigieren
* Diodenmodell noch nicht korrekt?
* ncycles standardmäßig 0
* alle Platzhalter entfernen oder setzen -> kann verwirren
* getrennte Skalierung von Spannung und Strom
* Automatische/Variable Stepsize?
* Simulations-Statement in File speichern
* Diodenmodell Anode/Kathode vertauscht
* Beim proben von Spannungsdifferenzen die Logik umkehren (erster Probe ist der obere Wert)
* Favicon