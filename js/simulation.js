// ═══════════════════════════════════════════════════
// NGSPICE SIMULATION (WASM, off the main thread) + INTERACTIVE PLOT
//
// Uses eecircuit-engine (ngspice compiled to WebAssembly) loaded lazily from a
// CDN as an ES module, and uPlot for an interactive (zoom / pan / cursor /
// legend) time- and frequency-domain plot. Net selection for the plot is driven
// by the existing Probe mode: clicking a net or pin in probe mode toggles that
// node into S.probes; only probed/ticked nets are plotted. The plot starts
// empty until the user probes something, ticks a vector, or presses one of the
// "All …" buttons — unless a previous session (or the loaded SVG) already had
// a selection, which is carried over.
//
// The engine itself runs inside js/sim-worker.js (a dedicated Worker), not on
// this thread — see runSimulation() and simWorkerHandleMessage() below. That
// keeps the UI responsive during a long run and, unlike the old in-thread
// call, lets a hung engine actually be killed (worker.terminate()) instead of
// just abandoned. Netlist assembly still happens here: it needs S.components /
// S.probes / the rest of the schematic state, which the worker doesn't have.
//
// Requires a network connection on first run to fetch the WASM engine. The
// engine and uPlot can later be vendored locally for offline use.
// ═══════════════════════════════════════════════════

var simPlot=null;         // current uPlot instance
var simLastResult=null;   // last result, for re-plot when probe selection changes
// Parameter sweep (see buildStepPlan() in js/netlist.js). One run per combination
// of the swept parameters; simLastResult is then the FIRST run's result (so
// everything that works on "a result" keeps working) and simRuns holds all of
// them: {names:[swept param names], runs:[{assign,label,result,info,meas}]}.
// null for an ordinary single run.
var simRuns=null;
var simPlan=null;         // {runs:[{assign,netlist}], i, done:[]} while a run (sweep) is in flight
var simRunT0=0;           // start of the whole run (sweep), for the elapsed-time ticker
// The plotted signals are one single selection: a map of result-vector names
// (lowercase) -> true. Canvas probes and the vector picker are two ways of
// editing the same set, and it survives across simulation runs — a new run only
// drops entries whose vector no longer exists (silently, the netlist may have
// changed). `simSelectionAuto` means "derive the set from S.probes/ticked
// vectors as usual, don't auto-fill it with anything" — it used to mean "auto-
// select every node voltage", but that surprised more than it helped, so a
// fresh schematic (no saved probes in this session or the loaded SVG) now
// starts with a deliberately empty plot instead.
var simSelection={};
var simSelectionAuto=false;
var simViewActive=false;   // split-screen plot pane open?
var simPanelOpen=false;    // simulation settings shown in the properties sidebar?
var simXUnit='';           // unit of the x axis of the current plot ('s', 'Hz', …)
// Curve colours, shared between the plot and the signal lists so a label in the
// sidebar has the same colour as its curve. Filled by plotResult, keyed by the
// lowercased series label.
var SIM_PALETTE=['#00c8ff','#ff9040','#40ff90','#ff5f87','#c080ff','#ffd040','#5fd0ff','#ff6b35'];
var simSeriesColor={};
// Sticky colour assignment: a signal keeps its colour for as long as it stays
// plotted, even while other signals are added/removed around it. See
// assignSimColors() — a colour is only freed once its signal actually leaves
// the plotted set, and a newly added signal takes the first free one.
var simColorAssign={};

// Analysis configuration (GUI-built .tran / .dc directive) and user formulas.
// Both are persisted separately from the schematic so they survive a reload.
var simAnalysis={
  type:'tran',
  tran:{tstep:'50n',tstop:'5m',tstart:'',tmax:'',uic:false,trtol:'7'},
  dc:{src:'',start:'0',stop:'5',step:'0.1',use2:false,src2:'',start2:'0',stop2:'5',step2:'1'},
  ac:{sweep:'dec',pts:'20',fstart:'1',fstop:'1Meg'}
};
var simFormulas=[];        // [{name,expr,on}]

// Measurement statements (.measure). See MEASURE_DEFAULTS below for the shape
// of one entry. `result` is transient (filled in by parseMeasurements() after
// each run) and never persisted.
var simMeasurements=[];
var simLastInfoText='';    // last sim.getInfo() text — .measure results are parsed out of this
var simMeasureDraft=null;  // {index, data} while the overlay is open; null otherwise
var simMeasureActiveSigPath=null; // last-focused signal field path in the overlay, e.g. 'stat.sig'
var MEASURE_NEXT_ID=1;

function loadSimSettings(){
  try{
    var raw=localStorage.getItem('sim_settings');
    if(!raw)return;
    var st=JSON.parse(raw);
    if(st.analysis){
      simAnalysis.type=st.analysis.type||simAnalysis.type;
      if(st.analysis.tran)for(var k in st.analysis.tran)simAnalysis.tran[k]=st.analysis.tran[k];
      if(st.analysis.dc)for(var k2 in st.analysis.dc)simAnalysis.dc[k2]=st.analysis.dc[k2];
      if(st.analysis.ac)for(var k3 in st.analysis.ac)simAnalysis.ac[k3]=st.analysis.ac[k3];
    }
    if(Array.isArray(st.formulas))simFormulas=st.formulas;
    if(Array.isArray(st.measurements)){
      simMeasurements=st.measurements;
      simMeasurements.forEach(function(m){
        var n=parseInt(String(m.id||'').replace(/^m/,''),10);
        if(!isNaN(n)&&n>=MEASURE_NEXT_ID)MEASURE_NEXT_ID=n+1;
      });
    }
    if(typeof st.directives==='string'){
      var d=document.getElementById('sim-directives');
      if(d)d.value=st.directives;
    }
    if(typeof st.saveAll==='boolean'){
      var sa=document.getElementById('sim-raw-mode');
      if(sa)sa.checked=st.saveAll;
    }
  }catch(e){console.warn('sim settings load failed',e);}
}
function saveSimSettings(){
  try{
    var d=document.getElementById('sim-directives');
    localStorage.setItem('sim_settings',JSON.stringify({
      analysis:simAnalysis,formulas:simFormulas,
      measurements:simMeasurements.map(function(m){
        var c={};for(var k in m)if(k!=='result'&&k!=='results')c[k]=m[k];return c;
      }),
      directives:d?d.value:'',saveAll:getRawMode()
    }));
  }catch(e){}
}

// ═══ ANALYSIS DIRECTIVE BUILDER ═══
// NGSpice syntax (see the ngspice manual, ch. 11 "Analyses and output control"):
//   .tran Tstep Tstop [Tstart [Tmax]] [UIC]
//   .dc   Srcnam Vstart Vstop Vincr [Src2 Start2 Stop2 Incr2]
//   .ac   dec|oct|lin Points/Nd/No Fstart Fstop
function buildAnalysisDirective(){
  var a=simAnalysis;
  if(a.type==='manual')return '';
  if(a.type==='op')return '.op';
  if(a.type==='ac'){
    var ac=a.ac;
    if(!ac.fstart||!ac.fstop)return '';
    return '.ac '+(ac.sweep||'dec')+' '+(ac.pts||'10')+' '+ac.fstart+' '+ac.fstop;
  }
  if(a.type==='dc'){
    var d=a.dc;
    if(!d.src)return '';
    var s='.dc '+d.src+' '+(d.start||'0')+' '+(d.stop||'0')+' '+(d.step||'1');
    if(d.use2&&d.src2)s+=' '+d.src2+' '+(d.start2||'0')+' '+(d.stop2||'0')+' '+(d.step2||'1');
    return s;
  }
  var t=a.tran;
  if(!t.tstop)return '';
  var line='.tran '+(t.tstep||'1u')+' '+t.tstop;
  // Tmax may only be given together with Tstart, so default Tstart to 0.
  if(t.tstart||t.tmax)line+=' '+(t.tstart||'0');
  if(t.tmax)line+=' '+t.tmax;
  if(t.uic)line+=' uic';
  return line;
}

// ngspice always steps the transient analysis with a variable internal
// timestep (LTE-based); Tstep above is only the output raster, not the actual
// integration step. TRTOL scales how much local truncation error the adaptive
// step control tolerates per step — higher = larger, coarser steps (faster
// but less accurate), lower = smaller, finer steps. The ngspice default (and
// a generally sensible one) is 7; expose it explicitly so it is documented in
// the generated deck instead of relying on a silent engine default.
function buildOptionsDirective(){
  var a=simAnalysis;
  if(a.type!=='tran')return '';
  var trtol=a.tran.trtol;
  if(!trtol||!a.tran.tstop)return '';
  return '.options trtol='+trtol;
}

// ═══ MEASUREMENT (.measure) DIRECTIVE BUILDER ═══
// NGSpice syntax (ngspice manual, ch. "Measurements after AC, DC and Transient
// analysis"):
//   .measure {tran|dc|ac} name FIND expr AT=t
//   .measure {tran|dc|ac} name FIND expr WHEN v(sig)=val <TD=t><RISE=n|FALL=n|CROSS=n>
//   .measure {tran|dc|ac} name {MAX|MIN|PP|AVG|RMS|INTEG} expr FROM=t1 TO=t2
//   .measure {tran|dc|ac} name TRIG trig VAL=v <TD=t><RISE=n|FALL=n|CROSS=n>
//                              TARG targ VAL=v <TD=t><RISE=n|FALL=n|CROSS=n>
// Only meaningful once the analysis type (and its sweep variable, time or
// frequency) is known — not for .op (no sweep) or "manual" mode (the app
// doesn't know what analysis card the user wrote by hand).
function measureAnalysisKeyword(){
  var t=simAnalysis.type;
  return (t==='tran'||t==='dc'||t==='ac')?t:null;
}

// The plot names device-current vectors "i(@l1[i])", but ngspice's .measure only
// knows the bare "@l1[i]" form (the i(...) wrapper makes it fail silently, so
// the measurement never prints a result). Unwrap before writing the directive.
function measureSigForSpice(s){
  return String(s==null?'':s).replace(/\b[iv]\(\s*(@[^()\s]*\[[^\]]*\])\s*\)/gi,'$1');
}

function buildMeasureLine(m){
  var kw=measureAnalysisKeyword();
  if(!kw||!m||!m.name)return '';
  m=JSON.parse(JSON.stringify(m));
  ['findAt.expr','findWhen.expr','findWhen.whenSig','trigTarg.trigSig','trigTarg.targSig','stat.sig'].forEach(function(f){
    var p=f.split('.');
    if(m[p[0]]&&m[p[0]][p[1]])m[p[0]][p[1]]=measureSigForSpice(m[p[0]][p[1]]);
  });
  var name=m.name;
  if(m.kind==='find_at'){
    var fa=m.findAt||{};
    if(!fa.expr||!fa.at)return '';
    return '.measure '+kw+' '+name+' FIND '+fa.expr+' AT='+fa.at;
  }
  if(m.kind==='find_when'){
    var fw=m.findWhen||{};
    if(!fw.expr||!fw.whenSig||fw.whenVal==='')return '';
    var s='.measure '+kw+' '+name+' FIND '+fw.expr+' WHEN '+fw.whenSig+'='+fw.whenVal;
    if(fw.td)s+=' TD='+fw.td;
    if(fw.count)s+=' '+(fw.edge||'CROSS')+'='+fw.count;
    return s;
  }
  if(m.kind==='trig_targ'){
    var tt=m.trigTarg||{};
    if(!tt.trigSig||tt.trigVal===''||!tt.targSig||tt.targVal==='')return '';
    var t1='TRIG '+tt.trigSig+' VAL='+tt.trigVal;
    if(tt.trigTd)t1+=' TD='+tt.trigTd;
    t1+=' '+(tt.trigEdge||'RISE')+'='+(tt.trigCount||'1');
    var t2='TARG '+tt.targSig+' VAL='+tt.targVal;
    if(tt.targTd)t2+=' TD='+tt.targTd;
    t2+=' '+(tt.targEdge||'RISE')+'='+(tt.targCount||'1');
    return '.measure '+kw+' '+name+' '+t1+' '+t2;
  }
  // default: 'stat' — a range statistic (MAX/MIN/PP/AVG/RMS/INTEG)
  var st=m.stat||{};
  if(!st.sig)return '';
  var line='.measure '+kw+' '+name+' '+(st.func||'PP')+' '+st.sig;
  if(st.from)line+=' FROM='+st.from;
  if(st.to)line+=' TO='+st.to;
  return line;
}

function buildMeasureDirectives(){
  if(!measureAnalysisKeyword())return '';
  var lines=[];
  for(var i=0;i<simMeasurements.length;i++){
    var m=simMeasurements[i];
    if(m.enabled===false)continue;
    var l=buildMeasureLine(m);
    if(l)lines.push(l);
  }
  return lines.join('\n');
}

// Voltage/current sources available as a .dc sweep source, by SPICE name.
function sweepableSources(){
  var refMap=(typeof buildSpiceRefMap==='function')?buildSpiceRefMap():{};
  var out=[];
  for(var i=0;i<S.components.length;i++){
    var c=S.components[i];
    if(c.type!=='source'&&c.type!=='vcc')continue;
    var ref=refMap[c.id];
    if(!ref)continue;
    var first=ref.charAt(0).toUpperCase();
    if(first!=='V'&&first!=='I')continue;   // E/G behavioural sources cannot be swept
    out.push({ref:ref,label:ref+(c.type==='vcc'?' (rail '+(c.label||c.value||'')+')':'')});
  }
  return out;
}

function simLog(msg,isErr){
  var elx=document.getElementById('sim-log');
  if(elx){elx.textContent+=(isErr?'[ERROR] ':'')+msg+'\n';elx.scrollTop=elx.scrollHeight;}
  if(isErr)console.warn('[sim]',msg);
}
// The status now lives in the compact toolbar strip, so long messages (errors,
// the watchdog notice) get truncated by CSS — the full text stays reachable
// as a native tooltip.
// `pct` (0..100) fills the status strip like a progress bar; omitted = no bar.
function simStatus(msg,pct){
  var elx=document.getElementById('sim-status');
  if(!elx)return;
  elx.textContent=msg;elx.title=msg;
  elx.style.setProperty('--pct',(pct>0?Math.min(100,pct):0)+'%');
}

// ═══ SIMULATION WORKER (with a same-thread fallback) ═══
// The engine (load + setNetList + runSim) normally lives entirely in
// js/sim-worker.js. This is the main-thread side: one lazily-created worker,
// talked to purely via postMessage. simRunToken tags each request so a reply
// for an old, superseded run (or one that arrives after a watchdog restart)
// is ignored.
//
// Module workers can't be loaded from a `file://` page in most browsers (no
// CORS-safe way to fetch the worker script) — that failure is often silent
// (no onerror, just no reply, ever), which used to leave the UI stuck showing
// "Simulating…" forever with the status bar still saying "Idle.". So: if the
// worker doesn't even answer a "preload" ping within a few seconds, or if it
// errors out at any point, simWorkerFailed latches true and every run from
// then on executes right here on the main thread instead (mtRunOnMainThread) —
// functionally identical, just without the responsiveness/kill-a-hung-run
// benefits a working worker gives.
var simWorker=null;
var simWorkerFailed=false;
var simWorkerAlive=false;   // true once any message has ever been received
var simRunToken=0;
var simRunPending=null;   // {token, netlist} while a run's result hasn't arrived yet
var simTicker=null;       // interval id for the "Simulating… (n s)" live status
var simWatchdog=null;

function getSimWorker(){
  if(simWorkerFailed)return null;
  if(simWorker)return simWorker;
  try{
    simWorker=new Worker('js/sim-worker.js',{type:'module'});
  }catch(err){
    simLog('Could not create the simulation worker ('+String(err&&err.message||err)+'); falling back to running NGSpice on this thread.',true);
    simWorkerFailed=true;
    return null;
  }
  simWorker.onmessage=function(e){simWorkerHandleMessage(e.data||{});};
  simWorker.onerror=function(err){
    simLog('Simulation worker failed ('+(err&&(err.message||err.filename+':'+err.lineno)||err)+') — falling back to running NGSpice on this thread. This usually means the page was opened as a local file instead of served over http(s).',true);
    failWorkerAndFallback();
  };
  return simWorker;
}

// Give up on the worker (this run and every future one) and retry whatever
// was in flight, if anything, directly on this thread instead.
function failWorkerAndFallback(){
  if(simWorkerFailed)return;
  simWorkerFailed=true;
  if(simWorker){try{simWorker.terminate();}catch(e){}simWorker=null;}
  if(simRunPending)mtRunOnMainThread(simRunPending.token,simRunPending.netlist);
  else mtEnsureSim().catch(function(err){simLog('WASM preload failed: '+String(err&&err.message||err),true);});
}

// Kick the engine off (worker if it works, main thread otherwise) right away
// instead of waiting for the first Run — see initSimSettings() below.
function preloadSimEngine(){
  var w=getSimWorker();
  if(!w){mtEnsureSim().catch(function(err){simLog('WASM preload failed: '+String(err&&err.message||err),true);});return;}
  w.postMessage({type:'preload'});
  setTimeout(function(){
    if(simWorkerAlive||simWorkerFailed)return;
    simLog('No response from the simulation worker after 3s — assuming it cannot run here (page opened via file:// ?). Falling back to running NGSpice on this thread.',true);
    failWorkerAndFallback();
  },3000);
}

// Start (or restart) the elapsed-time ticker that stands in for real progress
// — the batch engine has no per-timestep hook to report actual progress from,
// so "as live as possible" here means at least showing that it is still going
// and for how long, instead of a frozen "Simulating…".
function startSimTicker(){
  stopSimTicker();
  var t0=simRunT0||(typeof performance!=='undefined'?performance.now():Date.now());
  simTicker=setInterval(function(){
    var now=(typeof performance!=='undefined'?performance.now():Date.now());
    var plan=simPlan,n=plan?plan.runs.length:1;
    if(!plan||n<2){simStatus('Simulating… ('+fmtEng((now-t0)/1000,2,'s')+')');return;}
    // The engine reports no progress inside a run, so the sweep's progress is
    // the finished runs plus a guess for the running one from the average
    // duration of the finished ones (capped below 100 % until it returns).
    var durs=plan.durs||[],avg=durs.length?durs.reduce(function(a,b){return a+b;},0)/durs.length:0;
    var cur=avg?Math.min(0.99,(now-(plan.runT0||now))/avg):0;
    var frac=(plan.i+cur)/n;
    var eta=avg?Math.max(0,(n-plan.i-cur)*avg):0;
    var lbl=plan.runs[plan.i]&&plan.runs[plan.i].label;
    simStatus('Step '+(plan.i+1)+'/'+n+' · '+Math.floor(frac*100)+' %'+
      (eta?' · ~'+fmtEng(eta/1000,2,'s')+' left':'')+' · '+fmtEng((now-t0)/1000,2,'s')+(lbl?' · '+lbl:''),frac*100);
  },200);
}
function stopSimTicker(){
  if(simTicker){clearInterval(simTicker);simTicker=null;}
}

