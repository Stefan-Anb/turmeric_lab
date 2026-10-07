* Leistungs-Probe (P = U*I) als eigenes Probe-Werkzeug (aktuell nur per Formel)
* Schalter: `getNetName()` behandelt den Schalter wie GND/VCC/NetConn und gibt
  für Pin A dessen Label als Netznamen zurück. Ein Schalter SW1 erzeugt damit
  ein Netz namens "SW1" (`SSW1 SW1 n000 …`) statt das angeschlossene Netz zu
  nutzen. Der Schalter gehört aus dieser Liste entfernt.


* alle Platzhalter entfernen oder setzen -> kann verwirren (schon erledigt?!)

Einbinden der Echtzeit-Simulation (mit Javscript-Code)
* WASM-Build vom POC einbinden
* Evtl. Simulationsstatus erweitern um tatsächliche Zeit
* Code-Editor ergänzen
* Wrapper für Netznamen? -> bestenfalls Auto-Completion

* Batch-Download der Internal Library

* Info-Dialog mit Version, Git-Commit-ID etc.

* Netzname sollte wenn möglich auf einem waagrechten Element angezeigt werden (am besten das längste Element)
* Fix von Netz zeichnen, wenn man senkrecht aus einem Element herausfährt (reproduzieren und dann dem LLM geben)
* Beim kopieren von Schaltungsgruppen bleiben manchmal einzelne Elemente stehen
* Schematic klonen

* Automatische Anpassung der Step Size (Abhängigkeit Modell/Einstellung der Spannungsquellen)

* Notes können nicht kopiert werden?
* Kopieren von Textlabel erhält nicht den Text. Dito für Netlabel
* Funktionsumfang Markdown?