// ═══════════════════════════════════════════════════
// POWER ANALYZER PA-4: TURMERICLAB SIMULATION SOURCE
//
// Glue between the portable instrument (power-analyzer-core.js / -ui.js)
// and this app: implements the analyzer's data-source interface on top of
// the last ngspice transient result (simLastResult), the plot probes
// (S.probes) and the user formulas, routes probe clicks to the analyzer while
// it assigns channels, and persists the instrument setup. Loaded after
// simulation.js; everything instrument-specific lives in the PA files.
//
// Signal ids (stored in the analyzer config, stable across runs):
//   v:<net>          node voltage V(net)
//   vd:<a>|<b>       differential voltage V(a)-V(b)
//   ip:<compId>:<pin> device current as the plot's current probe sees it
//   vec:<name>       any raw result vector
//   f:<name>         a user formula from the simulation settings
// ═══════════════════════════════════════════════════

var paUI=null;
var paConfig=null;   // instrument setup, persisted even while the dialog was never opened
var paPick=null;     // {kind:'U'|'I', cb} while the analyzer assigns a channel by probing
var paMapCache={result:null,map:null};

(function paLoadConfig(){
  try{var raw=localStorage.getItem('pa_config');if(raw)paConfig=JSON.parse(raw);}
  catch(e){paConfig=null;}
})();
function paSaveConfig(){
  try{localStorage.setItem('pa_config',JSON.stringify(paConfig));}catch(e){}
}

function openPowerAnalyzer(){
  if(typeof PowerAnalyzer==='undefined'||!PowerAnalyzer.createUI){hint('Power analyzer scripts not loaded');return;}
  if(!paUI){
    paUI=PowerAnalyzer.createUI({
      source:paSource,
      config:paConfig,
      // large records are evaluated off the main thread
      workerUrl:'js/power-analyzer-worker.js',
      onConfigChange:function(cfg){paConfig=cfg;paSaveConfig();}
    });
  }
  paUI.open();
}
// The full dialog is up: the editor's keyboard shortcuts must stay quiet.
function paIsModal(){return !!(paUI&&paUI.isModal());}
// A simulation run finished (called from finishRun()).
function paNotifyData(){if(paUI)paUI.dataChanged();}
// Schematic loaded from a file / the library (called from applyState()).
// Without its own analyzer setup, the channel assignments of the previous
// schematic are dropped (their nets/devices mean nothing here), the
// instrument settings are kept.
function paApplyStateConfig(cfg){
  if(cfg&&typeof cfg==='object')paConfig=cfg;
  else if(paConfig&&Array.isArray(paConfig.elements)){
    paConfig.elements.forEach(function(el){if(el){el.u=null;el.i=null;}});
    if(paConfig.ui)paConfig.ui.plot=null;
  }
  paSaveConfig();
  if(paUI)paUI.setConfig(paConfig||{});
}

function paVectorMap(){
  if(!simLastResult)return null;
  if(paMapCache.result!==simLastResult){
    paMapCache.result=simLastResult;
    paMapCache.map=vectorMapOf(simLastResult);
  }
  return paMapCache.map;
}

function paProbeSignal(pr){
  if(pr.kind==='V')return {id:'v:'+pr.net,label:'V('+pr.net+')'};
  if(pr.kind==='Vd')return {id:'vd:'+pr.p+'|'+pr.n,label:'V('+pr.p+')-V('+pr.n+')'};
  if(pr.kind==='I')return {id:'ip:'+pr.compId+':'+pr.pinIdx,label:currentProbeLabel(pr)};
  return null;
}