function simWorkerHandleMessage(msg){
  simWorkerAlive=true;
  if(msg.type==='preload-error'){
    simLog('WASM preload failed: '+msg.message,true);
    return;
  }
  // Everything else belongs to a specific run — a token mismatch means a
  // newer run (or a watchdog-triggered worker restart) has already taken over.
  if(msg.token!==undefined&&msg.token!==simRunToken)return;
  if(msg.type==='status'){
    // inside a sweep the ticker already shows step/percent — don't flash over it
    if(!(simPlan&&simPlan.runs.length>1&&simTicker))simStatus(msg.message);
    if(msg.message==='Simulating…'&&!(simPlan&&simPlan.runs.length>1&&simTicker))startSimTicker();
    return;
  }
  if(msg.type==='result'){
    onEngineResult(msg.result,msg.elapsed,msg.errs,msg.info);
    return;
  }
  if(msg.type==='error'){
    stopSimTicker();
    clearTimeout(simWatchdog);
    simPlan=null;
    simStatus('Simulation failed: '+msg.message);
    simLog(msg.stack||msg.message,true);
    endRunUI();
    return;
  }
}

// ═══ MAIN-THREAD FALLBACK ═══
// Only used once the worker is known not to work in this context. Same
// load-once-cache-the-instance shape as js/sim-worker.js's own ensureSim() —
// duplicated rather than shared, since a worker and the main thread can't
// share a module without extra build tooling, and this is short enough that
// the duplication is cheaper than the alternative.
var mtSimInstance=null;
var mtSimStarting=null;
function mtEnsureSim(){
  if(mtSimInstance)return Promise.resolve(mtSimInstance);
  if(mtSimStarting)return mtSimStarting;
  simStatus('Loading NGSpice (WASM)…');
  mtSimStarting=import('https://esm.sh/eecircuit-engine@1.7.0').then(function(mod){
    var Sim=mod.Simulation||(mod.default&&mod.default.Simulation);
    if(!Sim)throw new Error('eecircuit-engine: Simulation export not found');
    var sim=new Sim();
    return Promise.resolve(sim.start()).then(function(){
      mtSimInstance=sim;
      simStatus('NGSpice ready.');
      return sim;
    });
  }).catch(function(err){mtSimStarting=null;throw err;});
  return mtSimStarting;
}
function mtRunOnMainThread(token,netlist){
  startSimTicker();
  mtEnsureSim().then(function(sim){
    sim.setNetList(netlist);
    simStatus('Simulating…');
    var t0=(typeof performance!=='undefined'?performance.now():Date.now());
    return Promise.resolve(sim.runSim()).then(function(result){
      var elapsed=(typeof performance!=='undefined'?performance.now():Date.now())-t0;
      var errs=null,info=null;
      try{errs=sim.getError&&sim.getError();info=sim.getInfo&&sim.getInfo();}catch(e){}
      if(token!==simRunToken)return;
      onEngineResult(result,elapsed,errs||[],info||'');
    });
  }).catch(function(err){
    if(token!==simRunToken)return;
    stopSimTicker();clearTimeout(simWatchdog);
    simPlan=null;
    simStatus('Simulation failed: '+(err&&err.message||err));
    simLog(String(err&&err.stack||err),true);
    endRunUI();
  });
}

// ═══ ANALYSIS SETTINGS UI ═══
function renderAnalysisPanel(){
  var wrap=document.getElementById('sim-analysis-fields');
  if(!wrap)return;
  var sel=document.getElementById('sim-analysis-type');
  if(sel)sel.value=simAnalysis.type;
  var a=simAnalysis,html='';
  function fld(key,label,val,ph,hint){
    return '<div class="sim-field"><label>'+label+'</label>'+
      '<input type="text" data-af="'+key+'" value="'+esc(String(val||''))+'" placeholder="'+esc(ph||'')+'" spellcheck="false">'+
      (hint?'<span class="sim-field-hint">'+hint+'</span>':'')+'</div>';
  }
  if(a.type==='tran'){
    html+='<div class="sim-grid">'+
      fld('tran.tstep','Step time',a.tran.tstep,'50n')+
      fld('tran.tstop','Stop time',a.tran.tstop,'5m')+
      fld('tran.tstart','Start time (opt.)',a.tran.tstart,'0')+
      fld('tran.tmax','Max step (opt.)',a.tran.tmax,'')+
      fld('tran.trtol','Timestep tolerance (TRTOL)',a.tran.trtol,'7','Controls ngspice\'s variable (adaptive) internal timestep — higher = larger/coarser steps, lower = smaller/finer steps. 7 is ngspice\'s own default.')+
      '</div>'+
      '<label class="sim-check"><input type="checkbox" data-af="tran.uic"'+(a.tran.uic?' checked':'')+'> UIC <span class="sim-sub">(use initial conditions, skip operating point)</span></label>';
  }else if(a.type==='dc'){
    var srcs=sweepableSources();
    var opts='<option value="">— pick a source —</option>';
    var found=false;
    for(var i=0;i<srcs.length;i++){
      if(srcs[i].ref===a.dc.src)found=true;
      opts+='<option value="'+esc(srcs[i].ref)+'"'+(srcs[i].ref===a.dc.src?' selected':'')+'>'+esc(srcs[i].label)+'</option>';
    }
    if(a.dc.src&&!found)opts+='<option value="'+esc(a.dc.src)+'" selected>'+esc(a.dc.src)+' (not in schematic)</option>';
    html+='<div class="sim-field"><label>Sweep source</label><select data-af="dc.src">'+opts+'</select></div>'+
      '<div class="sim-grid">'+
      fld('dc.start','Start',a.dc.start,'0')+fld('dc.stop','Stop',a.dc.stop,'5')+fld('dc.step','Increment',a.dc.step,'0.1')+
      '</div>'+
      '<label class="sim-check"><input type="checkbox" data-af="dc.use2"'+(a.dc.use2?' checked':'')+'> Nested second sweep</label>';
    if(a.dc.use2){
      var opts2='<option value="">— pick a source —</option>';
      for(var j=0;j<srcs.length;j++)opts2+='<option value="'+esc(srcs[j].ref)+'"'+(srcs[j].ref===a.dc.src2?' selected':'')+'>'+esc(srcs[j].label)+'</option>';
      html+='<div class="sim-field"><label>Second source</label><select data-af="dc.src2">'+opts2+'</select></div>'+
        '<div class="sim-grid">'+
        fld('dc.start2','Start 2',a.dc.start2,'0')+fld('dc.stop2','Stop 2',a.dc.stop2,'5')+fld('dc.step2','Increment 2',a.dc.step2,'1')+
        '</div>';
    }
  }else if(a.type==='ac'){
    html+='<div class="sim-field"><label>Sweep type</label><select data-af="ac.sweep">'+
      ['dec','oct','lin'].map(function(s){return '<option value="'+s+'"'+(a.ac.sweep===s?' selected':'')+'>'+s+'</option>';}).join('')+
      '</select></div>'+
      '<div class="sim-grid">'+
      fld('ac.pts',a.ac.sweep==='lin'?'Points':'Points/'+(a.ac.sweep==='oct'?'octave':'decade'),a.ac.pts,'20')+
      fld('ac.fstart','Start freq (Hz)',a.ac.fstart,'1')+
      fld('ac.fstop','Stop freq (Hz)',a.ac.fstop,'1Meg')+
      '</div>'+
      '<div class="sim-hint-text">Small-signal frequency sweep — give at least one source a ".ac magnitude" (in its properties) so it excites the circuit.</div>';
  }else if(a.type==='op'){
    html+='<div class="sim-hint-text">Operating point only — the results are shown as a value table.</div>';
  }else{
    html+='<div class="sim-hint-text">Manual mode: write the analysis card yourself in the directives box below (e.g. <code>.ac dec 20 1 1Meg</code>).</div>';
  }
  wrap.innerHTML=html;
  wrap.querySelectorAll('[data-af]').forEach(function(inp){
    var path=inp.getAttribute('data-af').split('.');
    var ev=(inp.tagName==='SELECT'||inp.type==='checkbox')?'change':'input';
    inp.addEventListener(ev,function(){
      var val=inp.type==='checkbox'?inp.checked:inp.value;
      simAnalysis[path[0]][path[1]]=val;
      saveSimSettings();
      updateDirectivePreview();
      // structural switches need the fields rebuilt
      if(path[1]==='use2')renderAnalysisPanel();
    });
  });
  updateDirectivePreview();
}

function updateDirectivePreview(){
  var el=document.getElementById('sim-directive-preview');
  if(!el)return;
  var d=buildAnalysisDirective();
  var o=buildOptionsDirective();
  var combined=[d,o].filter(Boolean).join('\n');
  el.textContent=combined||'(none — add one in the directives box)';
  el.classList.toggle('sim-preview-empty',!combined);
}

function onAnalysisTypeChange(sel){
  simAnalysis.type=sel.value;
  saveSimSettings();
  renderAnalysisPanel();
  if(typeof renderMeasureList==='function')renderMeasureList();
}

// Assemble the full deck: generated devices + analysis card + user directives + .end.
// `paramValues` ({name -> value string}) pins the swept parameters for one run
// of a parameter sweep.
// Nodes that have no DC path to ground. Capacitors and current sources are
// open circuits at DC, so a node fed only through those (e.g. a thermal RC
// ladder driven by a current source) makes the operating-point matrix singular:
// ngspice then falls back to a bogus start state. Works on the generated
// netlist text; elements are over-connected on purpose (all their nodes count
// as joined), so it errs towards "has a path" and never flags a false positive
// for multi-terminal parts. Subcircuit bodies are skipped.
function findFloatingDcNodes(core){
  var parent={};
  function find(a){while(parent[a]!==a){parent[a]=parent[parent[a]];a=parent[a];}return a;}
  function add(a){if(!(a in parent))parent[a]=a;}
  function join(a,b){add(a);add(b);parent[find(a)]=find(b);}
  function norm(n){n=n.toLowerCase();return n==='gnd'?'0':n;}
  add('0');
  var nodesSeen={},depth=0;
  var nCount={r:2,l:2,v:2,d:2,b:2,s:2,w:2,e:4,g:4,h:2,f:2,q:4,j:3,m:4,z:3,t:4};
  core.split('\n').forEach(function(line){
    var t=line.trim();
    if(!t||t[0]==='*'||t[0]==='+')return;
    if(t[0]==='.'){
      if(/^\.subckt\b/i.test(t))depth++;
      else if(/^\.ends\b/i.test(t))depth=Math.max(0,depth-1);
      return;
    }
    if(depth)return;
    var tok=t.split(/\s+/),kind=tok[0][0].toLowerCase();
    var nodes;
    if(kind==='c'||kind==='i'){
      nodes=tok.slice(1,3).map(norm);
      nodes.forEach(function(n){add(n);nodesSeen[n]=true;});
      return;
    }
    if(kind==='x')nodes=tok.slice(1,-1).filter(function(s){return s.indexOf('=')<0&&s.toLowerCase()!=='params:';});
    else if(nCount[kind])nodes=tok.slice(1,1+nCount[kind]);
    else return;
    nodes=nodes.map(norm);
    nodes.forEach(function(n){nodesSeen[n]=true;});
    for(var i=1;i<nodes.length;i++)join(nodes[0],nodes[i]);
    if(nodes.length===1)add(nodes[0]);
  });
  var root=find('0'),out=[];
  for(var n in nodesSeen)if(n in parent&&find(n)!==root)out.push(n);
  return out;
}

function buildFullNetlist(paramValues){
  var core=generateNetlist(paramValues?{paramValues:paramValues}:null);
  var dirEl=document.getElementById('sim-directives');
  var directives=dirEl?(dirEl.value||'').trim():'';
  var lines=[core];
  // Terminal currents (@dev[i], @q1[ic], …) only reach the raw output when they
  // are saved explicitly; ask for them as soon as a current probe, a formula
  // referencing one, or the "save all signals" option is in play.
  var analysis=buildAnalysisDirective();
  var isAc=/^\s*\.ac\b/im.test(analysis+'\n'+directives);
  if(needsCurrents())lines.push(buildSaveLine(isAc));
  // Without a DC path to ground there is no operating point. For a transient
  // run start from zero initial conditions (UIC) instead of letting ngspice
  // fall back to a meaningless "Transient op" state.
  if(/^\s*\.tran\b/i.test(analysis)&&!/\buic\b/i.test(analysis)){
    var floating=findFloatingDcNodes(core);
    if(floating.length){
      analysis+=' uic';
      simLog('Note: no DC path to ground for node(s) '+floating.join(', ')+' (only capacitors/current sources). Starting the transient with UIC (all initial conditions 0).');
    }
  }
  if(analysis)lines.push(analysis);
  var options=buildOptionsDirective();
  if(options)lines.push(options);
  if(directives)lines.push(directives);
  var measures=buildMeasureDirectives();
  if(measures)lines.push(measures);
  lines.push('.end');
  return lines.join('\n');
}

