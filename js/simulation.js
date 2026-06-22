// ═══════════════════════════════════════════════════
// NGSPICE SIMULATION (WASM) + INTERACTIVE PLOT
//
// Uses eecircuit-engine (ngspice compiled to WebAssembly) loaded lazily from a
// CDN as an ES module, and uPlot for an interactive (zoom / pan / cursor /
// legend) time- and frequency-domain plot. Net selection for the plot is driven
// by the existing Probe mode: clicking a net or pin in probe mode toggles that
// node into S.probes; only probed nets are plotted (or all node voltages when
// none are selected).
//
// Requires a network connection on first run to fetch the WASM engine. The
// engine and uPlot can later be vendored locally for offline use.
// ═══════════════════════════════════════════════════

var EE_ENGINE_URL='https://esm.sh/eecircuit-engine@1.7.0';
var simInstance=null;     // started Simulation instance (cached)
var simStarting=null;     // in-flight start() promise (de-dupes concurrent starts)
var simPlot=null;         // current uPlot instance
var simLastResult=null;   // last result, for re-plot when probe selection changes
var simRawSelection={};    // raw mode: map of vector-name(lowercase) -> true to plot
var simRawInit=false;      // whether the raw picker has been prefilled for the current result
var simViewActive=false;   // split-screen simulation view open?

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

// Assemble the full deck: generated devices + user analysis directives + .end.
function buildFullNetlist(){
  var core=generateNetlist();
  var dirEl=document.getElementById('sim-directives');
  var directives=dirEl?(dirEl.value||'').trim():'';
  var lines=[core];
  if(directives)lines.push(directives);
  lines.push('.end');
  return lines.join('\n');
}

function runSimulation(){
  var btn=document.getElementById('sim-run-btn');
  if(btn)btn.disabled=true;
  var logEl=document.getElementById('sim-log');if(logEl)logEl.textContent='';
  ensureSim().then(function(sim){
    var netlist=buildFullNetlist();
    simLog('--- Netlist sent to NGSpice ---');
    simLog(netlist);
    simLog('-------------------------------');
    sim.setNetList(netlist);
    simStatus('Simulating…');
    return sim.runSim();
  }).then(function(result){
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
    simRawInit=false; // fresh result: let the raw picker prefill once
    simStatus('Done: '+result.numPoints+' point(s), '+result.numVariables+' variable(s), '+result.dataType+'.');
    plotResult(result);
  }).catch(function(err){
    simStatus('Simulation failed: '+(err&&err.message||err));
    simLog(String(err&&err.stack||err),true);
  }).then(function(){
    if(btn)btn.disabled=false;
  });
}

// ---- result -> numeric helpers (real numbers or {real,img}) ----
function _re(v){return (v&&typeof v==='object')?v.real:v;}
function _mag(v){return (v&&typeof v==='object')?Math.sqrt(v.real*v.real+v.img*v.img):Math.abs(v);}

function getRawMode(){var c=document.getElementById('sim-raw-mode');return !!(c&&c.checked);}

