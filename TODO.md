* Leistungs-Probe (P = U*I) als eigenes Probe-Werkzeug (aktuell nur per Formel)
* Schalter: `getNetName()` behandelt den Schalter wie GND/VCC/NetConn und gibt
  für Pin A dessen Label als Netznamen zurück. Ein Schalter SW1 erzeugt damit
  ein Netz namens "SW1" (`SSW1 SW1 n000 …`) statt das angeschlossene Netz zu
  nutzen. Der Schalter gehört aus dieser Liste entfernt.


* Step Parameter, Multisimulation, Graphenschar im Plot, Auswahl einzelner Graphen, Berechnung von Kennlinien aus Multisimulation
* alle Platzhalter entfernen oder setzen -> kann verwirren (schon erledigt?!)

Einbinden der Echtzeit-Simulation (mit Javscript-Code)
* WASM-Build vom POC einbinden
* Code-Editor ergänzen
* Wrapper für Netznamen? -> bestenfalls Auto-Completion