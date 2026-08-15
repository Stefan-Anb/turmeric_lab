// ═══════════════════════════════════════════════════
// NGSPICE SIMULATION WORKER
//
// Runs the eecircuit-engine (ngspice-WASM) load + simulate calls off the main
// thread, so a long .tran/.ac run doesn't freeze the UI (dragging the canvas,
// editing properties, resizing the plot, …). Netlist assembly stays on the
// main thread (js/simulation.js) — it needs S.components/S.probes and the
// rest of the schematic state, which don't belong here. This worker only ever
// sees a finished netlist string in and a plain-data result object out.
//
// Must be created as a module worker (`new Worker(url, {type:'module'})`) —
// it uses top-level dynamic import() to fetch the engine, same as the old
// main-thread code did.
// ═══════════════════════════════════════════════════

var EE_ENGINE_URL='https://esm.sh/eecircuit-engine@1.7.0';
var simInstance=null;
var simStarting=null;

function ensureSim(){
  if(simInstance)return Promise.resolve(simInstance);
  if(simStarting)return simStarting;
  postMessage({type:'status',message:'Loading NGSpice (WASM)…'});
  simStarting=import(EE_ENGINE_URL).then(function(mod){
    var Sim=mod.Simulation||(mod.default&&mod.default.Simulation);
    if(!Sim)throw new Error('eecircuit-engine: Simulation export not found');
    var sim=new Sim();
    return Promise.resolve(sim.start()).then(function(){
      simInstance=sim;
      postMessage({type:'status',message:'NGSpice ready.'});
      return sim;
    });
  }).catch(function(err){
    simStarting=null;
    throw err;
  });
  return simStarting;
}

self.onmessage=function(e){
  var msg=e.data||{};
  if(msg.type==='preload'){
    ensureSim().catch(function(err){
      postMessage({type:'preload-error',message:String(err&&err.message||err)});
    });
    return;
  }
  if(msg.type!=='run')return;
  var token=msg.token;
  ensureSim().then(function(sim){
    sim.setNetList(msg.netlist);
    postMessage({type:'status',message:'Simulating…',token:token});
    var t0=(typeof performance!=='undefined'?performance.now():Date.now());
    return Promise.resolve(sim.runSim()).then(function(result){
      var elapsed=(typeof performance!=='undefined'?performance.now():Date.now())-t0;
      var errs=null,info=null;
      try{
        errs=sim.getError&&sim.getError();
        info=sim.getInfo&&sim.getInfo();
      }catch(e){}
      postMessage({type:'result',token:token,result:result,elapsed:elapsed,errs:errs||[],info:info||''});
    });
  }).catch(function(err){
    postMessage({type:'error',token:token,message:String(err&&err.message||err),stack:String(err&&err.stack||err)});
  });
};