// Signal id -> sample array on the ngspice time grid (or null).
function paResolve(id,map,n){
  var s=String(id),k,m;
  if(s.indexOf('v:')===0){
    k=findVectorKey(map,'v('+s.slice(2)+')');
    return k?map[k]:null;
  }
  if(s.indexOf('vd:')===0){
    var ab=s.slice(3).split('|');
    var ka=findVectorKey(map,'v('+ab[0]+')'),kb=findVectorKey(map,'v('+ab[1]+')');
    if(!ka||!kb)return null;
    var A=map[ka],B=map[kb],out=new Array(A.length);
    for(var i=0;i<A.length;i++)out[i]=A[i]-B[i];
    return out;
  }
  if(s.indexOf('ip:')===0){
    var rest=s.slice(3),cut=rest.lastIndexOf(':');
    var cid=rest.slice(0,cut),pin=+rest.slice(cut+1);
    var comp=S.components.find(function(c){return String(c.id)===cid;});
    if(!comp)return null;
    var r=resolveCurrentProbe({kind:'I',compId:comp.id,pinIdx:pin},map);
    return r&&r.data?r.data:null;
  }
  if(s.indexOf('vec:')===0){
    k=findVectorKey(map,s.slice(4));
    return k?map[k]:null;
  }
  if(s.indexOf('f:')===0){
    var name=s.slice(2),f=null;
    for(var j=0;j<simFormulas.length;j++)if((simFormulas[j].name||simFormulas[j].expr)===name){f=simFormulas[j];break;}
    if(!f||!f.expr)return null;
    try{return evalFormula(f.expr,map,n);}catch(e){return null;}
  }
  return null;
}

// "Nice" 1-2-5 value at or above v.
function paNiceUp(v){
  var p=Math.pow(10,Math.floor(Math.log10(v))),m=v/p;
  return (m<=1?1:m<=2?2:m<=5?5:10)*p;
}

var paSource={
  listSignals:function(kind){
    var out=[],seen={};
    function add(sig,group){if(sig&&!seen[sig.id]){seen[sig.id]=true;sig.group=group;out.push(sig);}}
    (S.probes||[]).forEach(function(pr){
      if(kind==='U'&&(pr.kind==='V'||pr.kind==='Vd'))add(paProbeSignal(pr),'Plot probes');
      if(kind==='I'&&pr.kind==='I')add(paProbeSignal(pr),'Plot probes');
    });
    if(simLastResult&&simLastResult.data){
      for(var i=1;i<simLastResult.data.length;i++){
        var nm=String(simLastResult.data[i].name),lc=nm.toLowerCase(),isI=isCurrentVectorName(lc);
        if(kind==='U'&&!isI){
          var mv=/^v\((.+)\)$/.exec(lc);
          add(mv?{id:'v:'+mv[1],label:'V('+mv[1]+')'}:{id:'vec:'+lc,label:nm},'Node voltages');
        }
        if(kind==='I'&&isI)add({id:'vec:'+lc,label:nm},'Result currents');
      }
    }
    simFormulas.forEach(function(f){
      if(f.expr)add({id:'f:'+(f.name||f.expr),label:(f.name||f.expr)},'Formulas');
    });
    return out;
  },

  // Resample the requested signals of the last transient run onto the
  // instrument's uniform sampling grid.
  acquire:function(cfg){
    if(!simLastResult||!simLastResult.data||!simLastResult.data.length)
      return {error:'No simulation data yet. Run a transient simulation (.tran), the analyzer evaluates its result.'};
    var xv=simLastResult.data[0];
    if(xv.type!=='time')
      return {error:'The power analyzer needs a transient analysis (.tran). The last run was "'+(xv.type||simAnalysis.type)+'".'};
    var map=paVectorMap();
    var t=map[String(xv.name).toLowerCase()];
    if(!t||t.length<2)return {error:'The last run returned too few time points.'};
    var n0=t.length,span=t[n0-1]-t[0];
    if(!(span>0))return {error:'The last run has no time span.'};
    var maxStep=0;
    for(var k=1;k<n0;k++){var d=t[k]-t[k-1];if(d>maxStep)maxStep=d;}
    var warnings=[];
    var NMAX=2e6,fs;
    if(cfg.fs==='auto'||!(+cfg.fs>0)){
      fs=paNiceUp(Math.max(4*n0/span,1000/span));
      while(fs*span>NMAX)fs=fs/2;
    }else{
      fs=+cfg.fs;
      if(fs*span>4*NMAX){fs=4*NMAX/span;warnings.push('Sampling rate reduced to '+PowerAnalyzer.fmt(fs,'S/s',3)+' (record too long)');}
    }
    var dt=1/fs,n=Math.floor(span*fs+1e-9)+1;
    var rec=PowerAnalyzer.makeRecord(t[0],dt,n);
    var any=false;
    for(var e=0;e<4;e++){
      var el=cfg.elements[e]||{};
      if(!PowerAnalyzer.elementUsed(cfg.wiring,e))continue;
      [['u','U'],['i','I']].forEach(function(ui){
        var sig=el[ui[0]];
        if(!sig)return;
        var arr=paResolve(sig.id,map,n0);
        if(!arr){warnings.push('CH'+(e+1)+' '+ui[1]+': '+sig.label+' not in the last run');return;}
        rec[ui[0]][e]=PowerAnalyzer.resampleLinear(t,arr,t[0],dt,n);
        any=true;
      });
    }
    if(!any)return {error:'No channel assigned. Open the Channels tab and pick a voltage and a current per element (⌖ picks them on the schematic).'};
    return {rec:rec,fs:fs,maxStep:maxStep,warnings:warnings};
  },

  beginPick:function(kind,cb){
    paPick={kind:kind,cb:cb};
    if(S.mode!=='probe')setMode('probe');
    hint(kind==='U'
      ?'Power analyzer: click a net for V(net), or drag from net A to net B for V(A)-V(B)'
      :'Power analyzer: click a device pin for its current');
  },
  endPick:function(){
    paPick=null;
    setMode('select');
  },

  hasSignal:function(id){
    var map=paVectorMap();
    if(!map)return true;   // no run yet: nothing to check against
    var n=simLastResult.data[0].values.length;
    return !!paResolve(id,map,n);
  },

  suggestChannels:function(){
    var us=[],is=[];
    (S.probes||[]).forEach(function(pr){
      if(pr.kind==='V'||pr.kind==='Vd')us.push(paProbeSignal(pr));
      else if(pr.kind==='I')is.push(paProbeSignal(pr));
    });
    var out=[];
    for(var e=0;e<4;e++)out.push({u:us[e]||null,i:is[e]||null});
    return out;
  }
};