// Compute the y-series to plot from a result, honouring the active mode:
//  - raw mode:  whatever is ticked in the raw vector picker (simRawSelection)
//  - else:      the probe selection (single V(net) and differential V(a)-V(b)),
//               falling back to all node voltages when no probes are set.
function buildSeriesFromResult(result){
  var isComplex=(result.dataType==='complex');
  var conv=isComplex?_mag:_re;
  var map={};
  for(var i=1;i<result.data.length;i++){
    map[String(result.data[i].name).toLowerCase()]=result.data[i].values.map(conv);
  }
  var names=[],datas=[];
  if(getRawMode()){
    for(var r=1;r<result.data.length;r++){
      var rn=String(result.data[r].name);
      if(simRawSelection[rn.toLowerCase()]){names.push(rn);datas.push(map[rn.toLowerCase()]);}
    }
    return {names:names,datas:datas};
  }
  var probes=S.probes||[];
  for(var p=0;p<probes.length;p++){
    var pr=probes[p];
    if(pr.kind==='V'){
      var key='v('+pr.net+')';
      if(map[key]){names.push('V('+pr.net+')');datas.push(map[key]);}
      else simLog('probe vector not found: '+key,true);
    }else if(pr.kind==='Vd'){
      var kp='v('+pr.p+')',kn='v('+pr.n+')';
      if(map[kp]&&map[kn]){
        var a=map[kp],b=map[kn],diff=new Array(a.length);
        for(var d=0;d<a.length;d++)diff[d]=a[d]-b[d];
        names.push('V('+pr.p+')-V('+pr.n+')');datas.push(diff);
      }else simLog('differential probe vectors not found: '+kp+', '+kn,true);
    }
  }
  if(!names.length){
    for(var v=1;v<result.data.length;v++){
      var vv=result.data[v],nm=String(vv.name).toLowerCase();
      if((vv.type==='voltage')||nm.indexOf('v(')===0){names.push(vv.name);datas.push(map[nm]);}
    }
  }
  return {names:names,datas:datas};
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
      html+='<tr><td>'+dv.name+'</td><td>'+(isComplex?_mag(val).toPrecision(6):(_re(val)).toPrecision(6))+'</td></tr>';
    }
    html+='</table>';
    container.innerHTML=html;
    if(simPlot){simPlot.destroy();simPlot=null;}
    return;
  }
  var xVals=xVar.values.map(_re);
  var ser=buildSeriesFromResult(result);
  var palette=['#00c8ff','#ff9040','#40ff90','#ff5f87','#c080ff','#ffd040','#5fd0ff','#ff6b35'];
  var series=[{label:isFreq?'Freq [Hz]':(xVar.type==='time'?'Time [s]':(xVar.name||'x'))}];
  for(var k=0;k<ser.names.length;k++){
    series.push({label:ser.names[k]+(isComplex?' |mag|':''),stroke:palette[k%palette.length],width:2});
  }
  var opts={
    width:Math.max(120,container.clientWidth||600),
    height:Math.max(60,container.clientHeight||320),
    series:series,
    scales:{x:{time:false,distr:isFreq?3:1}},
    cursor:{drag:{x:true,y:true,uni:8}},
    legend:{live:true},
    axes:[
      {stroke:'#7a92a8',grid:{stroke:'#1c2730'},ticks:{stroke:'#1c2730'}},
      {stroke:'#7a92a8',grid:{stroke:'#1c2730'},ticks:{stroke:'#1c2730'}}
    ]
  };
  var data=[xVals].concat(ser.datas);
  container.innerHTML='';
  if(simPlot){simPlot.destroy();simPlot=null;}
  simPlot=new uPlot(opts,data,container);
}

// Raw mode: list every vector of the last result with a checkbox so the user
// can plot any signal afterward, independent of the canvas probe selection.
function renderRawPanel(result){
  var panel=document.getElementById('sim-raw-panel');
  if(!panel)return;
  if(!getRawMode()||!result){panel.style.display='none';panel.innerHTML='';return;}
  // Prefill with all node voltages exactly once per result/mode-entry. After
  // that we respect the user's choices — including deselecting everything
  // (no auto re-selection of defaults).
  if(!simRawInit){
    simRawSelection={};
    for(var i=1;i<result.data.length;i++){
      var vv=result.data[i],nm=String(vv.name).toLowerCase();
      if((vv.type==='voltage')||nm.indexOf('v(')===0)simRawSelection[nm]=true;
    }
    simRawInit=true;
  }
  var html='<div class="sim-label">Raw vectors <span class="sim-sub">tick to plot</span></div><div class="sim-raw-grid">';
  for(var j=1;j<result.data.length;j++){
    var name=result.data[j].name,key=name.toLowerCase();
    html+='<label class="sim-raw-item"><input type="checkbox" data-vec="'+esc(key)+'"'+(simRawSelection[key]?' checked':'')+'> '+name+'</label>';
  }
  html+='</div>';
  panel.style.display='block';
  panel.innerHTML=html;
  panel.querySelectorAll('input[type=checkbox]').forEach(function(cb){
    cb.addEventListener('change',function(){
      var k=cb.getAttribute('data-vec');
      if(cb.checked)simRawSelection[k]=true;else delete simRawSelection[k];
      if(simLastResult)plotResult(simLastResult);
    });
  });
}