// Current vectors cost memory, so only ask for them when something needs them.
function needsCurrents(){
  var probes=S.probes||[];
  for(var i=0;i<probes.length;i++)if(probes[i].kind==='I')return true;
  for(var j=0;j<simFormulas.length;j++){
    if(simFormulas[j].on!==false&&/[i]\s*\(|@/i.test(simFormulas[j].expr||''))return true;
  }
  for(var mi=0;mi<simMeasurements.length;mi++){
    if(simMeasurements[mi].enabled===false)continue;
    var mline=buildMeasureLine(simMeasurements[mi]);
    if(/[i]\s*\(|@/i.test(mline))return true;
  }
  // a current vector that is selected from a previous run has to stay available
  for(var k in simSelection)if(isCurrentVectorName(k))return true;
  return getRawMode();   // picker open: keep everything pickable
}

// Run/Stop is one button that swaps state, icon and label instead of two
// separate controls: a green ▶ while idle, a red ■ Stop while a simulation is
// in flight. Stop invalidates the current run's token (see simRunToken) and,
// when running in a worker, actually terminates it — the worker is what makes
// a genuine mid-run cancel possible at all (see failWorkerAndFallback's
// comment: the main-thread fallback has no equivalent, since it can't run any
// JS, including a click handler, while its own blocking WASM call is going).
function setRunButtonState(state){
  var btn=document.getElementById('sim-run-btn');
  if(!btn)return;
  var icon=document.getElementById('sim-run-icon'),label=document.getElementById('sim-run-label');
  if(state==='running'){
    btn.classList.remove('state-ready');btn.classList.add('state-running');
    if(icon)icon.textContent='■';
    if(label)label.textContent='STOP';
    btn.title='Stop the running simulation';
    btn.onclick=stopSimulation;
  }else{
    btn.classList.remove('state-running');btn.classList.add('state-ready');
    if(icon)icon.textContent='▶';
    if(label)label.textContent='RUN';
    btn.title='Run the simulation';
    btn.onclick=runSimulation;
  }
}

// User pressed Stop: bump the token so any reply for the run in flight (worker
// or main-thread fallback) is ignored when it eventually arrives, and — if a
// worker is doing the work — kill it outright instead of waiting it out.
function stopSimulation(){
  stopSimTicker();
  clearTimeout(simWatchdog);
  simRunToken++;
  simPlan=null;
  if(simWorker){simWorker.terminate();simWorker=null;}
  simStatus('Simulation stopped.');
  simLog('Simulation stopped by user.');
  showSimPlotPlaceholder('Simulation stopped.');
  endRunUI();
}

// Called when the editor switches to a different schematic (new / opened from
// the library / imported): everything tied to the old one's last run is
// dropped, so the plot, signal list and .measure results never show data of a
// schematic that is no longer open. `resetSetup` (schematic without a stored
// simulation setup, e.g. a fresh one) also returns analysis/formulas/directives
// to their defaults instead of inheriting the previous schematic's.
function resetSimForSchematic(resetSetup){
  if(simRunPending)stopSimulation();
  simLastResult=null;simLastInfoText='';simRuns=null;
  simSelection={};simSelectionAuto=false;
  simSeriesColor={};simColorAssign={};
  simYFit=null;simYFit2=null;
  simCursors=[];
  if(typeof closeMeasureModal==='function')closeMeasureModal();
  simMeasurements.forEach(function(m){delete m.result;});
  if(resetSetup){
    simAnalysis.type='tran';
    simAnalysis.tran={tstep:'50n',tstop:'5m',tstart:'',tmax:'',uic:false,trtol:'7'};
    simAnalysis.dc={src:'',start:'0',stop:'5',step:'0.1',use2:false,src2:'',start2:'0',stop2:'5',step2:'1'};
    simAnalysis.ac={sweep:'dec',pts:'20',fstart:'1',fstop:'1Meg'};
    simFormulas=[];
    simMeasurements=[];
    var d=document.getElementById('sim-directives');if(d)d.value='';
    saveSimSettings();
  }
  showSimPlotPlaceholder('No simulation run yet.');
  simStatus('Idle.');
  if(simPanelOpen){renderAnalysisPanel();renderFormulaList();renderProbeList();renderMeasureList();}
}

// The plot pane pops up (if it wasn't already) the instant Run is pressed —
// with a "Simulating…" placeholder, not stale data from a previous run — and
// gets filled the instant the worker's result message arrives.
function runSimulation(){
  // The parameter sweep is planned first: an invalid setup is reported before
  // anything is started.
  var plan=buildStepPlan();
  if(!plan.ok){
    simStatus(plan.error);
    simLog(plan.error,true);
    return;
  }
  setRunButtonState('running');
  var logEl=document.getElementById('sim-log');if(logEl)logEl.textContent='';
  refreshPowerFormulas();
  if(!simViewActive)setSimView(true);
  showSimPlotPlaceholder('Simulating…');
  var token=++simRunToken;
  simRunT0=(typeof performance!=='undefined'?performance.now():Date.now());
  simPlan={names:plan.names,i:0,done:[],runs:plan.runs.map(function(r){
    var pv={};
    for(var k in r.assign)pv[k]=r.assign[k].str;
    return {assign:r.assign,label:stepLabel(r.assign),netlist:buildFullNetlist(plan.names.length?pv:null)};
  })};
  simLog('--- Netlist sent to NGSpice'+(simPlan.runs.length>1?' (first of '+simPlan.runs.length+' runs)':'')+' ---');
  simLog(simPlan.runs[0].netlist);
  simLog('-------------------------------');
  dispatchPlanRun(token);
}

// "Rl=1k, C=2n" — the tag of one run of a parameter sweep.
function stepLabel(assign){
  var parts=[];
  for(var k in assign)parts.push(k+'='+fmtSpiceEng(assign[k].num,5));
  return parts.join(', ');
}

// Send the plan's current run to the engine (worker, or main thread as fallback).
function dispatchPlanRun(token){
  var run=simPlan.runs[simPlan.i];
  simRunPending={token:token,netlist:run.netlist};
  simPlan.runT0=(typeof performance!=='undefined'?performance.now():Date.now());
  // A fatal ngspice error (e.g. an unknown function in a B-source) can abort
  // the engine without ever posting a reply, which would leave the UI stuck
  // on "Simulating…" forever. The watchdog reports that and — when the engine
  // is running in its worker — actually kills it (terminate()), instead of
  // just abandoning a main-thread call that has no equivalent "stop" button.
  // A fresh worker/engine is created on the next run either way. It is re-armed
  // for every run of a sweep: it limits one simulation, not the whole sweep.
  clearTimeout(simWatchdog);
  simWatchdog=setTimeout(function(){
    stopSimTicker();
    simStatus('No response from NGSpice after 90 s — the engine probably hung (see the log / browser console). A fresh engine will be loaded on the next run.');
    simLog('watchdog: no result after 90 s, dropping the engine',true);
    if(simWorker){simWorker.terminate();simWorker=null;}
    mtSimInstance=null;mtSimStarting=null;
    simPlan=null;
    endRunUI();
  },90000);
  var w=getSimWorker();
  if(w)w.postMessage({type:'run',token:token,netlist:run.netlist});
  else mtRunOnMainThread(token,run.netlist);
}

// One simulation of the plan has come back (worker or fallback). An ordinary run
// goes straight to finishRun(); a sweep collects every run first.
function onEngineResult(result,elapsed,errs,info){
  var plan=simPlan;
  if(!plan||plan.runs.length===1){
    stopSimTicker();clearTimeout(simWatchdog);
    simPlan=null;
    finishRun(result,elapsed,errs,info);
    return;
  }
  var run=plan.runs[plan.i];
  if(errs&&errs.length)errs.forEach(function(e){simLog('['+run.label+'] '+e,true);});
  if(!result||!result.data||!result.data.length){
    stopSimTicker();clearTimeout(simWatchdog);
    simPlan=null;
    simStatus('No data returned for step '+(plan.i+1)+'/'+plan.runs.length+' ('+run.label+'). Check the log.');
    simLog('--- step '+(plan.i+1)+' ('+run.label+') returned no data ---',true);
    if(info)simLog(info);
    showSimPlotPlaceholder('No data returned for step '+(plan.i+1)+' ('+run.label+'). Check the log below.');
    endRunUI();
    return;
  }
  plan.done.push({assign:run.assign,label:run.label,result:result,info:info||''});
  (plan.durs=plan.durs||[]).push((typeof performance!=='undefined'?performance.now():Date.now())-plan.runT0);
  simLog('step '+(plan.i+1)+'/'+plan.runs.length+': '+run.label+' — '+result.numPoints+' point(s)');
  plan.i++;
  if(plan.i<plan.runs.length){
    dispatchPlanRun(simRunToken);
    return;
  }
  stopSimTicker();clearTimeout(simWatchdog);
  simPlan=null;
  var total=(typeof performance!=='undefined'?performance.now():Date.now())-simRunT0;
  finishRun(plan.done[0].result,total,[],plan.done[0].info,{names:plan.names,runs:plan.done});
}

// Result arrived (a sweep: the first run's result plus all runs in `runs`):
// log, parse .measure results, plot.
function finishRun(result,elapsed,errs,info,runs){
  simRuns=runs||null;
  if(errs&&errs.length)errs.forEach(function(e){simLog(e,true);});
  if(info)simLog(info);
  simLastInfoText=info||'';
  parseMeasurements();
  if(!result||!result.data||!result.data.length){
    simStatus('No data returned. Check the directives and the log below.');
    showSimPlotPlaceholder('No data returned. Check the directives and the log below.');
    endRunUI();
    return;
  }
  simLastResult=result;
  simCursors=[];   // a fresh run gets a fresh x grid — old cursor positions no longer apply
  // Carry the signal selection over to the new run: keep what still exists,
  // drop what the netlist no longer produces.
  reconcileSelection(result);
  simStatus('Done: '+(simRuns?simRuns.runs.length+' runs ('+simRuns.names.join(', ')+'), ':'')+result.numPoints+' point(s), '+result.numVariables+' variable(s), '+result.dataType+'.'+
    (elapsed!=null?' ('+fmtEng(elapsed/1000,3,'s')+')':''));
  plotResult(result);
  if(typeof paNotifyData==='function')paNotifyData();
  endRunUI();
}

// Flip the button back to "Run" and refresh the .measure list — the tail end
// of every run, success, failure or user-requested stop alike.
function endRunUI(){
  setRunButtonState('ready');
  simRunPending=null;
  renderMeasureList();
}

// A lightweight placeholder for the plot area — used the instant Run is
// pressed (before any data exists) and if a run comes back empty.
function showSimPlotPlaceholder(msg){
  var container=document.getElementById('sim-plot');
  if(!container)return;
  if(simPlot){simPlot.destroy();simPlot=null;}
  container.innerHTML='<div class="sim-plot-empty">'+esc(msg)+'</div>';
}

// Regex-parse ngspice's own "name = value" (or "name = failed") result lines
// out of the last run's info text — .measure has no dedicated result API in
// eecircuit-engine, this is the same text the log panel already shows.
function escapeRegExp(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function measureResultFromInfo(name,info){
  var re=new RegExp('^\\s*'+escapeRegExp(name)+'\\s*=\\s*(\\S+)','im');
  var match=String(info||'').match(re);
  if(!match)return {ok:false,raw:'no result'};
  var raw=match[1];
  return {ok:raw.toLowerCase()!=='failed'&&isFinite(parseFloat(raw)),raw:raw,value:parseFloat(raw)};
}
function parseMeasurements(){
  for(var i=0;i<simMeasurements.length;i++){
    var m=simMeasurements[i];
    delete m.results;
    if(m.enabled===false||!m.name){m.result=null;continue;}
    // m.result is the first run's (an ordinary run has only that one); a
    // parameter sweep additionally gets one result per run in m.results.
    m.result=measureResultFromInfo(m.name,simLastInfoText);
    if(simRuns){
      m.results=simRuns.runs.map(function(r){return measureResultFromInfo(m.name,r.info);});
    }
  }
}

// ---- result -> numeric helpers (real numbers or {real,img}) ----
function _re(v){return (v&&typeof v==='object')?v.real:v;}
function _mag(v){return (v&&typeof v==='object')?Math.sqrt(v.real*v.real+v.img*v.img):Math.abs(v);}

// Is the full vector list shown below the settings? (display only)
function getRawMode(){var c=document.getElementById('sim-raw-mode');return !!(c&&c.checked);}

// Build {name -> number[]} for every vector of a result (x axis included).
function vectorMapOf(result){
  var conv=(result.dataType==='complex')?_mag:_re;
  var map={};
  for(var i=0;i<result.data.length;i++){
    map[String(result.data[i].name).toLowerCase()]=result.data[i].values.map(conv);
  }
  return map;
}

// Look a vector name up in a result. ngspice itself reports device currents as
// `@r1[i]`, but the WASM engine re-exports them wrapped as `i(@r1[i])` — accept
// both spellings so probes and formulas work either way.
function findVectorKey(map,cand){
  var k=String(cand).toLowerCase();
  if(map[k])return k;
  if(map['i('+k+')'])return 'i('+k+')';
  var m=k.match(/^i\((.+)\)$/);
  if(m&&map[m[1]])return m[1];
  return null;
}

// Resolve an I-probe to the actual result vector (candidate list + sign).
function resolveCurrentProbe(pr,map){
  var comp=S.components.find(function(c){return c.id===pr.compId;});
  if(!comp)return null;
  var cv=currentVectorsForPin(comp,pr.pinIdx);
  if(!cv)return null;
  for(var i=0;i<cv.cands.length;i++){
    var key=map?findVectorKey(map,cv.cands[i]):null;
    if(key){
      var src=map[key],out=new Array(src.length);
      for(var k=0;k<src.length;k++)out[k]=cv.sign*src[k];
      return {label:currentProbeLabel(pr),data:out,cand:key};
    }
  }
  return {label:currentProbeLabel(pr),data:null,cand:cv.cands[0]};
}

function currentProbeLabel(pr){
  var comp=S.components.find(function(c){return c.id===pr.compId;});
  if(!comp)return 'I(?)';
  var cv=currentVectorsForPin(comp,pr.pinIdx);
  var ref=cv?cv.dev.toUpperCase():(comp.label||comp.id);
  var pin=cv?cv.pin:String(pr.pinIdx);
  return 'I('+ref+'.'+pin+')';
}

// ═══ SIGNAL SELECTION ═══
// Vector key a probe refers to, resolved against a result when one is available
// (so a current probe picks whichever candidate ngspice actually produced).
function probeVectorKey(pr,map){
  if(pr.kind==='V')return 'v('+pr.net+')';
  if(pr.kind==='I'){
    var comp=S.components.find(function(c){return c.id===pr.compId;});
    if(!comp)return null;
    var cv=currentVectorsForPin(comp,pr.pinIdx);
    if(!cv)return null;
    if(map){
      for(var i=0;i<cv.cands.length;i++){
        var k=findVectorKey(map,cv.cands[i]);
        if(k)return k;
      }
    }
    return cv.cands[0].toLowerCase();
  }
  return null;   // differential probes are derived, they have no own vector
}

function isCurrentVectorName(k){return /^i\(|@/.test(String(k));}

// Node voltage of a net the user actually drew. Subcircuit internals
// (v(xpwm1.saw) …) and device-internal nodes (v(mm1#gate), the VDMOS gate
// behind RG …) are voltages too, but nobody wants them in the automatic default
// set — they would show up as a crowd of unexplained curves. They stay
// available in the vector list.
function isTopLevelNodeVoltage(vec,nameLower){
  if(!((vec&&vec.type==='voltage')||nameLower.indexOf('v(')===0))return false;
  return nameLower.indexOf('.')<0&&nameLower.indexOf('#')<0;
}

function setSelected(key,on){
  simSelectionAuto=false;
  if(on)simSelection[key]=true;else delete simSelection[key];
}

// A probe is an explicit choice: the first one replaces the automatic
// "all node voltages" set instead of adding to it.
function dropAutoSelection(){
  if(!simSelectionAuto)return;
  simSelectionAuto=false;
  simSelection={};
}

// Match the stored selection against a fresh result: re-derive it while it is
// still automatic, otherwise drop whatever the new netlist no longer contains —
// silently, because a changed schematic legitimately removes signals.
function reconcileSelection(result){
  var map=vectorMapOf(result);
  if(simSelectionAuto){
    simSelection={};
    for(var i=1;i<result.data.length;i++){
      var vv=result.data[i],nm=String(vv.name).toLowerCase();
      if(isTopLevelNodeVoltage(vv,nm))simSelection[nm]=true;
    }
  }else{
    for(var k in simSelection)if(!map[k])delete simSelection[k];
  }
  // Probes follow the same rule; a probe whose vector is gone is dropped.
  if(S.probes&&S.probes.length){
    S.probes=S.probes.filter(function(pr){
      if(pr.kind==='Vd')return !!(map['v('+pr.p+')']&&map['v('+pr.n+')']);
      var key=probeVectorKey(pr,map);
      if(!key||!map[key])return false;
      if(!simSelectionAuto)simSelection[key]=true;  // keep probe and picker in sync
      return true;
    });
  }
  renderProbeList();
}

// key -> probe, so a selected vector that a probe owns is drawn with the
// probe's label (and, for currents, its sign) instead of the raw vector name.
function probeOwners(map){
  var owners={};
  var probes=S.probes||[];
  for(var i=0;i<probes.length;i++){
    var key=probeVectorKey(probes[i],map);
    if(key)owners[key]=probes[i];
  }
  return owners;
}

function buildSeriesFromResult(result){
  var map=vectorMapOf(result);
  var names=[],datas=[];
  var owners=probeOwners(map);
  // 1) selected vectors, in the order ngspice returned them (stable across runs)
  for(var i=1;i<result.data.length;i++){
    var raw=String(result.data[i].name),key=raw.toLowerCase();
    if(!simSelection[key])continue;
    var pr=owners[key];
    if(pr&&pr.kind==='I'){
      var res=resolveCurrentProbe(pr,map);
      if(res&&res.data){names.push(res.label);datas.push(res.data);continue;}
    }
    names.push(pr?_probeLabel(pr):raw);
    datas.push(map[key]);
  }
  // 2) differential probes are computed from two vectors, they have no own one
  var probes=S.probes||[];
  for(var p=0;p<probes.length;p++){
    var pd=probes[p];
    if(pd.kind!=='Vd')continue;
    var kp='v('+pd.p+')',kn='v('+pd.n+')';
    if(!map[kp]||!map[kn])continue;
    var a=map[kp],b=map[kn],diff=new Array(a.length);
    for(var d=0;d<a.length;d++)diff[d]=a[d]-b[d];
    names.push('V('+pd.p+')-V('+pd.n+')');datas.push(diff);
  }
  // 3) user formulas
  appendFormulaSeries(result,map,names,datas);
  return {names:names,datas:datas};
}

// ═══════════════════════════════════════════════════
// USER FORMULAS
// Arbitrary expressions over the result vectors, e.g.
//   V(out)-V(in)        differential voltage
//   V(out)*I(R1)        instantaneous power
//   abs(@r1[i])         any raw vector, any function of Math
// Vector references are matched against the names ngspice actually returned;
// I(dev) is accepted as a shorthand for that device's current vector.
// ═══════════════════════════════════════════════════
var SIM_FN=['abs','sqrt','exp','log10','log','ln','sin','cos','tan','atan','asin','acos','sinh','cosh','tanh','min','max','pow','floor','ceil','round','sign'];

// name -> vector-key aliases so I(R1) resolves to @r1[i] / i(v1).
function formulaAliases(map){
  var al={};
  var refMap=(typeof buildSpiceRefMap==='function')?buildSpiceRefMap():{};
  for(var i=0;i<S.components.length;i++){
    var c=S.components[i];
    var ref=refMap[c.id];
    if(!ref)continue;
    var cv=currentVectorsForPin(c,0);
    if(!cv)continue;
    for(var k=0;k<cv.cands.length;k++){
      var key=findVectorKey(map,cv.cands[k]);
      if(key){al['i('+ref.toLowerCase()+')']=key;break;}
    }
    // Per-terminal aliases I(dev.pin) for the terminals whose vector already
    // is the current INTO the pin (no sign flip), e.g. I(QQ1.C) / I(MM1.D).
    var def=CD[c.type];
    for(var pi=0;def&&pi<def.pins.length;pi++){
      var pcv=currentVectorsForPin(c,pi);
      if(!pcv||pcv.sign!==1)continue;
      for(var pk=0;pk<pcv.cands.length;pk++){
        var pkey=findVectorKey(map,pcv.cands[pk]);
        if(pkey){al['i('+pcv.dev.toLowerCase()+'.'+String(pcv.pin).toLowerCase()+')']=pkey;break;}
      }
    }
  }
  return al;
}

// ═══ POWER-DISSIPATION PROBE ═══
// Clicking a simple device in probe mode adds a formula P(ref) = instantaneous
// power dissipated in it: Vab*I for two-terminal parts, Vce*Ic+Vbe*Ib for BJTs,
// Vds*Id for MOSFETs. Sources, ICs/subcircuits and the ideal reactive parts
// (C, L, transformer: they store, not dissipate) have no such probe.
var POWER_PROBE_TYPES={
  resistor:'two',diode:'two',led:'two',zener:'two',sw:'two',
  npn:'bjt',pnp:'bjt',nmos:'mos',pmos:'mos'
};

function supportsPowerProbe(comp){
  return !!(comp&&POWER_PROBE_TYPES[comp.type]&&buildSpiceRefMap()[comp.id]);
}

// "V(a)-V(b)" between two pin indices with ground (node 0) left out; null when
// both sides are ground / unresolved.
function pinVoltageExpr(comp,ia,ib){
  function net(i){
    var pos=compPinPos(comp,i),n=_probeNet(pos.x,pos.y);
    return (n&&n!=='0')?n:null;
  }
  var a=net(ia),b=net(ib);
  if(a&&b)return a===b?null:'(V('+a+')-V('+b+'))';
  if(a)return 'V('+a+')';
  if(b)return '(-V('+b+'))';
  return null;
}

function powerFormulaExpr(comp){
  var kind=POWER_PROBE_TYPES[comp.type],ref=buildSpiceRefMap()[comp.id];
  if(!kind||!ref)return null;
  var terms=[],v;
  if(kind==='two'){
    v=pinVoltageExpr(comp,0,1);
    if(v)terms.push(v+'*I('+ref+')');
  }else if(kind==='bjt'){            // pins B, C, E
    v=pinVoltageExpr(comp,1,2);if(v)terms.push(v+'*I('+ref+'.C)');
    v=pinVoltageExpr(comp,0,2);if(v)terms.push(v+'*I('+ref+'.B)');
  }else{                             // MOSFET, pins G, D, S
    v=pinVoltageExpr(comp,1,2);if(v)terms.push(v+'*I('+ref+'.D)');
  }
  return terms.length?terms.join('+'):null;
}

// The stored expression names nets as they were numbered when the probe was
// set; unnamed nets get renumbered when the schematic changes. So every run
// re-derives the expression of each power probe from its device (and drops the
// probe when the device is gone or no longer supports one).
function refreshPowerFormulas(){
  var changed=false;
  for(var i=simFormulas.length-1;i>=0;i--){
    var f=simFormulas[i];
    if(!f.powerOf)continue;
    var comp=S.components.find(function(c){return c.id===f.powerOf;});
    var expr=supportsPowerProbe(comp)?powerFormulaExpr(comp):null;
    if(!expr){
      simLog('Power probe '+(f.name||'')+' removed: device gone or both terminals on ground.');
      simFormulas.splice(i,1);changed=true;continue;
    }
    var nm='P('+(comp.label||comp.type)+')';
    if(f.expr!==expr||f.name!==nm){f.expr=expr;f.name=nm;f.error=null;changed=true;}
  }
  if(changed){saveSimSettings();renderFormulaList();}
}

// Toggle P(ref) for a device. Returns true when the click was a power probe.
function togglePowerProbe(compId){
  var comp=S.components.find(function(c){return c.id===compId;});
  if(!supportsPowerProbe(comp))return false;
  var name='P('+(comp.label||comp.type)+')';
  var idx=-1;
  for(var i=0;i<simFormulas.length;i++)if(simFormulas[i].powerOf===comp.id){idx=i;break;}
  if(idx>=0){
    simFormulas.splice(idx,1);
    hint('Probe removed: '+name);
  }else{
    var expr=powerFormulaExpr(comp);
    if(!expr){hint('No power probe: both terminals of '+(comp.label||comp.type)+' are on ground');return true;}
    dropAutoSelection();
    simFormulas.push({name:name,expr:expr,on:true,powerOf:comp.id});
    hint('Power probe added: '+name+' = '+expr);
  }
  saveSimSettings();
  renderFormulaList();
  if(simLastResult)plotResult(simLastResult);
  return true;
}

function escRe(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

// Compile an expression into a per-sample function. Throws on unknown tokens.
function compileFormula(expr,map){
  var norm=String(expr||'').replace(/\s+/g,'').toLowerCase();
  if(!norm)throw new Error('empty expression');
  var aliases=formulaAliases(map);
  var keys=[];
  for(var k in map)keys.push({token:k,key:k});
  for(var a in aliases)if(!map[a])keys.push({token:a,key:aliases[a]});
  keys.sort(function(p,q){return q.token.length-p.token.length;});
  var used=[],idxOf={};
  var work=norm;
  for(var i=0;i<keys.length;i++){
    var t=keys[i].token;
    if(work.indexOf(t)<0)continue;
    if(!(keys[i].key in idxOf)){idxOf[keys[i].key]=used.length;used.push(keys[i].key);}
    work=work.split(t).join('\u0001'+idxOf[keys[i].key]+'\u0002');
  }
  // functions -> Math.*
  for(var f=0;f<SIM_FN.length;f++){
    var fn=SIM_FN[f];
    var mfn=(fn==='ln')?'log':fn;
    work=work.replace(new RegExp('(^|[^a-z0-9_.])'+fn+'\\(','g'),'$1\u0003'+mfn+'(');
  }
  work=work.replace(/\^/g,'**');
  // SPICE-style numeric suffixes (1k, 4.7meg, 100n …) — vectors are already
  // placeholders at this point, so only real numbers can match here.
  work=work.replace(/(\d+\.?\d*|\.\d+)(meg|t|g|k|m|u|µ|n|p|f)(?![a-z0-9_])/g,function(all,num,suf){
    var mult={t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,'µ':1e-6,n:1e-9,p:1e-12,f:1e-15}[suf];
    return '('+(parseFloat(num)*mult)+')';
  });
  // Anything left that looks like an identifier is unknown.
  var leftover=work.replace(/\u0001\d+\u0002/g,'').replace(/\u0003[a-z0-9_]+/g,'');
  var bad=leftover.match(/[a-z_][a-z0-9_]*\([^()]*\)|[a-z_][a-z0-9_]*/g);
  if(bad){
    // allow exponent notation such as 1e-6 (the 'e' is consumed above as ident)
    var real=bad.filter(function(b){return !/^e$/.test(b);});
    if(real.length)throw new Error('unknown vector or function: '+real[0]);
  }
  if(/[^0-9+\-*/().,%\u0001\u0002\u0003a-z_]/.test(work))throw new Error('illegal character in expression');
  var js=work.replace(/\u0001(\d+)\u0002/g,'d[$1][i]').replace(/\u0003/g,'M.');
  var fnBody;
  try{fnBody=new Function('d','i','M','"use strict";return ('+js+');');}
  catch(e){throw new Error('cannot parse expression');}
  return {vectors:used,fn:fnBody};
}

// Evaluate a formula over the whole result; returns a number[].
function evalFormula(expr,map,n){
  var c=compileFormula(expr,map);
  var d=[];
  for(var v=0;v<c.vectors.length;v++)d.push(map[c.vectors[v]]);
  var out=new Array(n);
  for(var i=0;i<n;i++){
    var val=c.fn(d,i,Math);
    out[i]=(typeof val==='number'&&isFinite(val))?val:NaN;
  }
  return out;
}

function appendFormulaSeries(result,map,names,datas){
  var n=result.data[0].values.length;
  for(var i=0;i<simFormulas.length;i++){
    var f=simFormulas[i];
    if(f.on===false||!f.expr)continue;
    try{
      datas.push(evalFormula(f.expr,map,n));
      names.push(f.name||f.expr);
      f.error=null;
    }catch(e){
      f.error=e.message;
      simLog('formula "'+(f.name||f.expr)+'": '+e.message,true);
    }
  }
}

function renderFormulaList(){
  var host=document.getElementById('sim-formula-list');
  if(!host)return;
  var html='';
  for(var i=0;i<simFormulas.length;i++){
    var f=simFormulas[i];
    html+='<div class="sim-formula'+(f.error?' has-error':'')+'" data-siglabel="'+esc(f.name||f.expr||'')+'">'+
      '<input type="checkbox" data-fi="'+i+'" data-fk="on"'+(f.on===false?'':' checked')+' title="plot this formula">'+
      '<span class="sim-swatch"></span>'+
      '<input type="text" class="sim-f-name" data-fi="'+i+'" data-fk="name" value="'+esc(f.name||'')+'" placeholder="name" spellcheck="false">'+
      '<input type="text" class="sim-f-expr" data-fi="'+i+'" data-fk="expr" value="'+esc(f.expr||'')+'" placeholder="V(out)-V(in)" spellcheck="false">'+
      '<button title="remove" onclick="removeFormula('+i+')">&times;</button>'+
      (f.error?'<div class="sim-f-error">'+esc(f.error)+'</div>':'')+
      '</div>';
  }
  if(!simFormulas.length)html='<span class="sim-probe-empty">none — add one to plot e.g. V(out)-V(in) or V(out)*I(R1)</span>';
  host.innerHTML=html;
  applySignalColors();
  host.querySelectorAll('[data-fi]').forEach(function(inp){
    var idx=parseInt(inp.getAttribute('data-fi'),10),key=inp.getAttribute('data-fk');
    inp.addEventListener('change',function(){
      simFormulas[idx][key]=(inp.type==='checkbox')?inp.checked:inp.value;
      if(key==='expr')delete simFormulas[idx].powerOf;   // hand-edited: no longer auto-derived
      simFormulas[idx].error=null;
      saveSimSettings();
      if(simLastResult)plotResult(simLastResult);
      renderFormulaList();
    });
  });
}

function addFormula(){
  simFormulas.push({name:'',expr:'',on:true});
  saveSimSettings();
  renderFormulaList();
}
function removeFormula(i){
  simFormulas.splice(i,1);
  saveSimSettings();
  renderFormulaList();
  if(simLastResult)plotResult(simLastResult);
}

// ═══ MEASUREMENTS (.measure) — sidebar list + config overlay ═══

// Every vector the last run produced (voltages and currents alike) — the
// "live list" signal fields in the measurement overlay pick from this.
function availableSignalNames(){
  if(!simLastResult||!simLastResult.data)return [];
  var out=[];
  for(var i=1;i<simLastResult.data.length;i++)out.push(simLastResult.data[i].name);
  return out;
}

function measureSummary(m){
  if(m.kind==='find_at'){
    var fa=m.findAt||{};
    return 'FIND '+(fa.expr||'?')+' AT='+(fa.at||'?');
  }
  if(m.kind==='find_when'){
    var fw=m.findWhen||{};
    return 'FIND '+(fw.expr||'?')+' WHEN '+(fw.whenSig||'?')+'='+(fw.whenVal||'?');
  }
  if(m.kind==='trig_targ'){
    var tt=m.trigTarg||{};
    return 'delay '+(tt.trigSig||'?')+' → '+(tt.targSig||'?');
  }
  var st=m.stat||{};
  var range=(st.from||st.to)?(' ['+(st.from||'start')+' → '+(st.to||'end')+']'):'';
  return (st.func||'PP')+' of '+(st.sig||'?')+range;
}

function renderMeasureList(){
  if(typeof measureReportOpen==='function'&&measureReportOpen())renderMeasureReport();
  var host=document.getElementById('sim-measure-list');
  if(!host)return;
  var addBtn=document.getElementById('sim-measure-add-btn');
  var kwDisabled=!measureAnalysisKeyword();
  if(addBtn){
    addBtn.disabled=kwDisabled;
    addBtn.title=kwDisabled?'Measurements need a Transient/DC/AC analysis card (not available in Operating-point or Manual mode).':'';
  }
  if(!simMeasurements.length){
    host.innerHTML='<span class="sim-probe-empty">none — add one to read off a delay, threshold or range statistic after each run</span>';
    return;
  }
  var html='';
  for(var i=0;i<simMeasurements.length;i++){
    var m=simMeasurements[i];
    var resHtml;
    if(kwDisabled)resHtml='<span class="sim-measure-result">needs tran/dc/ac</span>';
    else if(!m.result)resHtml='<span class="sim-measure-result">—</span>';
    else if(m.results)resHtml='<span class="sim-measure-result ok" title="smallest … largest value over all runs of the parameter sweep">'+esc(measureRangeText(m))+'</span>';
    else if(m.result.ok)resHtml='<span class="sim-measure-result ok">'+esc(fmtEng(m.result.value,5))+'</span>';
    else resHtml='<span class="sim-measure-result failed">'+esc(m.result.raw||'failed')+'</span>';
    html+='<div class="sim-measure-row" data-siglabel="'+esc(m.name||'')+'">'+
      '<input type="checkbox" data-mi="'+i+'"'+(m.enabled===false?'':' checked')+' title="include in the netlist">'+
      '<span class="sim-measure-name">'+esc(m.name||'?')+'</span>'+
      '<span class="sim-measure-summary">'+esc(measureSummary(m))+'</span>'+
      resHtml+
      '<button title="edit" onclick="openMeasureModal('+i+')">✎</button>'+
      '<button title="remove" onclick="removeMeasurement('+i+')">&times;</button>'+
      '</div>';
  }
  host.innerHTML=html;
  applySignalColors();
  host.querySelectorAll('[data-mi]').forEach(function(inp){
    var idx=parseInt(inp.getAttribute('data-mi'),10);
    inp.addEventListener('change',function(){
      simMeasurements[idx].enabled=inp.checked;
      saveSimSettings();
      renderMeasureList();
    });
  });
}

// ═══ MEASUREMENT REPORT — all measurements as one table ═══
// Rows are {name,type,signals,cond,result,resultCls,enabled}; shared by the
// dialog and the "Copy table" text export.
function measureReportRows(){
  var kwDisabled=!measureAnalysisKeyword();
  return simMeasurements.map(function(m){
    var row={name:m.name||'?',enabled:m.enabled!==false,type:'',signals:'',cond:[]};
    function add(label,v){if(v!==undefined&&v!==null&&String(v)!=='')row.cond.push(label+': '+v);}
    if(m.kind==='find_at'){
      var fa=m.findAt||{};
      row.type='Find at';row.signals=fa.expr||'?';
      add('At',fa.at);
    }else if(m.kind==='find_when'){
      var fw=m.findWhen||{};
      row.type='Find when';row.signals=(fw.expr||'?')+'  when  '+(fw.whenSig||'?')+' = '+(fw.whenVal||'?');
      add('Edge',fw.edge);add('Count',fw.count);add('Delay',fw.td);
    }else if(m.kind==='trig_targ'){
      var tt=m.trigTarg||{};
      row.type='Delay (trig → targ)';
      row.signals=(tt.trigSig||'?')+' → '+(tt.targSig||'?');
      add('Trig',[tt.trigVal&&('= '+tt.trigVal),tt.trigEdge,tt.trigCount&&('#'+tt.trigCount),tt.trigTd&&('td '+tt.trigTd)].filter(Boolean).join(' '));
      add('Targ',[tt.targVal&&('= '+tt.targVal),tt.targEdge,tt.targCount&&('#'+tt.targCount),tt.targTd&&('td '+tt.targTd)].filter(Boolean).join(' '));
    }else{
      var st=m.stat||{};
      row.type='Statistic '+(st.func||'PP');row.signals=st.sig||'?';
      add('From',st.from||'start');add('To',st.to||'end');
    }
    if(kwDisabled){row.result='needs tran/dc/ac';row.resultCls='none';}
    else if(!row.enabled){row.result='disabled';row.resultCls='none';}
    else if(!m.result){row.result='—';row.resultCls='none';}
    else if(m.results){row.result=measureRangeText(m);row.resultCls='';}
    else if(m.result.ok){row.result=fmtEng(m.result.value,5);row.resultCls='';}
    else{row.result=m.result.raw||'failed';row.resultCls='failed';}
    return row;
  });
}

// "min … max" over the runs of a parameter sweep (failed runs left out).
function measureRangeText(m){
  var v=(m.results||[]).filter(function(r){return r.ok;}).map(function(r){return r.value;});
  if(!v.length)return (m.results&&m.results[0]&&m.results[0].raw)||'failed';
  var lo=Math.min.apply(null,v),hi=Math.max.apply(null,v);
  var txt=(lo===hi)?fmtEng(lo,4):fmtEng(lo,4)+' … '+fmtEng(hi,4);
  return v.length<m.results.length?txt+' ('+(m.results.length-v.length)+' failed)':txt;
}

// Selection of the "measurement vs parameter" plot in the report dialog; kept
// across re-renders (and runs) as long as the names still exist.
var simReportSel={meas:null,x:null,log:null,xAuto:null};
var simReportPlot=null;

function reportSweepActive(){return !!(simRuns&&simRuns.runs.length>1);}

function renderMeasureReport(){
  var host=document.getElementById('measure-report-body');
  if(!host)return;
  if(simReportPlot){simReportPlot.destroy();simReportPlot=null;}
  if(!simMeasurements.length){
    host.innerHTML='<div class="report-empty">No measurements yet — add one in the simulation settings.</div>';
    return;
  }
  var html='<table class="report-table"><thead><tr><th>Name</th><th>Type</th><th>Signal(s)</th><th>Settings</th><th style="text-align:right">'+(reportSweepActive()?'Result (min … max)':'Result')+'</th></tr></thead><tbody>';
  measureReportRows().forEach(function(r){
    html+='<tr class="'+(r.enabled?'':'report-off')+'">'+
      '<td class="report-name">'+esc(r.name)+'</td>'+
      '<td>'+esc(r.type)+'</td>'+
      '<td class="report-sig">'+esc(r.signals)+'</td>'+
      '<td class="report-cond">'+(r.cond.length?r.cond.map(esc).join('<br>'):'—')+'</td>'+
      '<td class="report-result '+r.resultCls+'">'+esc(r.result)+'</td></tr>';
  });
  html+='</tbody></table>';
  if(reportSweepActive())html+=sweepReportHtml();
  host.innerHTML=html;
  if(reportSweepActive())initSweepReport(host);
}

// Measurements that produced at least one number in the last sweep.
function sweepMeasurements(){
  return simMeasurements.filter(function(m){
    return m.enabled!==false&&m.name&&m.results&&m.results.some(function(r){return r.ok;});
  });
}

function sweepReportHtml(){
  var runs=simRuns.runs,names=simRuns.names,ms=sweepMeasurements();
  var html='<div class="report-section">Parameter sweep — '+runs.length+' runs</div>';
  html+='<table class="report-table"><thead><tr><th>#</th>'+names.map(function(n){return '<th>'+esc(n)+'</th>';}).join('')+
    simMeasurements.filter(function(m){return m.enabled!==false&&m.name;}).map(function(m){return '<th style="text-align:right">'+esc(m.name)+'</th>';}).join('')+'</tr></thead><tbody>';
  runs.forEach(function(r,ri){
    html+='<tr><td>'+(ri+1)+'</td>'+names.map(function(n){return '<td class="report-sig">'+esc(fmtSpiceEng(r.assign[n].num,5))+'</td>';}).join('');
    simMeasurements.forEach(function(m){
      if(m.enabled===false||!m.name)return;
      var res=m.results&&m.results[ri];
      html+='<td class="report-result'+(res&&res.ok?'':' failed')+'">'+esc(res&&res.ok?fmtEng(res.value,5):(res?res.raw:'—'))+'</td>';
    });
    html+='</tr>';
  });
  html+='</tbody></table>';
  html+='<div class="report-section">Plot — measurement over parameter</div>';
  if(!ms.length){
    html+='<div class="report-empty">No measurement returned a value in this sweep, nothing to plot.</div>';
    return html;
  }
  html+='<div class="report-plot-ctl" id="measure-report-ctl">'+
    ms.map(function(m){
      return '<label class="sim-check"><input type="checkbox" data-rm="'+esc(m.name)+'"> <span class="report-plot-swatch" data-rmc="'+esc(m.name)+'"></span>'+esc(m.name)+'</label>';
    }).join('');
  if(names.length>1){
    html+='<label class="report-plot-x">x axis <select class="sim-select" id="measure-report-x">'+
      names.map(function(n){return '<option value="'+esc(n)+'">'+esc(n)+'</option>';}).join('')+'</select></label>';
  }
  html+='<label class="sim-check"><input type="checkbox" id="measure-report-log"> log x</label></div>'+
    '<div id="measure-report-plot" class="report-plot"></div>';
  return html;
}

function initSweepReport(host){
  var ms=sweepMeasurements();
  if(!ms.length)return;
  var names=simRuns.names;
  if(!simReportSel.meas)simReportSel.meas={};
  // keep only measurements that still exist; default to the first one
  var valid={};ms.forEach(function(m){valid[m.name]=true;});
  for(var k in simReportSel.meas)if(!valid[k])delete simReportSel.meas[k];
  if(!Object.keys(simReportSel.meas).length)simReportSel.meas[ms[0].name]=true;
  if(!simReportSel.x||names.indexOf(simReportSel.x)<0)simReportSel.x=names[names.length-1];
  if(simReportSel.log==null||simReportSel.xAuto!==simReportSel.x){
    // logarithmic parameter steps are shown on a log axis by default
    var pd=paramDefs().filter(function(p){return p.name===simReportSel.x;})[0];
    simReportSel.log=!!(pd&&pd.step&&(pd.step.type==='dec'||pd.step.type==='oct'));
    simReportSel.xAuto=simReportSel.x;
  }
  host.querySelectorAll('[data-rm]').forEach(function(cb){
    cb.checked=!!simReportSel.meas[cb.getAttribute('data-rm')];
    cb.addEventListener('change',function(){
      if(cb.checked)simReportSel.meas[cb.getAttribute('data-rm')]=true;else delete simReportSel.meas[cb.getAttribute('data-rm')];
      drawReportPlot();
    });
  });
  var xs=document.getElementById('measure-report-x');
  if(xs){
    xs.value=simReportSel.x;
    xs.addEventListener('change',function(){simReportSel.x=xs.value;simReportSel.log=null;initSweepReport(host);});
  }
  var lg=document.getElementById('measure-report-log');
  if(lg){
    lg.checked=!!simReportSel.log;
    lg.addEventListener('change',function(){simReportSel.log=lg.checked;simReportSel.xAuto=simReportSel.x;drawReportPlot();});
  }
  drawReportPlot();
}

// Measurement values over the chosen parameter. Further swept parameters split
// the plot into one dashed/solid curve family per combination.
function drawReportPlot(){
  var box=document.getElementById('measure-report-plot');
  if(!box)return;
  if(simReportPlot){simReportPlot.destroy();simReportPlot=null;}
  box.innerHTML='';
  var ms=sweepMeasurements().filter(function(m){return simReportSel.meas[m.name];});
  document.querySelectorAll('[data-rmc]').forEach(function(sw){
    var idx=ms.map(function(m){return m.name;}).indexOf(sw.getAttribute('data-rmc'));
    sw.style.background=idx>=0?SIM_PALETTE[idx%SIM_PALETTE.length]:'transparent';
  });
  if(!ms.length){box.innerHTML='<div class="report-empty">Tick a measurement to plot it.</div>';return;}
  if(typeof uPlot==='undefined'){box.textContent='Plot library (uPlot) not loaded — check your network connection.';return;}
  var xName=simReportSel.x,others=simRuns.names.filter(function(n){return n!==xName;});
  var runs=simRuns.runs;
  // x grid: every distinct value of the chosen parameter
  var xSet={};runs.forEach(function(r){xSet[r.assign[xName].str]=r.assign[xName].num;});
  var xStrs=Object.keys(xSet).sort(function(a,b){return xSet[a]-xSet[b];});
  var xVals=xStrs.map(function(k){return xSet[k];});
  // groups: one per combination of the other swept parameters
  var groups=[],gIdx={};
  runs.forEach(function(r){
    var key=others.map(function(n){return r.assign[n].str;}).join('|');
    if(gIdx[key]==null){gIdx[key]=groups.length;groups.push({key:key,label:others.map(function(n){return n+'='+fmtSpiceEng(r.assign[n].num,5);}).join(', ')});}
  });
  var cell={};
  runs.forEach(function(r,ri){
    var key=others.map(function(n){return r.assign[n].str;}).join('|');
    cell[key+'#'+r.assign[xName].str]=ri;
  });
  var series=[{label:xName,value:function(u,v){return fmtEng(v,5);}}],data=[xVals];
  var oneGroup=groups.length===1;
  ms.forEach(function(m,mi){
    groups.forEach(function(g,gi){
      var d=xStrs.map(function(xs){
        var ri=cell[g.key+'#'+xs];
        var res=ri!=null&&m.results[ri];
        return (res&&res.ok)?res.value:null;
      });
      series.push({label:m.name+(oneGroup?'':' · '+g.label),stroke:SIM_PALETTE[mi%SIM_PALETTE.length],width:2,
        dash:STEP_DASHES[gi%STEP_DASHES.length],spanGaps:true,points:{show:true,size:6},
        value:function(u,v){return fmtEng(v,6);}});
      data.push(d);
    });
  });
  var logX=!!simReportSel.log&&xVals.every(function(v){return v>0;});
  simReportPlot=new uPlot({
    width:Math.max(300,box.clientWidth||700),height:300,padding:[10,18,4,4],
    series:series,
    scales:{x:{time:false,distr:logX?3:1},y:{range:function(u,a,b){return simAutoRange(a,b);}}},
    cursor:{drag:{x:true,y:false}},
    legend:{live:true},
    axes:[
      {stroke:SIM_AXIS_TEXT,font:SIM_AXIS_FONT,grid:{stroke:SIM_AXIS_GRID},ticks:{stroke:SIM_AXIS_GRID},
       values:function(u,ticks){return ticks.map(function(t){return t==null?'':fmtEng(t,4);});}},
      {scale:'y',stroke:SIM_AXIS_TEXT,font:SIM_AXIS_FONT,grid:{stroke:SIM_AXIS_GRID},ticks:{stroke:SIM_AXIS_GRID},
       size:simYAxisSize,values:function(u,ticks){return axisValuesSI(u,ticks,'y','');}}
    ]
  },data,box);
}

function measureReportOpen(){
  var m=document.getElementById('measure-report-modal');
  return !!m&&m.style.display!=='none';
}
function showMeasureReport(){
  var modal=document.getElementById('measure-report-modal');
  if(!modal)return;
  modal.style.display='flex';
  renderMeasureReport();   // after display: the sweep plot sizes itself to the visible box
  modal.onclick=function(e){if(e.target===modal)closeMeasureReport();};
}
function closeMeasureReport(){
  var modal=document.getElementById('measure-report-modal');
  if(modal)modal.style.display='none';
}
function copyMeasureReport(){
  var lines=['Name\tType\tSignal(s)\tSettings\tResult'];
  measureReportRows().forEach(function(r){
    lines.push([r.name,r.type,r.signals,r.cond.join('; '),r.result].join('\t'));
  });
  if(reportSweepActive()){
    var ms2=simMeasurements.filter(function(m){return m.enabled!==false&&m.name;});
    lines.push('');
    lines.push(['#'].concat(simRuns.names,ms2.map(function(m){return m.name;})).join('\t'));
    simRuns.runs.forEach(function(r,ri){
      lines.push([ri+1].concat(simRuns.names.map(function(n){return paramNumStr(r.assign[n].num);}),
        ms2.map(function(m){var res=m.results&&m.results[ri];return res&&res.ok?String(res.value):(res?res.raw:'');})).join('\t'));
    });
  }
  var text=lines.join('\n');
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(function(){hint('Measurement table copied');},function(){hint('Copy failed');});
  else hint('Clipboard not available');
}
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&measureReportOpen())closeMeasureReport();
});

function removeMeasurement(i){
  simMeasurements.splice(i,1);
  saveSimSettings();
  renderMeasureList();
}

function nextMeasureName(){
  var used={};
  simMeasurements.forEach(function(m){used[m.name]=true;});
  var n=1;
  while(used['meas'+n])n++;
  return 'meas'+n;
}

// First/last x value of the last run (start/end of the sweep) — the default
// range statistics start with, so a fresh measurement reads "whole run" up
// front instead of an empty FROM/TO.
function sweepBounds(){
  var xv=simLastResult&&simLastResult.data&&simLastResult.data[0]&&simLastResult.data[0].values;
  if(!xv||!xv.length)return null;
  return [_re(xv[0]),_re(xv[xv.length-1])];
}

function newMeasurementDraft(){
  var b=sweepBounds();
  return {
    id:'m'+(MEASURE_NEXT_ID++),
    name:nextMeasureName(),
    enabled:true,
    kind:'stat',
    stat:{func:'PP',sig:'',from:b?fmtSpiceEng(b[0],6):'',to:b?fmtSpiceEng(b[1],6):''},
    findAt:{expr:'',at:''},
    findWhen:{expr:'',whenSig:'',whenVal:'',td:'',edge:'CROSS',count:''},
    trigTarg:{trigSig:'',trigVal:'',trigEdge:'RISE',trigCount:'',trigTd:'',
              targSig:'',targVal:'',targEdge:'RISE',targCount:'',targTd:''}
  };
}

// Which draft field each plot cursor drives, per kind — one table shared by
// the "grab from cursor" buttons (mfld's opts.cursorTime) and the live
// auto-sync below, so the two never drift apart.
var MEASURE_CURSOR_TIME_FIELDS={
  stat:{1:'stat.from',2:'stat.to'},
  find_at:{1:'findAt.at'},
  find_when:{1:'findWhen.td'},
  trig_targ:{1:'trigTarg.trigTd',2:'trigTarg.targTd'}
};

// Signal fields per kind, in fill order — drives both the default "probe
// target" when the overlay opens (no click into a field needed first) and
// the auto-advance after each probe (trig then targ, or expr then when-sig).
var MEASURE_SIGNAL_FIELDS_BY_KIND={
  stat:['stat.sig'],
  find_at:['findAt.expr'],
  find_when:['findWhen.expr','findWhen.whenSig'],
  trig_targ:['trigTarg.trigSig','trigTarg.targSig']
};

// Placing/moving a cursor while the overlay is open re-fills whichever time
// field(s) that cursor drives for the current kind — no manual grab-button
// click needed while you're actively dialing in a window on the plot.
function syncMeasureDraftCursorTimes(){
  if(!simMeasureDraft)return;
  var d=simMeasureDraft.data;
  var map=MEASURE_CURSOR_TIME_FIELDS[d.kind];
  if(!map)return;
  var changed=false;
  [1,2].forEach(function(n){
    var path=map[n];
    if(!path)return;
    var c=simCursors[n-1];
    if(!c)return;
    var cv=cursorValuesAt(c.idx);
    if(!cv)return;
    var p=path.split('.');
    d[p[0]][p[1]]=fmtSpiceEng(cv.x,6);
    changed=true;
  });
  if(changed)renderMeasureModal();
}

// Probing a net/pin on the schematic while the overlay is open drops that
// signal straight into whichever signal field you last focused — the same
// "grab it live" idea as the cursor auto-sync above, just sourced from the
// canvas instead of the plot. Only fires for newly *added* probes (the call
// sites in toggleProbeAt/addDiffProbe skip it on removal).
// Does `expr` resolve to (a) real vector(s) from the last run? We only ever
// generate two shapes ourselves — a bare vector name, or our own
// "V(a)-V(b)" differential form — so a plain membership check plus splitting
// that one known shape covers everything, no general expression parser
// needed. Formula names (e.g. a user-defined "P_R1") are deliberately NOT
// found here: ngspice's own .measure only ever sees real netlist vectors, it
// has no idea our formulas exist (those are computed client-side, after the
// run) — so a formula name is exactly as "not a real signal" as a stale or
// misspelled one, and gets the same warn-and-discard treatment.
function measureExprResolvable(expr){
  var names=availableSignalNames();
  if(!names.length)return false;
  var have={};
  for(var i=0;i<names.length;i++)have[names[i].toLowerCase()]=true;
  var diff=/^V\(([^)]+)\)-V\(([^)]+)\)$/i.exec(expr);
  if(diff)return !!(have['v('+diff[1].toLowerCase()+')']&&have['v('+diff[2].toLowerCase()+')']);
  return !!have[String(expr).toLowerCase()];
}

