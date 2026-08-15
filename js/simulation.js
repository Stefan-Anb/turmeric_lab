// ═══════════════════════════════════════════════════
// NGSPICE SIMULATION (WASM) + INTERACTIVE PLOT
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
// Requires a network connection on first run to fetch the WASM engine. The
// engine and uPlot can later be vendored locally for offline use.
// ═══════════════════════════════════════════════════

var EE_ENGINE_URL='https://esm.sh/eecircuit-engine@1.7.0';
var simInstance=null;     // started Simulation instance (cached)
var simStarting=null;     // in-flight start() promise (de-dupes concurrent starts)
var simPlot=null;         // current uPlot instance
var simLastResult=null;   // last result, for re-plot when probe selection changes
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

// Analysis configuration (GUI-built .tran / .dc directive) and user formulas.
// Both are persisted separately from the schematic so they survive a reload.
var simAnalysis={
  type:'tran',
  tran:{tstep:'10u',tstop:'5m',tstart:'',tmax:'',uic:false,trtol:'7'},
  dc:{src:'',start:'0',stop:'5',step:'0.1',use2:false,src2:'',start2:'0',stop2:'5',step2:'1'},
  ac:{sweep:'dec',pts:'20',fstart:'1',fstop:'1Meg'}
};
var simFormulas=[];        // [{name,expr,on}]

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
      analysis:simAnalysis,formulas:simFormulas,directives:d?d.value:'',saveAll:getRawMode()
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
function simStatus(msg){var elx=document.getElementById('sim-status');if(elx)elx.textContent=msg;}

// Lazily load + start the ngspice WASM engine. Returns the Simulation instance.
function ensureSim(){
  if(simInstance)return Promise.resolve(simInstance);
  if(simStarting)return simStarting;
  simStatus('Loading NGSpice (WASM)…');
  simStarting=import(EE_ENGINE_URL).then(function(mod){
    var Sim=mod.Simulation||(mod.default&&mod.default.Simulation);
    if(!Sim)throw new Error('eecircuit-engine: Simulation export not found');
    var sim=new Sim();
    return Promise.resolve(sim.start()).then(function(){
      simInstance=sim;
      simStatus('NGSpice ready.');
      return sim;
    });
  }).catch(function(err){
    simStarting=null;
    throw err;
  });
  return simStarting;
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
      fld('tran.tstep','Step time',a.tran.tstep,'10u')+
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
}

// Assemble the full deck: generated devices + analysis card + user directives + .end.
function buildFullNetlist(){
  var core=generateNetlist();
  var dirEl=document.getElementById('sim-directives');
  var directives=dirEl?(dirEl.value||'').trim():'';
  var lines=[core];
  // Terminal currents (@dev[i], @q1[ic], …) only reach the raw output when they
  // are saved explicitly; ask for them as soon as a current probe, a formula
  // referencing one, or the "save all signals" option is in play.
  if(needsCurrents())lines.push(buildSaveLine());
  var analysis=buildAnalysisDirective();
  if(analysis)lines.push(analysis);
  var options=buildOptionsDirective();
  if(options)lines.push(options);
  if(directives)lines.push(directives);
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
  // a current vector that is selected from a previous run has to stay available
  for(var k in simSelection)if(isCurrentVectorName(k))return true;
  return getRawMode();   // picker open: keep everything pickable
}

var simRunToken=0;      // identifies the newest run, so a stale watchdog stays quiet