// Toggled by the "raw mode" checkbox.
function onRawModeChange(){
  simRawInit=false;                    // re-prefill the picker for the current result
  if(!getRawMode())simRawSelection={};
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

// Single click: toggle a single-ended voltage probe V(net).
function toggleProbeAt(x,y){
  var net=_probeNet(x,y);
  if(net==='0'){hint('Ground (node 0) is not plottable');return;}
  if(!net){hint('No net to probe here');return;}
  if(!S.probes)S.probes=[];
  var idx=-1;
  for(var i=0;i<S.probes.length;i++){if(S.probes[i].kind==='V'&&S.probes[i].net===net){idx=i;break;}}
  if(idx>=0){S.probes.splice(idx,1);hint('Probe removed: V('+net+')');}
  else{S.probes.push({kind:'V',net:net});hint('Probe added: V('+net+')');}
  _afterProbeChange();
}

// Drag from net A to net B: add a differential probe V(B)-V(A).
// If either endpoint is ground/invalid or both are the same net, it degrades
// to a single-ended probe of the meaningful node.
function addDiffProbe(x1,y1,x2,y2){
  var a=_probeNet(x1,y1); // reference (subtrahend)
  var b=_probeNet(x2,y2); // measured
  var aOk=a&&a!=='0', bOk=b&&b!=='0';
  if(!S.probes)S.probes=[];
  if(!aOk&&!bOk){hint('No nets to probe');return;}
  if(!aOk||!bOk||a===b){
    var net=bOk?b:a;
    if(!S.probes.some(function(p){return p.kind==='V'&&p.net===net;})){S.probes.push({kind:'V',net:net});}
    hint('Probe added: V('+net+')');
    _afterProbeChange();return;
  }
  if(S.probes.some(function(p){return p.kind==='Vd'&&p.p===b&&p.n===a;})){
    hint('Differential probe already present');return;
  }
  S.probes.push({kind:'Vd',p:b,n:a});
  hint('Probe added: V('+b+')-V('+a+')');
  _afterProbeChange();
}

function clearProbes(){
  S.probes=[];
  _afterProbeChange();
}

function _probeLabel(pr){
  return pr.kind==='Vd'?('V('+pr.p+')−V('+pr.n+')'):('V('+pr.net+')');
}

function renderProbeList(){
  var el=document.getElementById('sim-probe-list');
  if(!el)return;
  var probes=S.probes||[];
  if(!probes.length){
    el.innerHTML='<span class="sim-probe-empty">none — probe a net (P, click) or drag between two nets for a differential; otherwise all node voltages are shown</span>';
    return;
  }
  var html='';
  for(var i=0;i<probes.length;i++){
    html+='<span class="sim-chip">'+_probeLabel(probes[i])+'<button title="remove" onclick="removeProbe('+i+')">×</button></span>';
  }
  el.innerHTML=html;
}

function removeProbe(idx){
  if(!S.probes)return;
  S.probes.splice(idx,1);
  _afterProbeChange();
}

// ═══ SPLIT-SCREEN VIEW ═══
// The plot lives in a bottom pane that splits the canvas vertically; the
// simulation settings live in the properties panel. SIMULATE toggles both.
function toggleSimView(){ setSimView(!simViewActive); }

function setSimView(on){
  simViewActive=!!on;
  var pane=document.getElementById('sim-pane');
  var divider=document.getElementById('sim-divider');
  var settings=document.getElementById('sim-settings');
  var btn=document.getElementById('btn-sim');
  if(pane)pane.style.display=simViewActive?'flex':'none';
  if(divider)divider.style.display=simViewActive?'block':'none';
  if(btn)btn.classList.toggle('active',simViewActive);
  if(settings){
    if(simViewActive){
      // show sim settings, hide the other properties sections
      document.getElementById('props-content').style.display='none';
      var cc=document.getElementById('custom-comp-section');if(cc)cc.style.display='none';
      settings.style.display='block';
      renderProbeList();
    }else{
      settings.style.display='none';
      renderProps(); // restore normal properties view
    }
  }
  if(typeof applyView==='function')applyView();  // SVG viewBox tracks the new pane size
  if(simViewActive&&simLastResult)plotResult(simLastResult);
}

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

function resizeSimPlot(){
  var c=document.getElementById('sim-plot');
  if(simPlot&&c)simPlot.setSize({width:Math.max(120,c.clientWidth),height:Math.max(60,c.clientHeight)});
}
window.addEventListener('resize',function(){ if(simViewActive&&simPlot)resizeSimPlot(); });