// Surface a probe-fill problem both in the status bar (consistent with every
// other probe message) and inline in the still-open overlay (reusing the
// name-validation error slot — this call site never re-renders on failure,
// so the element is still the one currently in the DOM).
function showMeasureModalWarning(msg){
  hint(msg);
  var el=document.getElementById('measure-modal-error');
  if(el)el.textContent=msg;
}

// Drops the canvas probe (and its plotted vector) that stands for `vec`, if any.
// Only probes are touched — a signal ticked by hand in the picker stays.
function removeProbeForVector(vec){
  if(!S.probes||!S.probes.length)return;
  var want=String(vec).toLowerCase().replace(/\s+/g,'');
  var map=simLastResult?vectorMapOf(simLastResult):null;
  for(var i=0;i<S.probes.length;i++){
    var pr=S.probes[i],key;
    if(pr.kind==='V')key='v('+pr.net+')';
    else if(pr.kind==='Vd')key='v('+pr.p+')-v('+pr.n+')';
    else key=probeVectorKey(pr,map);
    if(key&&String(key).toLowerCase().replace(/\s+/g,'')===want){
      S.probes.splice(i,1);
      setSelected(String(key).toLowerCase(),false);
      return;
    }
  }
}

function feedProbeToMeasureModal(pr){
  if(!simMeasureDraft)return;
  var d=simMeasureDraft.data;
  var fields=MEASURE_SIGNAL_FIELDS_BY_KIND[d.kind]||[];
  if(!fields.length)return;
  // Target whichever field was last focused, if it belongs to the current
  // kind — otherwise (nothing focused yet, e.g. right after opening the
  // overlay) default to the first signal field so a probe works immediately.
  var path=(simMeasureActiveSigPath&&fields.indexOf(simMeasureActiveSigPath)>=0)?simMeasureActiveSigPath:fields[0];
  // Resolved the same way the plot resolves a current probe (probeVectorKey
  // tries every candidate vector against the last run — this is exactly how
  // e.g. an inductor's two pins both land on its single "@l1[i]" branch
  // current instead of conflicting).
  var vec=(pr.kind==='Vd')
    ?('V('+pr.p+')-V('+pr.n+')')
    :probeVectorKey(pr,simLastResult?vectorMapOf(simLastResult):null);
  if(!vec)return;
  if(!simLastResult){
    showMeasureModalWarning('Run the simulation once before probing a signal into a measurement — there\'s no result yet to check it against.');
    return;
  }
  if(!measureExprResolvable(vec)){
    showMeasureModalWarning('Probed signal "'+vec+'" isn\'t among the last run\'s vectors — discarded. (A formula result can\'t be used here either: .measure only sees ngspice\'s own vectors.)');
    return;
  }
  var p=path.split('.');
  // Probing into this dialog never touches the plot probes (see probeIntoMeasurement).
  d[p[0]][p[1]]=vec;
  // Advance to the next signal field of this kind (trig -> targ, expr -> when-
  // signal), so a second probe click fills the next slot without having to
  // click into it by hand first.
  var idx=fields.indexOf(path);
  simMeasureActiveSigPath=(idx>=0&&idx+1<fields.length)?fields[idx+1]:path;
  renderMeasureModal();
}