// Probe clicks while the analyzer assigns a channel (hooked in at the top of
// toggleProbeAt / addDiffProbe). Returns true when the click was consumed.
// The plot's own probe list is left untouched.
function paHandleProbeClick(x,y){
  if(!paPick)return false;
  var sig=null;
  if(paPick.kind==='I'){
    var tgt=currentProbeTargetAt(x,y);
    if(!tgt){hint('Power analyzer: click directly on a device pin to pick a current');return true;}
    sig=paProbeSignal({kind:'I',compId:tgt.compId,pinIdx:tgt.pinIdx});
  }else{
    var net=_probeNet(x,y);
    if(!net||net==='0'){hint('Power analyzer: no net here (ground is the reference)');return true;}
    sig=paProbeSignal({kind:'V',net:net});
  }
  paDeliverPick(sig);
  return true;
}
function paHandleProbeDrag(x1,y1,x2,y2){
  if(!paPick)return false;
  if(paPick.kind==='I')return paHandleProbeClick(x1,y1);
  var a=_probeNet(x1,y1),b=_probeNet(x2,y2);
  var aOk=a&&a!=='0',bOk=b&&b!=='0';
  if(!aOk&&!bOk){hint('Power analyzer: no nets to probe here');return true;}
  var sig=(!aOk||!bOk||a===b)
    ?paProbeSignal({kind:'V',net:aOk?a:b})
    :paProbeSignal({kind:'Vd',p:a,n:b});
  paDeliverPick(sig);
  return true;
}
function paDeliverPick(sig){
  var cb=paPick&&paPick.cb;
  hint('Power analyzer: '+sig.label+' assigned');
  if(cb)cb(sig);
}