function runSimulation(){
  var btn=document.getElementById('sim-run-btn');
  if(btn)btn.disabled=true;
  var logEl=document.getElementById('sim-log');if(logEl)logEl.textContent='';
  // A fatal ngspice error (e.g. an unknown function in a B-source) aborts the
  // WASM instance without ever settling runSim()'s promise, which would leave
  // the UI stuck on "Simulating…" forever. The watchdog reports that and drops
  // the dead engine so the next run starts a fresh one.
  var token=++simRunToken;
  var watchdog=setTimeout(function(){
    if(token!==simRunToken)return;
    simStatus('No response from NGSpice after 90 s — the engine probably aborted (see the log / browser console). A fresh engine will be loaded on the next run.');
    simLog('watchdog: no result after 90 s, dropping the engine instance',true);
    simInstance=null;simStarting=null;
    if(btn)btn.disabled=false;
  },90000);
  var runStart=null;   // set right before runSim(), so engine load time isn't counted
  ensureSim().then(function(sim){
    var netlist=buildFullNetlist();
    simLog('--- Netlist sent to NGSpice ---');
    simLog(netlist);
    simLog('-------------------------------');
    sim.setNetList(netlist);
    simStatus('Simulating…');
    runStart=performance.now();
    return sim.runSim();
  }).then(function(result){
    var elapsed=(runStart!=null)?(performance.now()-runStart):null;
    var sim=simInstance;
    try{
      var errs=sim.getError&&sim.getError();
      if(errs&&errs.length)errs.forEach(function(e){simLog(e,true);});
      var info=sim.getInfo&&sim.getInfo();if(info)simLog(info);
    }catch(e){}
    if(!result||!result.data||!result.data.length){
      simStatus('No data returned. Check the directives and the log below.');
      return;
    }
    simLastResult=result;
    simCursors=[];   // a fresh run gets a fresh x grid — old cursor positions no longer apply
    // Carry the signal selection over to the new run: keep what still exists,
    // drop what the netlist no longer produces.
    reconcileSelection(result);
    simStatus('Done: '+result.numPoints+' point(s), '+result.numVariables+' variable(s), '+result.dataType+'.'+
      (elapsed!=null?' ('+fmtEng(elapsed/1000,3,'s')+')':''));
    plotResult(result);
  }).catch(function(err){
    simStatus('Simulation failed: '+(err&&err.message||err));
    simLog(String(err&&err.stack||err),true);
  }).then(function(){
    clearTimeout(watchdog);
    if(btn)btn.disabled=false;
  });
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
  }
  return al;
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
    var html='<table class="sim-table"><tr><th>Variable</th><th>Value</th></tr>';
    for(var t=0;t<result.data.length;t++){
      var dv=result.data[t];
      var val=dv.values&&dv.values.length?dv.values[0]:'';
      html+='<tr><td>'+dv.name+'</td><td>'+fmtEng(isComplex?_mag(val):_re(val),6)+'</td></tr>';
    }
    html+='</table>';
    container.innerHTML=html;
    if(simPlot){simPlot.destroy();simPlot=null;}
    return;
  }
  var xVals=xVar.values.map(_re);
  var ser=buildSeriesFromResult(result);
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
  simSeriesColor={};
  // Current series get their own y axis (y2, right-hand side) so a plot mixing
  // V(...) and I(...) doesn't squash both onto one shared scale.
  var hasCurrent=false;
  for(var k=0;k<ser.names.length;k++){
    var col=SIM_PALETTE[k%SIM_PALETTE.length];
    simSeriesColor[String(ser.names[k]).toLowerCase()]=col;
    var isCur=/^i\(/i.test(ser.names[k])||/^@/.test(ser.names[k]);
    if(isCur)hasCurrent=true;
    series.push({label:ser.names[k]+(isComplex?' |mag|':''),stroke:col,width:2,scale:isCur?'y2':'y',
      value:function(u,v){return fmtEng(v,6);}});
  }
  var opts={
    width:Math.max(120,container.clientWidth||600),
    height:Math.max(60,container.clientHeight||320),
    series:series,
    scales:{
      x:{time:false,distr:isFreq?3:1},
      // uPlot re-auto-ranges y on every commit, so an explicit setScale('y')
      // would not survive. The vertical fit therefore goes through this range
      // hook (simYFit), which auto-ranging itself honours.
      y:{range:function(u,dMin,dMax){
        if(simYFit)return [simYFit[0],simYFit[1]];
        return uPlot.rangeNum(dMin,dMax,0.1,true);
      }},
      y2:{range:function(u,dMin,dMax){
        if(simYFit2)return [simYFit2[0],simYFit2[1]];
        return uPlot.rangeNum(dMin,dMax,0.1,true);
      }}
    },
    cursor:{drag:{x:true,y:true,uni:8}},
    legend:{live:true},
    plugins:[simTooltipPlugin(),simCursorPlugin()],
    axes:[
      {stroke:'#7a92a8',grid:{stroke:'#1c2730'},ticks:{stroke:'#1c2730'},
       // A log frequency axis spans decades, so there each tick carries its own
       // prefix (1 Hz / 1 kHz / 1 MHz); a linear time axis gets a common one.
       values:isFreq
         ?function(u,ticks){return ticks.map(function(t){return fmtEng(t,4,xUnit);});}
         :function(u,ticks){return axisValuesSI(u,ticks,'x',xUnit);}},
      {scale:'y',stroke:'#7a92a8',grid:{stroke:'#1c2730'},ticks:{stroke:'#1c2730'},
       values:function(u,ticks){return axisValuesSI(u,ticks,'y',hasCurrent?'V':'');}}
    ]
  };
  if(hasCurrent){
    opts.axes.push({scale:'y2',side:1,stroke:'#7a92a8',grid:{show:false},ticks:{stroke:'#1c2730'},
      values:function(u,ticks){return axisValuesSI(u,ticks,'y2','A');}});
  }
  var data=[xVals].concat(ser.datas);
  container.innerHTML='';
  if(simPlot){simPlot.destroy();simPlot=null;}
  simYFit=null;simYFit2=null;
  simPlot=new uPlot(opts,data,container);
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
// integer digits. Everything is derived from the scale (not from the ticks), so
// it stays in sync no matter in which order uPlot draws things.
function axisValuesSI(u,ticks,scaleKey,unit){
  var sc=u.scales[scaleKey]||{};
  var lo=(sc.min!=null)?sc.min:(ticks.length?ticks[0]:0);
  var hi=(sc.max!=null)?sc.max:(ticks.length?ticks[ticks.length-1]:0);
  var maxAbs=Math.max(Math.abs(lo),Math.abs(hi));
  var span=Math.abs(hi-lo)||maxAbs;
  var idx=siIndexFor(span);
  while(idx>0&&maxAbs/SI_PREFIX[idx][0]>=10000)idx--;
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
  var i1=simCursors[0].idx,i2=simCursors[1].idx;
  if(u.data[0][i1]==null||u.data[0][i2]==null){overlayEl.style.display='none';return;}
  var x1=u.data[0][i1],x2=u.data[0][i2];
  var dtLabel=(simXUnit==='Hz')?'Δf':'Δt';
  var html='<div class="sim-cursor-hdr">1 → 2</div>'+
    '<div class="sim-cursor-row sim-cursor-dt">'+esc(dtLabel)+': '+fmtEng(x2-x1,5,simXUnit)+'</div>';
  for(var s=1;s<u.series.length;s++){
    var ser=u.series[s];
    if(ser.show===false)continue;
    var d=u.data[s];
    var v1=d?d[i1]:null,v2=d?d[i2]:null;
    if(v1==null||v2==null||!isFinite(v1)||!isFinite(v2))continue;
    // ser.stroke is uPlot's internal accessor, not the hex string — see the
    // same note in simTooltipPlugin.
    var col=simSeriesColor[String(ser.label).toLowerCase()]||'#888';
    html+='<div class="sim-cursor-row"><span class="sim-cursor-dot" style="background:'+col+'"></span>'+
      '<span class="sim-cursor-lbl">'+esc(String(ser.label))+'</span>'+
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

// Single click: on a device pin this toggles a CURRENT probe I(dev.pin);
// anywhere else on a net it toggles the node voltage probe V(net).
function toggleProbeAt(x,y){
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
  var a=_probeNet(x1,y1); // measured (minuend) - drag START
  var b=_probeNet(x2,y2); // reference (subtrahend) - drag END
  var aOk=a&&a!=='0', bOk=b&&b!=='0';
  if(!S.probes)S.probes=[];
  if(!aOk&&!bOk){hint('No nets to probe');return;}
  if(!aOk||!bOk||a===b){
    var net=aOk?a:b;
    dropAutoSelection();
    if(!S.probes.some(function(p){return p.kind==='V'&&p.net===net;})){S.probes.push({kind:'V',net:net});}
    setSelected('v('+net+')',true);
    hint('Probe added: V('+net+')');
    _afterProbeChange();return;
  }
  if(S.probes.some(function(p){return p.kind==='Vd'&&p.p===a&&p.n===b;})){
    hint('Differential probe already present');return;
  }
  dropAutoSelection();
  S.probes.push({kind:'Vd',p:a,n:b});
  hint('Probe added: V('+a+')-V('+b+')');
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
  return pr.kind==='Vd'?('V('+pr.p+')−V('+pr.n+')'):('V('+pr.net+')');
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
    applySimConfigCollapse();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach);else attach();
})();

function resizeSimPlot(){
  var c=document.getElementById('sim-plot');
  if(!simPlot||!c)return;
  var w=Math.max(120,c.clientWidth),h=Math.max(60,c.clientHeight);
  if(simPlot.width===w&&simPlot.height===h)return;
  simPlot.setSize({width:w,height:h});
}
window.addEventListener('resize',function(){ if(simViewActive&&simPlot)resizeSimPlot(); });

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