// index===-1 opens a fresh draft; otherwise a deep copy of simMeasurements[index]
// so Cancel leaves the stored entry untouched.
function openMeasureModal(index){
  var data=(index>=0&&simMeasurements[index])
    ?JSON.parse(JSON.stringify(simMeasurements[index]))
    :newMeasurementDraft();
  simMeasureDraft={index:index,data:data};
  // Default probe target is the kind's first signal field, so probing works
  // right after opening the overlay — no click into a field needed first.
  simMeasureActiveSigPath=(MEASURE_SIGNAL_FIELDS_BY_KIND[data.kind]||[])[0]||null;
  var modal=document.getElementById('measure-modal');
  if(!modal)return;
  renderMeasureModal();
  modal.style.display='block';
  // No full-screen backdrop (see .measure-modal-body / #measure-modal CSS) —
  // the plot stays clickable behind it so cursors can still be placed while
  // the overlay is open. Reset to the default docked position each time it's
  // (re)opened, in case a previous drag left it somewhere awkward, then clamp
  // its height so it doesn't itself sit on top of the plot pane.
  modal.style.left='';modal.style.top='';modal.style.right='';
  positionMeasureModalClearOfPlot(modal);
  initMeasureModalDrag();
}

// The overlay docks top-right by default (see .measure-overlay CSS), clear of
// the plot in most window sizes — but the plot pane is user-resizable, so
// clamp the overlay's height to whatever room is actually left above it
// rather than trusting a fixed vh guess.
function positionMeasureModalClearOfPlot(modal){
  var content=modal.querySelector('.modal-content');
  if(!content)return;
  content.style.maxHeight='';
  var pane=document.getElementById('sim-pane');
  if(!pane||pane.style.display==='none')return;
  var paneTop=pane.getBoundingClientRect().top;
  var modalTop=modal.getBoundingClientRect().top;
  var avail=paneTop-modalTop-12;
  if(avail>150)content.style.maxHeight=avail+'px';
}
function closeMeasureModal(){
  simMeasureDraft=null;
  simMeasureActiveSigPath=null;
  var modal=document.getElementById('measure-modal');
  if(modal)modal.style.display='none';
}

// Drag the overlay by its header — there's no backdrop to click through, so
// this is the way out if it ends up sitting over the plot. Bound once.
var measureModalDragInit=false;
function initMeasureModalDrag(){
  if(measureModalDragInit)return;
  measureModalDragInit=true;
  var modal=document.getElementById('measure-modal');
  var header=modal&&modal.querySelector('.modal-header');
  if(!modal||!header)return;
  var dragging=false,startX,startY,startLeft,startTop;
  header.addEventListener('mousedown',function(e){
    if(e.target.closest&&e.target.closest('.modal-close'))return;
    dragging=true;
    var r=modal.getBoundingClientRect();
    startX=e.clientX;startY=e.clientY;startLeft=r.left;startTop=r.top;
    modal.style.right='';modal.style.left=startLeft+'px';modal.style.top=startTop+'px';
    e.preventDefault();
  });
  document.addEventListener('mousemove',function(e){
    if(!dragging)return;
    modal.style.left=Math.max(0,startLeft+(e.clientX-startX))+'px';
    modal.style.top=Math.max(0,startTop+(e.clientY-startY))+'px';
  });
  document.addEventListener('mouseup',function(){dragging=false;});
}
function deleteMeasureModal(){
  if(!simMeasureDraft||simMeasureDraft.index<0)return;
  simMeasurements.splice(simMeasureDraft.index,1);
  saveSimSettings();
  closeMeasureModal();
  renderMeasureList();
}
function saveMeasureModal(){
  if(!simMeasureDraft)return;
  var d=simMeasureDraft.data;
  var errEl=document.getElementById('measure-modal-error');
  var name=(d.name||'').trim();
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)){
    if(errEl)errEl.textContent='Name must be a valid identifier (letters, digits, _ — starting with a letter or _).';
    return;
  }
  var clash=false;
  for(var i=0;i<simMeasurements.length;i++){
    if(i!==simMeasureDraft.index&&simMeasurements[i].name===name)clash=true;
  }
  if(clash){
    if(errEl)errEl.textContent='Another measurement already uses this name.';
    return;
  }
  d.name=name;
  if(simMeasureDraft.index>=0)simMeasurements[simMeasureDraft.index]=d;
  else simMeasurements.push(d);
  saveSimSettings();
  closeMeasureModal();
  renderMeasureList();
}

// One labeled field, plain text or (opts.signal) a text field with a live,
// filtered dropdown of availableSignalNames() (the same list the "Result
// vectors" picker shows) underneath — shown as soon as the field is focused
// and re-filtered on every keystroke, not hidden behind a native <select> or
// <datalist> popup (those only opened on a second click, which wasn't
// obvious). Free text is still accepted; the dropdown is a suggestion list,
// not a hard constraint. Optionally a cursor grab button. opts.cursorTime: N
// -> fill from plot cursor N's x value. opts.cursorVal: '<path.to.signal>' ->
// fill from cursor 1's y value on whichever signal that other field names.
function mfld(path,label,val,opts){
  opts=opts||{};
  var btn='';
  if(opts.cursorTime){
    btn='<button type="button" class="sim-cursor-grab" data-mf-cursor="'+path+'" data-mf-cursor-n="'+opts.cursorTime+'" title="fill from plot cursor '+opts.cursorTime+'">⌖'+opts.cursorTime+'</button>';
  }else if(opts.cursorVal){
    btn='<button type="button" class="sim-cursor-grab" data-mf-cursor="'+path+'" data-mf-cursor-sig="'+opts.cursorVal+'" title="fill from cursor 1, at the picked signal">⌖</button>';
  }
  if(opts.signal){
    return '<div class="sim-field measure-field-row measure-sig-field"><label>'+label+'</label>'+
      '<input type="text" data-mf="'+path+'" data-mf-sig="1" value="'+esc(String(val==null?'':val))+'" autocomplete="off" spellcheck="false">'+
      '<div class="measure-sig-dropdown" data-mf-sig-dropdown="'+path+'"></div>'+
      btn+'</div>';
  }
  return '<div class="sim-field measure-field-row"><label>'+label+'</label>'+
    '<input type="text" data-mf="'+path+'" value="'+esc(String(val==null?'':val))+'" spellcheck="false">'+
    btn+'</div>';
}
function edgeSelect(path,val){
  return '<div class="sim-field"><label>Edge</label><select data-mf="'+path+'">'+
    ['RISE','FALL','CROSS'].map(function(e){return '<option value="'+e+'"'+((val||'CROSS')===e?' selected':'')+'>'+e+'</option>';}).join('')+
    '</select></div>';
}

function updateMeasurePreview(){
  var el=document.getElementById('measure-preview');
  if(!el||!simMeasureDraft)return;
  var line=buildMeasureLine(simMeasureDraft.data);
  el.textContent=line||'(fill in the required fields)';
  var errEl=document.getElementById('measure-modal-error');
  if(errEl)errEl.textContent='';
}

