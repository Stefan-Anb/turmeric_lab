// ═══════════════════════════════════════════════════
// POWER ANALYZER PA-4: EVALUATION WORKER
//
// Runs Instrument.run() off the main thread for large records, so the UI
// stays responsive. Posts back the history only (without the raw interval
// primitives); the page attaches it to its own Instrument (attach()), which
// keeps the prepared samples for waveforms, cursor values and windows.
//   in : {id, cfg, rec}
//   out: {id, history, syncLost} | {id, error}
// ═══════════════════════════════════════════════════
importScripts('power-analyzer-core.js');

self.onmessage=function(ev){
  var d=ev.data;
  try{
    var ins=new self.PowerAnalyzer.Instrument(d.cfg);
    ins.run(d.rec);
    var hist=ins.history.map(function(r){
      var o={};
      for(var k in r)if(k!=='raw')o[k]=r[k];
      return o;
    });
    self.postMessage({id:d.id,history:hist,syncLost:ins.syncLost});
  }catch(e){
    self.postMessage({id:d.id,error:String((e&&e.message)||e)});
  }
};
