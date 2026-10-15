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

* Schematic klonen

* Energie integral (idealerweise per Measurement-Statement)
* Fix der behavioural source (falsche Werte?!)

Erweiterung der Blockschaltbild-Funktion
* Blockdiagramm-Block
* "Connectoren" für Bilder
* Verbindungen farblich markieren und in verschiedenen dicken (3 reichen) anbieten
* Evtl. Endpfeile

Copy&Paste Daten in echte Zwischenablage übernehmen?

Schriftgröße Markdown bei SVG-"Export"
Allgemein SVG-Export checken - Viewport i.O.?

Custom components im/export - globale Library

Bug - Custom component scheint falsche Komponente zu ziehen