function renderMeasureModal(){
  var body=document.getElementById('measure-modal-body');
  if(!body||!simMeasureDraft)return;
  var d=simMeasureDraft.data;
  var kindOpts=[['stat','Range statistic (MAX / MIN / PP / AVG / RMS / INTEG)'],
                ['find_at','Find value at a fixed time'],
                ['find_when','Find value when a signal crosses a level'],
                ['trig_targ','Trigger → Target (delay)']];
  var html='<div class="sim-field"><label>Name</label>'+
    '<input type="text" id="measure-name-input" value="'+esc(d.name||'')+'" spellcheck="false"></div>'+
    '<div class="sim-field"><label>Type</label><select id="measure-kind-select">'+
    kindOpts.map(function(o){return '<option value="'+o[0]+'"'+(d.kind===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('')+
    '</select></div>';

  if(!availableSignalNames().length)html+='<div class="sim-hint-text">Run the simulation once to populate the signal list.</div>';
  html+='<div class="sim-hint-text">Tip: switch to PROBE mode and probe a net or pin on the schematic — it fills the signal field directly (click into a different field first to target that one instead).</div>';

  if(d.kind==='find_at'){
    html+=mfld('findAt.expr','Signal',d.findAt.expr,{signal:true})+
      mfld('findAt.at','At time',d.findAt.at,{cursorTime:1});
  }else if(d.kind==='find_when'){
    html+=mfld('findWhen.expr','Signal to read',d.findWhen.expr,{signal:true})+
      mfld('findWhen.whenSig','…when this signal',d.findWhen.whenSig,{signal:true})+
      mfld('findWhen.whenVal','…crosses this level',d.findWhen.whenVal,{cursorVal:'findWhen.whenSig'})+
      '<div class="sim-grid">'+
      mfld('findWhen.td','Delay (TD, opt.)',d.findWhen.td,{cursorTime:1})+
      edgeSelect('findWhen.edge',d.findWhen.edge)+
      mfld('findWhen.count','Occurrence # (opt.)',d.findWhen.count,{})+
      '</div>';
  }else if(d.kind==='trig_targ'){
    html+='<div class="sim-hint-text">TRIG — the starting event:</div>'+
      mfld('trigTarg.trigSig','Signal',d.trigTarg.trigSig,{signal:true})+
      mfld('trigTarg.trigVal','Level (VAL)',d.trigTarg.trigVal,{cursorVal:'trigTarg.trigSig'})+
      '<div class="sim-grid">'+
      mfld('trigTarg.trigTd','Delay (TD, opt.)',d.trigTarg.trigTd,{cursorTime:1})+
      edgeSelect('trigTarg.trigEdge',d.trigTarg.trigEdge)+
      mfld('trigTarg.trigCount','Occurrence # (opt.)',d.trigTarg.trigCount,{})+
      '</div>'+
      '<div class="sim-hint-text">TARG — the ending event:</div>'+
      mfld('trigTarg.targSig','Signal',d.trigTarg.targSig,{signal:true})+
      mfld('trigTarg.targVal','Level (VAL)',d.trigTarg.targVal,{cursorVal:'trigTarg.targSig'})+
      '<div class="sim-grid">'+
      mfld('trigTarg.targTd','Delay (TD, opt.)',d.trigTarg.targTd,{cursorTime:2})+
      edgeSelect('trigTarg.targEdge',d.trigTarg.targEdge)+
      mfld('trigTarg.targCount','Occurrence # (opt.)',d.trigTarg.targCount,{})+
      '</div>';
  }else{
    html+='<div class="sim-field"><label>Function</label><select data-mf="stat.func">'+
      ['MAX','MIN','PP','AVG','RMS','INTEG'].map(function(f){return '<option value="'+f+'"'+(d.stat.func===f?' selected':'')+'>'+f+'</option>';}).join('')+
      '</select></div>'+
      mfld('stat.sig','Signal',d.stat.sig,{signal:true})+
      '<div class="sim-grid">'+
      mfld('stat.from','From (opt.)',d.stat.from,{cursorTime:1})+
      mfld('stat.to','To (opt.)',d.stat.to,{cursorTime:2})+
      '</div>';
  }

  html+='<div class="sim-hint-text">Card: <code id="measure-preview"></code></div>'+
    '<div id="measure-modal-error" class="sim-f-error"></div>'+
    '<div class="measure-modal-footer">'+
      (simMeasureDraft.index>=0?'<button class="tb-btn" onclick="deleteMeasureModal()">Delete</button>':'')+
      '<span style="flex:1"></span>'+
      '<button class="tb-btn" onclick="closeMeasureModal()">Cancel</button>'+
      '<button class="tb-btn tb-btn-sim" onclick="saveMeasureModal()">Save</button>'+
    '</div>';

  body.innerHTML=html;
  updateMeasurePreview();

  var nameInput=document.getElementById('measure-name-input');
  if(nameInput)nameInput.addEventListener('input',function(){d.name=nameInput.value;updateMeasurePreview();});
  var kindSel=document.getElementById('measure-kind-select');
  if(kindSel)kindSel.addEventListener('change',function(){
    d.kind=kindSel.value;
    simMeasureActiveSigPath=(MEASURE_SIGNAL_FIELDS_BY_KIND[d.kind]||[])[0]||null;
    renderMeasureModal();
  });

  body.querySelectorAll('[data-mf]').forEach(function(inp){
    var path=inp.getAttribute('data-mf').split('.');
    var ev=(inp.tagName==='SELECT')?'change':'input';
    inp.addEventListener(ev,function(){
      d[path[0]][path[1]]=inp.value;
      updateMeasurePreview();
    });
  });
  body.querySelectorAll('[data-mf-cursor]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var path=btn.getAttribute('data-mf-cursor').split('.');
      var n=btn.getAttribute('data-mf-cursor-n');
      var sigPath=btn.getAttribute('data-mf-cursor-sig');
      if(n){
        var cIdx=simCursors[parseInt(n,10)-1]&&simCursors[parseInt(n,10)-1].idx;
        var cv=cursorValuesAt(cIdx);
        if(!cv){hint('Place cursor '+n+' on the plot first (click a curve).');return;}
        d[path[0]][path[1]]=fmtSpiceEng(cv.x,6);
      }else if(sigPath){
        var sp=sigPath.split('.');
        var sigName=d[sp[0]][sp[1]];
        if(!sigName){hint('Pick a signal first.');return;}
        var c1Idx=simCursors[0]&&simCursors[0].idx;
        var cv1=cursorValuesAt(c1Idx);
        if(!cv1){hint('Place a cursor on the plot first (click a curve).');return;}
        var match=null;
        for(var si=0;si<cv1.series.length;si++){
          if(String(cv1.series[si].label).toLowerCase()===String(sigName).toLowerCase()){match=cv1.series[si];break;}
        }
        if(!match||match.value==null){hint('That signal isn\'t currently plotted at the cursor.');return;}
        d[path[0]][path[1]]=fmtSpiceEng(match.value,6);
      }
      renderMeasureModal();
    });
  });

  // Signal fields: a filtered dropdown shown on focus (and re-filtered on
  // every keystroke) instead of relying on a native popup that only opened
  // on a second click. Selecting an item just writes the input's value and
  // replays the same 'input' event the [data-mf] loop above already listens
  // for, so the draft update / preview refresh stays in one place.
  body.querySelectorAll('[data-mf-sig]').forEach(function(inp){
    var path=inp.getAttribute('data-mf');
    var dd=body.querySelector('[data-mf-sig-dropdown="'+path+'"]');
    if(!dd)return;
    function renderDropdown(){
      var q=inp.value.toLowerCase();
      var all=availableSignalNames();
      var names=all.filter(function(n){return !q||n.toLowerCase().indexOf(q)>=0;});
      if(!names.length){
        dd.innerHTML='<div class="measure-sig-empty">'+
          (all.length?'no match':'run the simulation once to populate the signal list')+'</div>';
      }else{
        dd.innerHTML=names.map(function(n){return '<div class="measure-sig-item" data-sig-name="'+esc(n)+'">'+esc(n)+'</div>';}).join('');
      }
      dd.classList.add('open');
    }
    inp.addEventListener('focus',function(){
      simMeasureActiveSigPath=path;
      renderDropdown();
      // Clicking into a signal field means "pick this signal" — go straight to
      // probe mode so the next click on the schematic fills it.
      if(typeof setMode==='function'&&S.mode!=='probe')setMode('probe');
    });
    inp.addEventListener('input',renderDropdown);
    // A blur right after clicking a dropdown item would hide it before the
    // click lands — the mousedown handler below preventDefaults that click's
    // focus loss, but the short delay here is a safety net either way.
    inp.addEventListener('blur',function(){ setTimeout(function(){dd.classList.remove('open');},150); });
    dd.addEventListener('mousedown',function(e){
      var item=e.target.closest&&e.target.closest('[data-sig-name]');
      if(!item)return;
      e.preventDefault();
      inp.value=item.getAttribute('data-sig-name');
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      dd.classList.remove('open');
    });
  });
}

// Give every currently-plotted signal (by lowercased key) a colour, reusing
// whatever it already has and handing newly-added keys the first slot in
// SIM_PALETTE that isn't currently taken. A key that drops out of `keys`
// frees its colour immediately, so the *next* addition can reuse that slot —
// but signals that stay plotted never have their colour reassigned just
// because some other signal was removed.
function assignSimColors(keys){
  var active={};
  for(var i=0;i<keys.length;i++)active[keys[i]]=true;
  for(var k in simColorAssign)if(!active[k])delete simColorAssign[k];
  for(var j=0;j<keys.length;j++){
    var key=keys[j];
    if(simColorAssign[key])continue;
    var used={};
    for(var kk in simColorAssign)used[simColorAssign[kk]]=true;
    var col=null;
    for(var p=0;p<SIM_PALETTE.length;p++){if(!used[SIM_PALETTE[p]]){col=SIM_PALETTE[p];break;}}
    // More concurrently-plotted signals than palette colours: fall back to a
    // cycling repeat rather than leaving it uncoloured.
    if(!col)col=SIM_PALETTE[Object.keys(simColorAssign).length%SIM_PALETTE.length];
    simColorAssign[key]=col;
  }
}

// Axis styling shared by all axes. The font is set explicitly so uPlot measures
// the tick labels with the same face it draws them in.
var SIM_AXIS_TEXT='#b4c6d6',SIM_AXIS_GRID='#26343f';
var SIM_AXIS_FONT="11px 'Share Tech Mono', monospace";
// Width of a y axis: widest tick label plus tick length and gap. uPlot's own
// auto-size is computed from the values of the *previous* draw, so a label that
// grows when the prefix changes (1000 µA) would be cut off until the next one.
function simYAxisSize(u,values,axisIdx){
  var ax=u.axes[axisIdx];
  var ctx=u.ctx;
  ctx.save();
  ctx.font=SIM_AXIS_FONT;
  var w=0;
  for(var i=0;values&&i<values.length;i++){
    if(values[i]==null)continue;
    w=Math.max(w,ctx.measureText(String(values[i])).width);
  }
  ctx.restore();
  var tick=(ax.ticks&&ax.ticks.size?ax.ticks.size:10);
  return Math.ceil(Math.max(w,30)+tick+14);
}

// Automatic y range: always includes 0, so unipolar signals sit on the bottom
// (or top) edge instead of floating in a window that only spans their data, and
// bipolar signals have the zero line inside the plot. "Fit Y" (simFitY) is the
// explicit way to zoom onto just the data.
function simAutoRange(dMin,dMax){
  if(dMin==null||dMax==null)return uPlot.rangeNum(dMin,dMax,0.1,true);
  return uPlot.rangeNum(Math.min(dMin,0),Math.max(dMax,0),0.1,true);
}

// ═══ FAMILIES OF CURVES (parameter sweep) ═══
var STEP_DASHES=[undefined,[8,4],[2,3],[8,3,2,3],[14,4],[3,3,10,3]];
// Colour of run i of n: the plot palette for a handful of runs, an evenly
// spread hue ramp beyond that.
function stepColor(i,n){
  if(n<=SIM_PALETTE.length)return SIM_PALETTE[i%SIM_PALETTE.length];
  return 'hsl('+Math.round((200+i*360/n)%360)+',80%,62%)';
}

// For the signals of `ser` (built from the first run) collect the same signal
// of every run. Runs of a transient analysis have different time grids (ngspice
// steps adaptively), so all runs are laid on the union of their x values;
// where a run has no sample the value is null and uPlot draws across the gap.
function buildFamilySeries(ser){
  var runs=simRuns.runs;
  var perRun=runs.map(function(r){return buildSeriesFromResult(r.result);});
  var xs=runs.map(function(r){return r.result.data[0].values.map(_re);});
  var same=xs.every(function(a){
    if(a.length!==xs[0].length)return false;
    for(var i=0;i<a.length;i++)if(a[i]!==xs[0][i])return false;
    return true;
  });
  var xAll,index=null;
  if(same)xAll=xs[0];
  else{
    var set={};
    xs.forEach(function(a){a.forEach(function(v){set[v]=true;});});
    xAll=Object.keys(set).map(Number).sort(function(a,b){return a-b;});
    index={};
    for(var u=0;u<xAll.length;u++)index[xAll[u]]=u;
  }
  var items=[];
  for(var s=0;s<ser.names.length;s++){
    for(var r=0;r<runs.length;r++){
      var at=perRun[r].names.indexOf(ser.names[s]);
      var src=at>=0?perRun[r].datas[at]:null;
      var data;
      if(!src)data=new Array(xAll.length).fill(null);
      else if(same)data=src;
      else{
        data=new Array(xAll.length).fill(null);
        for(var i=0;i<src.length;i++)data[index[xs[r][i]]]=src[i];
      }
      items.push({sig:ser.names[s],run:r,label:ser.names[s]+' · '+runs[r].label,data:data});
    }
  }
  return {xVals:xAll,items:items};
}

