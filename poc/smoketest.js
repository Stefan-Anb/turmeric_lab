// Smoke-Test fuer das per emcc gebaute ngspice-Shared-API-WASM-Modul.
// Aufruf: node smoketest.js <pfad-zu-spice-shared.mjs> <pfad-zu-spice-shared.wasm>
//
// Als eigenstaendige .js-Datei statt eingebetteter "node -e '...'" Strings,
// damit keine mehrfach verschachtelte Shell-/YAML-/Dockerfile-Quotierung die
// Netzliste (Zeilenumbrueche!) verstuemmeln kann - das ist in einer frueheren
// Version dieses Tests tatsaechlich passiert (siehe POC-ECHTZEIT-NGSPICE.md,
// Abschnitt 8.3).
//
// Das Modul ist mit ENVIRONMENT="web,worker" gebaut (kein "node"), daher
// laedt der Glue-Code das .wasm normalerweise per fetch() - und Node
// implementiert fetch() fuer file://-URLs nicht. Deshalb wird der
// WASM-Bytecode hier explizit als "wasmBinary" uebergeben (umgeht fetch();
// betrifft nur diesen Test, nicht den Browser-Einsatz).

const fs = require('fs');
const path = require('path');

const mjsPath = path.resolve(process.argv[2] || './spice-shared.mjs');
const wasmPath = path.resolve(process.argv[3] || './spice-shared.wasm');

(async () => {
  const mod = await import(mjsPath);
  const factory = mod.default || mod.Module || mod;
  const wasmBinary = fs.readFileSync(wasmPath);
  const m = await factory({ wasmBinary });

  for (const fn of ['_ngSpice_Init', '_ngSpice_Init_Sync', '_ngSpice_Command', '_ngSpice_Circ']) {
    if (typeof m[fn] !== 'function') throw new Error('FEHLT: ' + fn);
    console.log('OK', fn);
  }
  if (typeof m.addFunction !== 'function') throw new Error('addFunction fehlt (ALLOW_TABLE_GROWTH?)');
  console.log('OK addFunction');

  const cbChar = m.addFunction((p) => { process.stdout.write(m.UTF8ToString(p) + '\n'); return 0; }, 'iiii');
  const cbExit = m.addFunction(() => 0, 'iiiiii');
  const cbData = m.addFunction(() => 0, 'iiiii');
  const cbInit = m.addFunction(() => 0, 'iiii');

  const rc = m.ccall('ngSpice_Init', 'number',
    ['number', 'number', 'number', 'number', 'number', 'number', 'number'],
    [cbChar, 0, cbExit, cbData, cbInit, 0, 0]);
  if (rc !== 0) throw new Error('ngSpice_Init rc=' + rc);

  const netlist = [
    '* smoketest',
    'r1 in 0 1k',
    'vin in 0 dc 5',
    '.op',
    '.end',
    ''
  ].join('\n');
  m.FS.writeFile('/t.cir', netlist);
  m.ccall('ngSpice_Command', 'number', ['string'], ['source /t.cir']);
  m.ccall('ngSpice_Command', 'number', ['string'], ['run']);
  console.log('OK .op-Analyse durchgelaufen');
})().catch((e) => { console.error(e); process.exit(1); });