function plotResult(result){
  var container=document.getElementById('sim-plot');
  if(!container)return;
  renderRawPanel(result);
  if(typeof uPlot==='undefined'){
    container.textContent='Plot library (uPlot) not loaded — check your network connection.';
    return;
  }
  var xVar=result.data[0];
  var isComplex=(result.dataType==='complex');
  var isFreq=(xVar.type==='frequency');
  if(!xVar.values||xVar.values.length<2){
    // .op or single point: show a value table instead of a degenerate plot.
    // A parameter sweep gets one value column per run.
    var tRuns=(simRuns&&simRuns.runs.length>1)?simRuns.runs:null;
    var html='<table class="sim-table"><tr><th>Variable</th>'+
      (tRuns?tRuns.map(function(r){return '<th>'+esc(r.label)+'</th>';}).join(''):'<th>Value</th>')+'</tr>';
    for(var t=0;t<result.data.length;t++){
      var dv=result.data[t];
      html+='<tr><td>'+dv.name+'</td>';
      (tRuns||[{result:result}]).forEach(function(r){
        var rd=r.result.data[t];
        var val=rd&&rd.values&&rd.values.length?rd.values[0]:'';
        html+='<td>'+fmtEng(r.result.dataType==='complex'?_mag(val):_re(val),6)+'</td>';
      });
      html+='</tr>';
    }
    html+='</table>';
    container.innerHTML=html;
    if(simPlot){simPlot.destroy();simPlot=null;}
    return;
  }
  var xVals=xVar.values.map(_re);
  var ser=buildSeriesFromResult(result);
  // Parameter sweep: one curve per signal and run, on a common x grid.
  var fam=(simRuns&&simRuns.runs.length>1&&ser.names.length)?buildFamilySeries(ser):null;
  if(fam){xVals=fam.xVals;}
  if(!ser.names.length){
    // Nothing selected — say so instead of drawing an empty coordinate system.
    container.innerHTML='<div class="sim-plot-empty">No signals selected.<br>'+
      'Probe a net or a pin on the schematic, tick a vector in the list, '+
      'or press “All node voltages”.</div>';
    if(simPlot){simPlot.destroy();simPlot=null;}
    return;
  }
  // The axis ticks and the readouts carry the unit, so the label stays bare.
  var xUnit=isFreq?'Hz':(xVar.type==='time'?'s':'');
  var xLabel=isFreq?'Frequency':(xVar.type==='time'?'Time':(xVar.name||'x'));
  simXUnit=xUnit;
  var series=[{label:xLabel,value:function(u,v){return fmtEng(v,6,xUnit);}}];
  var serKeys=ser.names.map(function(n){return String(n).toLowerCase();});
  assignSimColors(serKeys);
  simSeriesColor={};
  // Current series get their own y axis (y2, right-hand side) so a plot mixing
  // V(...) and I(...) doesn't squash both onto one shared scale.
  var hasCurrent=false;
  if(fam){
    // One signal: every run gets its own colour. Several signals: colour = signal
    // (so the sidebar chips still match), dash pattern = run.
    var nRuns=simRuns.runs.length,oneSig=ser.names.length===1;
    for(var fi=0;fi<fam.items.length;fi++){
      var it=fam.items[fi];
      var fcol=oneSig?stepColor(it.run,nRuns):simColorAssign[String(it.sig).toLowerCase()];
      simSeriesColor[String(it.label).toLowerCase()]=fcol;
      if(!simSeriesColor[String(it.sig).toLowerCase()])simSeriesColor[String(it.sig).toLowerCase()]=fcol;
      var fCur=/^i\(/i.test(it.sig)||/^@/.test(it.sig);
      if(fCur)hasCurrent=true;
      series.push({label:it.label+(isComplex?' |mag|':''),stroke:fcol,width:2,scale:fCur?'y2':'y',spanGaps:true,
        dash:oneSig?undefined:STEP_DASHES[it.run%STEP_DASHES.length],
        value:function(u,v){return fmtEng(v,6);}});
    }
  }else for(var k=0;k<ser.names.length;k++){
    var col=simColorAssign[serKeys[k]];
    simSeriesColor[serKeys[k]]=col;
    var isCur=/^i\(/i.test(ser.names[k])||/^@/.test(ser.names[k]);
    if(isCur)hasCurrent=true;
    series.push({label:ser.names[k]+(isComplex?' |mag|':''),stroke:col,width:2,scale:isCur?'y2':'y',
      value:function(u,v){return fmtEng(v,6);}});
  }
  var opts={
    width:Math.max(120,container.clientWidth||600),
    height:Math.max(60,container.clientHeight||320),
    // Room for the half-width of the outermost tick labels (last x tick,
    // top/bottom y tick) — otherwise they get clipped at the canvas edge.
    padding:[10,18,4,4],
    series:series,
    scales:{
      x:{time:false,distr:isFreq?3:1},
      // uPlot re-auto-ranges y on every commit, so an explicit setScale('y')
      // would not survive. The vertical fit therefore goes through this range
      // hook (simYFit), which auto-ranging itself honours.
      y:{range:function(u,dMin,dMax){
        if(simYFit)return [simYFit[0],simYFit[1]];
        return simAutoRange(dMin,dMax);
      }},
      y2:{range:function(u,dMin,dMax){
        if(simYFit2)return [simYFit2[0],simYFit2[1]];
        return simAutoRange(dMin,dMax);
      }}
    },
    cursor:{drag:{x:true,y:true,uni:8}},
    legend:{live:true},
    plugins:[simTooltipPlugin(),simCursorPlugin()],
    axes:[
      {stroke:SIM_AXIS_TEXT,font:SIM_AXIS_FONT,grid:{stroke:SIM_AXIS_GRID},ticks:{stroke:SIM_AXIS_GRID},
       // A log frequency axis spans decades, so there each tick carries its own
       // prefix (1 Hz / 1 kHz / 1 MHz); a linear time axis gets a common one.
       values:isFreq
         ?function(u,ticks){return ticks.map(function(t){return fmtEng(t,4,xUnit);});}
         :function(u,ticks){return axisValuesSI(u,ticks,'x',xUnit);}},
      {scale:'y',stroke:SIM_AXIS_TEXT,font:SIM_AXIS_FONT,grid:{stroke:SIM_AXIS_GRID},ticks:{stroke:SIM_AXIS_GRID},
       size:simYAxisSize,
       values:function(u,ticks){return axisValuesSI(u,ticks,'y',hasCurrent?'V':'');}}
    ]
  };
  if(hasCurrent){
    opts.axes.push({scale:'y2',side:1,stroke:SIM_AXIS_TEXT,font:SIM_AXIS_FONT,grid:{show:false},ticks:{stroke:SIM_AXIS_GRID},
      size:simYAxisSize,
      values:function(u,ticks){return axisValuesSI(u,ticks,'y2','A');}});
  }
  var data=[xVals].concat(fam?fam.items.map(function(it){return it.data;}):ser.datas);
  container.innerHTML='';
  if(simPlot){simPlot.destroy();simPlot=null;}
  simYFit=null;simYFit2=null;
  simPlot=new uPlot(opts,data,container);
  resizeSimPlot();   // the legend sits below the canvas — shrink the canvas to fit
  // The legend's height isn't settled yet right after creation (measured too
  // tall, which collapsed the canvas to its 60px minimum) — measure again once
  // the browser has laid it out.
  requestAnimationFrame(function(){if(simPlot)resizeSimPlot();});
  // Double-click is uPlot's "reset zoom" — drop the manual vertical fit and the
  // measurement cursors too.
  container.addEventListener('dblclick',function(){
    simYFit=null;simYFit2=null;
    clearSimCursors();
  });
  applySignalColors();
}

// Paint every signal label in the sidebar with its curve colour. Done by
// walking the DOM instead of re-rendering, so it cannot steal the focus from an
// input the user is currently editing.
function applySignalColors(){
  document.querySelectorAll('[data-siglabel]').forEach(function(el){
    var c=simSeriesColor[String(el.getAttribute('data-siglabel')).toLowerCase()];
    var isChip=el.classList.contains('sim-chip');
    el.style.color=c||'';
    if(isChip)el.style.borderColor=c?c:'';
    var btn=el.querySelector('button');
    if(btn)btn.style.color=c||'';
    var swatch=el.querySelector('.sim-swatch');
    if(swatch)swatch.style.background=c||'transparent';
  });
}

// ═══ VALUE FORMATTING (SI/engineering prefixes) ═══
var SI_PREFIX=[[1e12,'T'],[1e9,'G'],[1e6,'M'],[1e3,'k'],[1,''],[1e-3,'m'],[1e-6,'µ'],[1e-9,'n'],[1e-12,'p'],[1e-15,'f']];

// Index into SI_PREFIX for a magnitude, e.g. 4.7e-5 -> the 'µ' entry.
function siIndexFor(mag){
  if(!isFinite(mag)||mag===0)return 4;   // the '1 / no prefix' entry
  for(var i=0;i<SI_PREFIX.length;i++){
    if(mag>=SI_PREFIX[i][0]*0.999999)return i;
  }
  return SI_PREFIX.length-1;
}
// SI prefix for a single magnitude, e.g. 4.7e-5 -> {mult:1e-6, prefix:'µ'}.
function siFor(mag){
  var e=SI_PREFIX[siIndexFor(mag)];
  return {mult:e[0],prefix:e[1]};
}
function trimNum(v,digits){
  var s=v.toPrecision(digits||6);
  if(s.indexOf('e')>=0)return String(+s);
  if(s.indexOf('.')>=0)s=s.replace(/0+$/,'').replace(/\.$/,'');
  return s==='-0'?'0':s;
}
// SPICE-legal engineering suffixes only — no unicode 'µ' (ngspice wants ASCII
// 'u') and no bare 'M' (ngspice reads that as milli, not mega; mega is "Meg").
// Used for numbers that get typed straight into a .measure line (FROM/TO/AT/
// TD/VAL), as opposed to fmtEng()'s display-only suffixes.
var SPICE_SI_PREFIX=[[1e12,'T'],[1e9,'G'],[1e6,'Meg'],[1e3,'k'],[1,''],[1e-3,'m'],[1e-6,'u'],[1e-9,'n'],[1e-12,'p'],[1e-15,'f']];
function fmtSpiceEng(v,digits){
  if(v==null||typeof v!=='number'||!isFinite(v))return '';
  if(v===0)return '0';
  var mag=Math.abs(v),e=SPICE_SI_PREFIX[SPICE_SI_PREFIX.length-1];
  for(var i=0;i<SPICE_SI_PREFIX.length;i++){
    if(mag>=SPICE_SI_PREFIX[i][0]*0.999999){e=SPICE_SI_PREFIX[i];break;}
  }
  return trimNum(v/e[0],digits||6)+e[1];
}

// Single value with its own prefix, e.g. fmtEng(2e-3,5,'s') -> "2 ms".
function fmtEng(v,digits,unit){
  unit=unit||'';
  if(v==null||typeof v!=='number'||!isFinite(v))return '—';
  if(v===0)return unit?'0 '+unit:'0';
  var si=siFor(Math.abs(v));
  var s=trimNum(v/si.mult,digits||4);
  var suf=si.prefix+unit;
  return suf?s+' '+suf:s;
}

// Axis ticks: one common prefix for the whole visible range, so a 0…800 µs
// window reads 0 / 200 / 400 / 600 / 800 µs instead of 0.0002 / 0.0004 / …
// The prefix follows the visible *span*, not the absolute values, so zooming
// into a 20 µs slice of a 5 ms run switches the axis to µs. It only steps back
// up when the window sits so far from zero that the labels would run past four
// integer digits (three, so 1200 µA becomes 1.2 mA). Everything is derived from the scale (not from the ticks), so
// it stays in sync no matter in which order uPlot draws things.
function axisValuesSI(u,ticks,scaleKey,unit){
  var sc=u.scales[scaleKey]||{};
  var lo=(sc.min!=null)?sc.min:(ticks.length?ticks[0]:0);
  var hi=(sc.max!=null)?sc.max:(ticks.length?ticks[ticks.length-1]:0);
  var maxAbs=Math.max(Math.abs(lo),Math.abs(hi));
  var span=Math.abs(hi-lo)||maxAbs;
  var idx=siIndexFor(span);
  while(idx>0&&maxAbs/SI_PREFIX[idx][0]>=1000)idx--;
  var si={mult:SI_PREFIX[idx][0],prefix:SI_PREFIX[idx][1]};
  var suf=si.prefix+(unit||'');
  var scaled=ticks.map(function(t){return t/si.mult;});
  // Use as many decimals as it takes to keep neighbouring ticks distinct — and
  // the same count on every tick, so the axis reads as one column of numbers.
  var dec=0;
  for(;dec<12;dec++){
    var ok=true;
    for(var i=1;i<scaled.length;i++){
      if(scaled[i].toFixed(dec)===scaled[i-1].toFixed(dec)){ok=false;break;}
    }
    if(ok)break;
  }
  return scaled.map(function(v,i){
    // A bare numeric axis shows plain "0" rather than "0 m".
    if(ticks[i]===0&&!unit)return (0).toFixed(dec);
    var s=v.toFixed(dec);
    if(s==='-'+(0).toFixed(dec))s=(0).toFixed(dec);
    return suf?s+' '+suf:s;
  });
}

// ═══ PLOT TOOLTIP ═══
// uPlot plugin: a floating box next to the cursor listing the x value and the
// value of every series at the hovered sample.
function simTooltipPlugin(){
  var tip=null,over=null;
  function show(u){
    var idx=u.cursor.idx;
    if(idx==null||u.cursor.left<0){tip.style.display='none';return;}
    var html='<div class="sim-tip-x">'+esc(String(u.series[0].label))+': '+fmtEng(u.data[0][idx],5,simXUnit)+'</div>';
    for(var i=1;i<u.series.length;i++){
      var s=u.series[i];
      if(s.show===false)continue;
      var val=u.data[i][idx];
      // u.series[i].stroke is uPlot's own internal accessor by this point (not
      // the plain hex string we passed in), so look the colour up in the map
      // plotResult filled instead of reading it back off the series.
      var col=simSeriesColor[String(s.label).toLowerCase()]||'#888';
      html+='<div class="sim-tip-row"><span class="sim-tip-dot" style="background:'+col+'"></span>'+
        '<span class="sim-tip-lbl">'+esc(String(s.label))+'</span>'+
        '<span class="sim-tip-val">'+fmtEng(val,5)+'</span></div>';
    }
    tip.innerHTML=html;
    tip.style.display='block';
    // keep the box inside the plot area
    var w=tip.offsetWidth,h=tip.offsetHeight;
    var left=u.cursor.left+14,top=u.cursor.top+14;
    if(left+w>u.over.clientWidth)left=u.cursor.left-w-14;
    if(top+h>u.over.clientHeight)top=Math.max(0,u.cursor.top-h-14);
    tip.style.left=left+'px';tip.style.top=top+'px';
  }
  return {
    hooks:{
      init:function(u){
        over=u.over;
        tip=document.createElement('div');
        tip.className='sim-tooltip';
        tip.style.display='none';
        over.appendChild(tip);
        over.addEventListener('mouseleave',function(){if(tip)tip.style.display='none';});
      },
      setCursor:function(u){if(tip)show(u);},
      // A drag-zoom is an explicit user range — drop the manual vertical fit.
      setSelect:function(u){if(u.select&&u.select.height>0){simYFit=null;simYFit2=null;}},
      destroy:function(){if(tip&&tip.parentNode)tip.parentNode.removeChild(tip);tip=null;}
    }
  };
}

// ═══ MEASUREMENT CURSORS ═══
// Two click-placed cursors ("1" and "2"), marked as vertical lines in the plot.
// Once both are set, a small overlay bottom-right of the plot area reads out
// Δx (time/frequency) and each visible series' value difference between them.
// A third click rotates the pair: the old #2 becomes #1, the new click is #2.
// simCursors holds up to two {idx} entries (data-array indices), oldest first.
// It survives re-plotting the same run (ticking a signal, changing formulas)
// since the x grid doesn't change, but is dropped whenever a fresh run's data
// replaces it (see runSimulation) or the user double-clicks to reset the view.
var simCursors=[];

function clearSimCursors(){
  if(!simCursors.length)return;
  simCursors=[];
  if(simPlot)renderSimCursorsUI(simPlot);
}

function addSimCursorClick(u,idx){
  if(idx==null||!u.data[0]||u.data[0][idx]==null)return;
  if(simCursors.length>=2)simCursors.shift();
  simCursors.push({idx:idx});
  renderSimCursorsUI(u);
  syncMeasureDraftCursorTimes();
}

// Nearest data index for a client-X coordinate, found directly from the x
// scale instead of u.cursor.idx — that field is only refreshed on uPlot's own
// (rAF-throttled) cursor pass, so reading it synchronously from a mouseup
// handler can still see the position from before the last mousemove.
function idxAtClientX(u,clientX){
  var xs=u.data&&u.data[0];
  if(!xs||!xs.length)return null;
  var rect=u.over.getBoundingClientRect();
  var val=u.posToVal(clientX-rect.left,'x');
  if(val==null||!isFinite(val))return null;
  if(val<=xs[0])return 0;
  var last=xs.length-1;
  if(val>=xs[last])return last;
  var lo=0,hi=last;
  while(hi-lo>1){
    var mid=(lo+hi)>>1;
    if(xs[mid]<val)lo=mid;else hi=mid;
  }
  return (val-xs[lo]<=xs[hi]-val)?lo:hi;
}

// x + every visible series' value at a given data-array index — the same
// lookup renderSimCursorsUI needs for its Δ table, factored out so the
// measurement overlay's "grab from cursor" buttons can reuse it.
function cursorValuesAt(idx){
  if(idx==null||!simPlot||!simPlot.data[0]||simPlot.data[0][idx]==null)return null;
  var x=simPlot.data[0][idx],vals=[];
  for(var s=1;s<simPlot.series.length;s++){
    var ser=simPlot.series[s];
    if(ser.show===false)continue;
    var d=simPlot.data[s];
    vals.push({label:ser.label,value:d?d[idx]:null});
  }
  return {x:x,series:vals};
}

function renderSimCursorsUI(u){
  if(!u||!u.over)return;
  var markersEl=u.over.querySelector('.sim-cursor-markers');
  var overlayEl=u.over.querySelector('.sim-cursor-overlay');
  if(!markersEl||!overlayEl)return;
  markersEl.innerHTML='';
  for(var i=0;i<simCursors.length;i++){
    var idx=simCursors[i].idx;
    if(idx==null||!u.data[0]||u.data[0][idx]==null)continue;
    var left=u.valToPos(u.data[0][idx],'x');
    var m=document.createElement('div');
    m.className='sim-cursor-line';
    m.style.left=left+'px';
    var tag=document.createElement('span');
    tag.className='sim-cursor-tag';tag.textContent=String(i+1);
    m.appendChild(tag);
    markersEl.appendChild(m);
  }
  if(simCursors.length<2){overlayEl.style.display='none';overlayEl.innerHTML='';return;}
  var c1=cursorValuesAt(simCursors[0].idx),c2=cursorValuesAt(simCursors[1].idx);
  if(!c1||!c2){overlayEl.style.display='none';return;}
  var dtLabel=(simXUnit==='Hz')?'Δf':'Δt';
  var html='<div class="sim-cursor-hdr">1 → 2</div>'+
    '<div class="sim-cursor-row sim-cursor-dt">'+esc(dtLabel)+': '+fmtEng(c2.x-c1.x,5,simXUnit)+'</div>';
  for(var s=0;s<c1.series.length;s++){
    var v1=c1.series[s].value,v2=c2.series[s]?c2.series[s].value:null;
    if(v1==null||v2==null||!isFinite(v1)||!isFinite(v2))continue;
    // ser.stroke is uPlot's internal accessor, not the hex string — see the
    // same note in simTooltipPlugin.
    var lbl=c1.series[s].label;
    var col=simSeriesColor[String(lbl).toLowerCase()]||'#888';
    html+='<div class="sim-cursor-row"><span class="sim-cursor-dot" style="background:'+col+'"></span>'+
      '<span class="sim-cursor-lbl">'+esc(String(lbl))+'</span>'+
      '<span class="sim-cursor-val">Δ'+fmtEng(v2-v1,5)+'</span></div>';
  }
  overlayEl.innerHTML=html;
  overlayEl.style.display='block';
}

function simCursorPlugin(){
  var downX=null,downY=null;
  return {
    hooks:{
      init:function(u){
        var markersEl=document.createElement('div');
        markersEl.className='sim-cursor-markers';
        var overlayEl=document.createElement('div');
        overlayEl.className='sim-cursor-overlay';
        overlayEl.style.display='none';
        u.over.appendChild(markersEl);
        u.over.appendChild(overlayEl);
        // A plain click (no drag) drops/moves a measurement cursor. Distinguish
        // it from a drag-zoom by the mouse travel between down and up, since
        // uPlot's own drag-select swallows the click semantics otherwise.
        u.over.addEventListener('mousedown',function(e){downX=e.clientX;downY=e.clientY;});
        u.over.addEventListener('mouseup',function(e){
          if(downX==null)return;
          var dx=Math.abs(e.clientX-downX),dy=Math.abs(e.clientY-downY);
          downX=null;downY=null;
          if(dx>4||dy>4)return;   // was a drag-zoom, not a cursor click
          var idx=idxAtClientX(u,e.clientX);
          if(idx==null)return;
          addSimCursorClick(u,idx);
        });
      },
      draw:function(u){renderSimCursorsUI(u);}
    }
  };
}

// ═══ FIT BUTTONS ═══
// Horizontal fit resets the x range to the full data range; vertical fit scales
// y to the data that is actually visible in the current x window.
var simYFit=null;   // [min,max] override for the y scale, set by simFitY()
var simYFit2=null;  // same, for the secondary (current) y2 scale

function simFitX(){
  if(!simPlot||!simPlot.data||!simPlot.data[0]||!simPlot.data[0].length)return;
  var xs=simPlot.data[0];
  simPlot.setScale('x',{min:xs[0],max:xs[xs.length-1]});
}
function simFitY(xlo,xhi){
  if(!simPlot||!simPlot.data||simPlot.data.length<2)return;
  var xs=simPlot.data[0];
  var xr=simPlot.scales.x;
  var lo=(xlo!=null)?xlo:((xr&&xr.min!=null)?xr.min:xs[0]);
  var hi=(xhi!=null)?xhi:((xr&&xr.max!=null)?xr.max:xs[xs.length-1]);
  // Each series carries its own scale key ('y' or 'y2' — see plotResult), so
  // the two axes are fit independently from the data actually assigned to them.
  var range={y:{min:Infinity,max:-Infinity},y2:{min:Infinity,max:-Infinity}};
  for(var s=1;s<simPlot.data.length;s++){
    var ser=simPlot.series[s];
    if(ser&&ser.show===false)continue;
    var scaleKey=(ser&&ser.scale)||'y';
    var r=range[scaleKey];if(!r)continue;
    var d=simPlot.data[s];
    for(var i=0;i<d.length;i++){
      if(xs[i]<lo||xs[i]>hi)continue;
      var v=d[i];
      if(v==null||!isFinite(v))continue;
      if(v<r.min)r.min=v;
      if(v>r.max)r.max=v;
    }
  }
  function pad(r){
    if(!isFinite(r.min)||!isFinite(r.max))return null;
    var min=r.min,max=r.max;
    if(min===max){var pad0=Math.abs(min)*0.1||1;min-=pad0;max+=pad0;}
    else{var p=(max-min)*0.05;min-=p;max+=p;}
    return [min,max];
  }
  var yr=pad(range.y),y2r=pad(range.y2);
  // Set both: setScale applies it now, simYFit(2) makes it survive the next
  // auto-range commit (uPlot re-ranges y whenever anything else changes).
  if(yr){simYFit=yr;simPlot.setScale('y',{min:yr[0],max:yr[1]});}
  if(y2r){simYFit2=y2r;simPlot.setScale('y2',{min:y2r[0],max:y2r[1]});}
}
// Both axes to the full data range (the y pass gets the window explicitly, as
// the x scale is only committed on the next frame).
function simFitBoth(){
  if(!simPlot||!simPlot.data||!simPlot.data[0]||!simPlot.data[0].length)return;
  var xs=simPlot.data[0];
  simFitX();
  simFitY(xs[0],xs[xs.length-1]);
}

// Vector picker: every vector of the last run with a checkbox. It edits the
// same selection the canvas probes do, so ticking here and probing there can no
// longer disagree — unticking a probed signal removes its probe as well.
// Starts collapsed: with "save all signals" on this list can be very long, and
// most sessions only care about the probed/ticked signals shown above it.
var simRawPanelCollapsed=true;

function toggleRawPanelCollapse(){
  simRawPanelCollapsed=!simRawPanelCollapsed;
  renderRawPanel(simLastResult);
}

function renderRawPanel(result){
  var panel=document.getElementById('sim-raw-panel');
  if(!panel)return;
  if(!getRawMode()||!result){panel.style.display='none';panel.innerHTML='';return;}
  var map=vectorMapOf(result);
  var owners=probeOwners(map);
  var count=result.data.length-1;
  var html='<div class="sim-label sim-raw-toggle" onclick="toggleRawPanelCollapse()">'+
    (simRawPanelCollapsed?'▸':'▾')+' Result vectors ('+count+') <span class="sim-sub">'+
    (simRawPanelCollapsed?'click to expand':'tick to plot')+'</span></div>';
  if(!simRawPanelCollapsed){
    html+='<div class="sim-raw-grid">';
    for(var j=1;j<result.data.length;j++){
      var name=result.data[j].name,key=name.toLowerCase();
      var own=owners[key];
      var lbl=own?_probeLabel(own):name;
      html+='<label class="sim-raw-item'+(own?' probed':'')+'" title="'+esc(name)+'" data-siglabel="'+esc(lbl)+'">'+
        '<input type="checkbox" data-vec="'+esc(key)+'"'+(simSelection[key]?' checked':'')+'> '+
        esc(lbl)+'</label>';
    }
    html+='</div>';
  }
  panel.style.display='block';
  panel.innerHTML=html;
  applySignalColors();
  panel.querySelectorAll('input[type=checkbox]').forEach(function(cb){
    cb.addEventListener('change',function(){
      var k=cb.getAttribute('data-vec');
      setSelected(k,cb.checked);
      if(!cb.checked)removeProbesForVector(k);
      renderProbeList();
      if(simLastResult)plotResult(simLastResult);
    });
  });
}

// Drop the canvas probe(s) that own a vector, so unticking it in the picker
// also clears the chip and the marker bookkeeping.
function removeProbesForVector(key){
  if(!S.probes)return;
  var map=simLastResult?vectorMapOf(simLastResult):null;
  S.probes=S.probes.filter(function(pr){return probeVectorKey(pr,map)!==key;});
}

// Toggled by the "save & list all signals" checkbox. It controls what the next
// run stores (the generated `.save` line, see needsCurrents) and whether the
// vector list is shown; the current selection and plot are untouched.
function onRawModeChange(){
  saveSimSettings();
  if(simLastResult)plotResult(simLastResult);
}

// ═══ PROBE -> NET SELECTION ═══
// Resolve the netlist node name at a canvas coordinate. Resets the temp-name
// cache first so the name matches what generateNetlist() will emit for the
// current topology.
function resolveProbeNetName(x,y){
  tempNetNamesGen={};tempNetCounterGen=0;
  var near=findPin(x,y,18);
  if(near&&near.type==='pin')return getNetNameWithTempNames(near.x,near.y);
  return getNetNameWithTempNames(x,y);
}

function _probeNet(x,y){
  var name=resolveProbeNetName(x,y);
  if(!name||name==='n000')return null;
  return String(name).toLowerCase();
}
function _afterProbeChange(){
  renderProbeList();
  if(simLastResult)plotResult(simLastResult); // live re-filter the existing plot
}

// Is there a current-probeable device pin at (x,y)? Returns {compId,pinIdx,cv}.
function currentProbeTargetAt(x,y){
  var near=findPin(x,y,18);
  if(!near||near.type!=='pin')return null;
  var comp=S.components.find(function(c){return c.id===near.compId;});
  if(!comp)return null;
  var cv=(typeof currentVectorsForPin==='function')?currentVectorsForPin(comp,near.pinIdx):null;
  if(!cv)return null;
  return {compId:comp.id,pinIdx:near.pinIdx,cv:cv,x:near.x,y:near.y};
}

// ── Probing into a behavioural-source equation ──
// While an equation field is the insertion target (see eqTarget in app.js) a
// probe click types the signal into it instead of adding a plot probe. The text
// is what ngspice's B-source syntax accepts: v(net), v(a,b), i(vsource).
function eqNetHint(net){
  return /^n\d{3}$/.test(net)?' (unnamed net: give it a name to keep the equation stable when you edit the schematic)':'';
}
function probeIntoEquation(x,y){
  if(typeof eqTarget==='undefined'||!eqTarget||!eqTarget.el||!eqTarget.el.isConnected)return false;
  var tgt=currentProbeTargetAt(x,y),txt=null;
  if(tgt){
    var cand=null;
    for(var i=0;i<tgt.cv.cands.length;i++)if(/^i\(v/i.test(tgt.cv.cands[i])){cand=tgt.cv.cands[i].toLowerCase();break;}
    var pc=S.components.find(function(c){return c.id===tgt.compId;});
    var sk=pc?senseKind(pc.type):null;
    if(!cand&&pc&&DEVICE_SENSE_TYPES.indexOf(pc.type)>=0&&pc.label&&(sk!=='two'||tgt.pinIdx<2)){
      // The netlist adds the 0 V sense source itself, see injectDeviceCurrentSenses.
      txt=(sk==='two')?((tgt.pinIdx===1?'-':'')+'i('+pc.label+')'):('i('+pc.label+'.'+CD[pc.type].pins[tgt.pinIdx].n+')');
    }else if(!cand){hint('A behavioural equation can only use currents of voltage sources i(v...), of R, C, L, diodes i(R1) and of transistor pins i(Q1.C). Put a 0 V source in series to measure this current.');return true;}
    else txt=(tgt.cv.sign<0?'-':'')+cand;
  }else{
    var net=_probeNet(x,y);
    if(!net){hint('No net to probe here');return true;}
    if(net==='0'){hint('Ground is 0 in an equation');txt='0';}
    else txt='v('+net+')';
    if(net!=='0')hint('Inserted '+txt+eqNetHint(net));
  }
  insertIntoEquationField(txt);
  return true;
}
// The measurement dialog is another alternative probe sink: while it is open a
// probe click only fills its signal field and leaves the plot probes alone.
function probeIntoMeasurement(x,y){
  if(typeof simMeasureDraft==='undefined'||!simMeasureDraft)return false;
  var tgt=currentProbeTargetAt(x,y);
  if(tgt){feedProbeToMeasureModal({kind:'I',compId:tgt.compId,pinIdx:tgt.pinIdx});return true;}
  var net=_probeNet(x,y);
  if(net==='0'){hint('Ground (node 0) is not a measurable signal');return true;}
  if(!net){hint('No net to probe here');return true;}
  feedProbeToMeasureModal({kind:'V',net:net});
  return true;
}
function probeDiffIntoMeasurement(a,b){
  if(typeof simMeasureDraft==='undefined'||!simMeasureDraft)return false;
  var aOk=a&&a!=='0',bOk=b&&b!=='0';
  if(!aOk&&!bOk){hint('No nets to probe');return true;}
  if(!aOk||!bOk||a===b)feedProbeToMeasureModal({kind:'V',net:aOk?a:b});
  else feedProbeToMeasureModal({kind:'Vd',p:a,n:b});
  return true;
}
function probeDiffIntoEquation(a,b){
  if(typeof eqTarget==='undefined'||!eqTarget||!eqTarget.el||!eqTarget.el.isConnected)return false;
  var aOk=a&&a!=='0',bOk=b&&b!=='0';
  if(!aOk&&!bOk){hint('No nets to probe');return true;}
  var txt=(aOk&&bOk)?(a===b?'0':'v('+a+','+b+')'):(aOk?'v('+a+')':'-v('+b+')');
  insertIntoEquationField(txt);
  hint('Inserted '+txt+eqNetHint(aOk?a:b));
  return true;
}

// Single click: on a device pin this toggles a CURRENT probe I(dev.pin);
// anywhere else on a net it toggles the node voltage probe V(net).
function toggleProbeAt(x,y){
  // The power analyzer is assigning a channel: the click is its, not the plot's.
  if(typeof paHandleProbeClick==='function'&&paHandleProbeClick(x,y))return;
  if(probeIntoEquation(x,y))return;
  if(probeIntoMeasurement(x,y))return;
  if(!S.probes)S.probes=[];
  var tgt=currentProbeTargetAt(x,y);
  if(tgt){
    var lbl=currentProbeLabel({compId:tgt.compId,pinIdx:tgt.pinIdx});
    var ci=-1;
    for(var n=0;n<S.probes.length;n++){
      var q=S.probes[n];
      if(q.kind==='I'&&q.compId===tgt.compId&&q.pinIdx===tgt.pinIdx){ci=n;break;}
    }
    var pr={kind:'I',compId:tgt.compId,pinIdx:tgt.pinIdx};
    if(ci>=0){
      S.probes.splice(ci,1);
      selectProbeVector(pr,false);
      hint('Probe removed: '+lbl);
    }else{
      dropAutoSelection();
      S.probes.push(pr);
      selectProbeVector(pr,true);
      hint('Current probe added: '+lbl);
      feedProbeToMeasureModal(pr);
    }
    _afterProbeChange();
    return;
  }
  var net=_probeNet(x,y);
  if(net==='0'){hint('Ground (node 0) is not plottable');return;}
  if(!net){hint('No net to probe here');return;}
  if(!S.probes)S.probes=[];
  var idx=-1;
  for(var i=0;i<S.probes.length;i++){if(S.probes[i].kind==='V'&&S.probes[i].net===net){idx=i;break;}}
  if(idx>=0){S.probes.splice(idx,1);setSelected('v('+net+')',false);hint('Probe removed: V('+net+')');}
  else{
    dropAutoSelection();
    S.probes.push({kind:'V',net:net});
    setSelected('v('+net+')',true);
    hint('Probe added: V('+net+')');
    feedProbeToMeasureModal({kind:'V',net:net});
  }
  _afterProbeChange();
}

// Tick/untick the result vector a probe stands for.
function selectProbeVector(pr,on){
  var key=probeVectorKey(pr,simLastResult?vectorMapOf(simLastResult):null);
  if(key)setSelected(key,on);
}

// Drag from net A to net B: add a differential probe V(B)-V(A).
// If either endpoint is ground/invalid or both are the same net, it degrades
// to a single-ended probe of the meaningful node.
function addDiffProbe(x1,y1,x2,y2){
  if(typeof paHandleProbeDrag==='function'&&paHandleProbeDrag(x1,y1,x2,y2))return;
  var a=_probeNet(x1,y1); // measured (minuend) - drag START
  var b=_probeNet(x2,y2); // reference (subtrahend) - drag END
  if(probeDiffIntoEquation(a,b))return;
  if(probeDiffIntoMeasurement(a,b))return;
  var aOk=a&&a!=='0', bOk=b&&b!=='0';
  if(!S.probes)S.probes=[];
  if(!aOk&&!bOk){hint('No nets to probe');return;}
  if(!aOk||!bOk||a===b){
    var net=aOk?a:b;
    dropAutoSelection();
    if(!S.probes.some(function(p){return p.kind==='V'&&p.net===net;})){S.probes.push({kind:'V',net:net});}
    setSelected('v('+net+')',true);
    hint('Probe added: V('+net+')');
    feedProbeToMeasureModal({kind:'V',net:net});
    _afterProbeChange();return;
  }
  if(S.probes.some(function(p){return p.kind==='Vd'&&p.p===a&&p.n===b;})){
    hint('Differential probe already present');return;
  }
  dropAutoSelection();
  S.probes.push({kind:'Vd',p:a,n:b});
  hint('Probe added: V('+a+')-V('+b+')');
  feedProbeToMeasureModal({kind:'Vd',p:a,n:b});
  _afterProbeChange();
}

// Clear really clears: no probes, no ticked vectors, nothing plotted (bar the
// formulas, which have their own remove buttons). It deliberately does NOT fall
// back to the automatic "all node voltages" set — that would look like the
// button did nothing. Use selectAllNodeVoltages() to get that set back.
function clearProbes(){
  S.probes=[];
  simSelection={};
  simSelectionAuto=false;
  _afterProbeChange();
}

// Every node voltage of the last (and each following) run, kept in sync as
// the netlist changes — an explicit opt-in, no longer the out-of-the-box default.
function selectAllNodeVoltages(){
  S.probes=[];
  simSelection={};
  simSelectionAuto=true;
  if(simLastResult)reconcileSelection(simLastResult);
  _afterProbeChange();
}

// Everything the last run produced — device currents included.
function selectAllSignals(){
  if(!simLastResult){hint('Run a simulation first');return;}
  simSelectionAuto=false;
  simSelection={};
  for(var i=1;i<simLastResult.data.length;i++){
    simSelection[String(simLastResult.data[i].name).toLowerCase()]=true;
  }
  _afterProbeChange();
}

function _probeLabel(pr){
  if(pr.kind==='I')return currentProbeLabel(pr);
  // Must match the series name buildSeriesFromResult() actually plots
  // (plain ASCII hyphen) — this label doubles as the sim-chip's
  // data-siglabel, which applySignalColors() looks up in simSeriesColor by
  // exact (lowercased) string. A fancier typographic minus here used to make
  // that lookup miss, so a differential probe's chip never got its swatch/dot
  // coloured even though the curve itself did.
  return pr.kind==='Vd'?('V('+pr.p+')-V('+pr.n+')'):('V('+pr.net+')');
}

// One chip per plotted signal: the canvas probes plus any extra vector ticked
// in the picker, so this list always mirrors what the plot shows.
function renderProbeList(){
  var el=document.getElementById('sim-probe-list');
  if(!el)return;
  // Drop current probes whose component has been deleted meanwhile.
  if(S.probes)S.probes=S.probes.filter(function(p){
    if(p.kind!=='I')return true;
    if(S.components.some(function(c){return c.id===p.compId;}))return true;
    var key=probeVectorKey(p,null);
    if(key)delete simSelection[key];
    return false;
  });
  var map=simLastResult?vectorMapOf(simLastResult):null;
  var probes=S.probes||[];
  var html='',shown={};
  for(var i=0;i<probes.length;i++){
    var cls=probes[i].kind==='I'?'sim-chip sim-chip-i':'sim-chip';
    var key=probeVectorKey(probes[i],map);
    if(key)shown[key]=true;
    var lbl=_probeLabel(probes[i]);
    html+='<span class="'+cls+'" data-siglabel="'+esc(lbl)+'">'+esc(lbl)+
      '<button title="remove" onclick="removeProbe('+i+')">×</button></span>';
  }
  // selected vectors that no probe owns (ticked in the list, or the automatic
  // default set) — listed too, so the chips are a complete, colour-coded legend
  for(var k in simSelection){
    if(shown[k])continue;
    html+='<span class="sim-chip sim-chip-raw" data-siglabel="'+esc(k)+'">'+esc(k)+
      '<button title="remove" onclick="removeSelectedVector(\''+esc(k).replace(/'/g,"\\'")+'\')">×</button></span>';
  }
  if(!html){
    el.innerHTML='<span class="sim-probe-empty">'+
      (simSelectionAuto
        ?'auto — all node voltages of the next run. In probe mode click a pin for its terminal current, a wire for the node voltage, or drag between two nets for a differential.'
        :'none selected — probe a signal or tick one in the vector list below.')+'</span>';
    return;
  }
  if(simSelectionAuto)html+='<span class="sim-probe-empty" style="flex-basis:100%">auto: all node voltages — probing or ticking a signal takes over</span>';
  el.innerHTML=html;
  applySignalColors();
}

function removeProbe(idx){
  if(!S.probes)return;
  var pr=S.probes[idx];
  if(!pr)return;
  S.probes.splice(idx,1);
  if(pr.kind!=='Vd')selectProbeVector(pr,false);
  _afterProbeChange();
}

function removeSelectedVector(key){
  setSelected(key,false);
  removeProbesForVector(key);
  _afterProbeChange();
}

// ═══ SPLIT-SCREEN VIEW ═══
// Two independent pieces of UI:
//   * the plot pane at the bottom of the canvas   (simViewActive)
//   * the settings page inside the properties bar (simPanelOpen)
// SIMULATE opens both, but the settings page can be closed on its own — and it
// yields automatically as soon as a component is selected — so component
// properties stay reachable while a simulation plot is open.
// SIMULATE: if the plot pane is open but the settings page has been pushed
// aside (by selecting a component, or by its close button), the first click
// brings the settings back instead of tearing the whole view down.
function toggleSimView(){
  if(simViewActive&&!simPanelOpen){setSimPanel(true);return;}
  setSimView(!simViewActive);
}

// The toolbar SIMULATION button: opens the view (same as toggleSimView) and,
// only on that opening transition, kicks off a run right away — so a click
// gets you straight to a result instead of open-then-hunt-for-Run. Re-clicking
// to close (or to bring the settings page back) does not re-run.
function simulateButtonClick(){
  var wasActive=simViewActive;
  toggleSimView();
  if(!wasActive)runSimulation();
}

function setSimView(on){
  simViewActive=!!on;
  var pane=document.getElementById('sim-pane');
  var divider=document.getElementById('sim-divider');
  var btn=document.getElementById('btn-sim');
  if(pane)pane.style.display=simViewActive?'flex':'none';
  if(divider)divider.style.display=simViewActive?'block':'none';
  if(btn)btn.classList.toggle('active',simViewActive);
  setSimPanel(simViewActive);
  if(typeof applyView==='function')applyView();  // SVG viewBox tracks the new pane size
  if(simViewActive&&simLastResult)plotResult(simLastResult);
}

// Show/hide the simulation settings inside the properties sidebar.
function setSimPanel(on){
  simPanelOpen=!!on;
  var settings=document.getElementById('sim-settings');
  if(!settings)return;
  if(simPanelOpen){
    var pc=document.getElementById('props-content');if(pc)pc.style.display='none';
    var cc=document.getElementById('custom-comp-section');if(cc)cc.style.display='none';
    settings.style.display='block';
    renderAnalysisPanel();
    renderFormulaList();
    renderProbeList();
    renderMeasureList();
  }else{
    settings.style.display='none';
    if(typeof renderProps==='function')renderProps(); // restore the normal properties view
  }
}

function closeSimPanel(){ setSimPanel(false); }
// Re-open the settings page from the plot pane header without touching the plot.
function showSimPanel(){ setSimPanel(true); }

// Drag the horizontal divider to resize the plot pane.
(function initSimDivider(){
  function attach(){
    var divider=document.getElementById('sim-divider');
    var wrap=document.getElementById('canvas-wrap');
    var pane=document.getElementById('sim-pane');
    if(!divider||!wrap||!pane)return;
    var dragging=false;
    divider.addEventListener('mousedown',function(e){
      dragging=true;divider.classList.add('dragging');
      document.body.style.cursor='row-resize';e.preventDefault();
    });
    document.addEventListener('mousemove',function(e){
      if(!dragging)return;
      var r=wrap.getBoundingClientRect();
      var h=r.bottom-e.clientY-3;            // pane height from cursor to bottom
      h=Math.max(120,Math.min(r.height-120,h));
      pane.style.height=h+'px';
      if(typeof applyView==='function')applyView();
      if(simPlot)resizeSimPlot();
      var mm=document.getElementById('measure-modal');
      if(mm&&mm.style.display!=='none')positionMeasureModalClearOfPlot(mm);
    });
    document.addEventListener('mouseup',function(){
      if(!dragging)return;
      dragging=false;divider.classList.remove('dragging');document.body.style.cursor='';
      if(simLastResult)plotResult(simLastResult);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach);else attach();
})();

// Analysis type / directives: folded away by default, since day-to-day work is
// mostly about probing signals, not re-configuring the analysis card. Session-
// only (not persisted) — it's a display preference, not part of the sim setup.
var simConfigCollapsed=true;
function toggleSimConfigCollapse(){
  simConfigCollapsed=!simConfigCollapsed;
  applySimConfigCollapse();
}
function applySimConfigCollapse(){
  var body=document.getElementById('sim-config-body');
  var caret=document.getElementById('sim-config-caret');
  if(body)body.style.display=simConfigCollapsed?'none':'block';
  if(caret)caret.textContent=simConfigCollapsed?'▸':'▾';
}

// ═══ INIT ═══
(function initSimSettings(){
  function attach(){
    loadSimSettings();
    var dir=document.getElementById('sim-directives');
    if(dir)dir.addEventListener('input',saveSimSettings);
    renderAnalysisPanel();
    renderFormulaList();
    renderProbeList();
    renderMeasureList();
    applySimConfigCollapse();
    setRunButtonState('ready');
    // Preload the WASM engine (worker if it works here, main thread otherwise)
    // right away instead of waiting for the first Run, so that click doesn't
    // also have to pay for the (network) fetch + start.
    preloadSimEngine();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach);else attach();
})();

function resizeSimPlot(){
  var c=document.getElementById('sim-plot');
  if(!simPlot||!c)return;
  // The legend is part of uPlot's DOM but not of its canvas height, so take it
  // off the container height or the x axis is pushed out of view. Its height
  // depends on the width (it wraps), so set the width first and measure after.
  var w=Math.max(120,c.clientWidth);
  if(simPlot.width!==w)simPlot.setSize({width:w,height:simPlot.height});
  var lg=c.querySelector('.u-legend');
  var h=Math.max(60,c.clientHeight-(lg?lg.offsetHeight:0)-2);
  if(simPlot.height!==h)simPlot.setSize({width:w,height:h});
}
window.addEventListener('resize',function(){
  if(simViewActive&&simPlot)resizeSimPlot();
  var mm=document.getElementById('measure-modal');
  if(mm&&mm.style.display!=='none')positionMeasureModalClearOfPlot(mm);
});

// Catch-all: the plot container also changes size when a sidebar is dragged or
// a panel is toggled, which no resize event reports.
(function observePlotSize(){
  if(typeof ResizeObserver==='undefined')return;
  function attach(){
    var c=document.getElementById('sim-plot');
    if(!c)return;
    new ResizeObserver(function(){ if(simPlot)resizeSimPlot(); }).observe(c);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach);else attach();
})();
