// ═══════════════════════════════════════════════════
// POWER ANALYZER PA-4: USER INTERFACE
//
// Modal instrument front panel: control bar, numeric table (per element +
// Σ, plot checkboxes per cell), waveform + trend plots with a shared cursor,
// phasor diagram and channel assignment. Depends only on
// power-analyzer-core.js, uPlot (injected or window.uPlot) and a data
// source object, so it can later drive a real instrument as well:
//
//   source = {
//     listSignals(kind)        -> [{id,label,group}]   kind 'U' | 'I'
//     acquire(cfg)             -> {rec, fs, maxStep, warnings:[]} | {error}
//     beginPick(kind, onPick)  optional: pick a signal interactively,
//                              onPick({id,label}); endPick() to stop
//     suggestChannels()        optional -> [{u:{id,label}, i:{id,label}}, ...]
//     hasSignal(id)            optional -> false marks an assignment as missing
//   }
//
// Large records are evaluated in a Worker when opts.workerUrl points to
// power-analyzer-worker.js (threshold: opts.workerThreshold sample values).
//
// Usage: var ui = PowerAnalyzer.createUI({source, config, onConfigChange});
//        ui.open(); ui.dataChanged(); ui.setConfig(cfg);
// ═══════════════════════════════════════════════════
(function(root){
'use strict';

var PA=root.PowerAnalyzer;
if(!PA||!PA.Instrument)throw new Error('power-analyzer-ui.js needs power-analyzer-core.js');
var doc=root.document;
var SVGNS='http://www.w3.org/2000/svg';

var PALETTE=['#00c8ff','#ff9040','#40ff90','#ff5f87','#c080ff','#ffd040','#5fd0ff','#ff6b35','#9ad06a','#e070c0'];
// Phase colours after IEC 60446 (brown, black, grey), adapted to a dark panel.
var PHASE_COL=['#d98a48','#e8edf2','#8ea2b4'];
var COLS=[{id:'1',e:0},{id:'2',e:1},{id:'3',e:2},{id:'S',e:-1},{id:'4',e:3}];

var UPDATE_OPTS=[['auto:1','Auto · 1 period'],['auto:2','Auto · 2 periods'],['auto:5','Auto · 5 periods'],
  ['auto:10','Auto · 10 periods'],['time:0.001','1 ms'],['time:0.005','5 ms'],['time:0.01','10 ms'],
  ['time:0.02','20 ms'],['time:0.05','50 ms'],['time:0.1','100 ms'],['time:0.2','200 ms'],
  ['time:0.5','500 ms'],['time:1','1 s']];
var AVG_OPTS=[['off','Off'],['exp:2','EXP K=2'],['exp:4','EXP K=4'],['exp:8','EXP K=8'],['exp:16','EXP K=16'],
  ['exp:32','EXP K=32'],['exp:64','EXP K=64'],['lin:8','LIN m=8'],['lin:16','LIN m=16'],['lin:32','LIN m=32'],['lin:64','LIN m=64']];
var SYNC_OPTS=[['U1','U1'],['U2','U2'],['U3','U3'],['U4','U4'],['I1','I1'],['I2','I2'],['I3','I3'],['I4','I4'],
  ['fixed','Fixed f'],['none','None']];
var FS_OPTS=[['auto','Auto'],['50000','50 kS/s'],['100000','100 kS/s'],['200000','200 kS/s'],['500000','500 kS/s'],
  ['1000000','1 MS/s'],['2000000','2 MS/s'],['5000000','5 MS/s'],['10000000','10 MS/s']];
var SQ_OPTS=[['TYPE1','TYPE1 · ΣS, ΣQ'],['TYPE2','TYPE2 · QΣ from SΣ, PΣ'],['TYPE3','TYPE3 · SΣ from PΣ, QΣ'],['IEEE1459','IEEE 1459 · Se']];
var ETA_OPTS=[['off','Off'],['G/4','PΣ / P4 (inverter)'],['4/G','P4 / PΣ (rectifier)']];
var LEVEL_OPTS=[['1','Basic'],['2','Extended'],['3','All']];

// ─── small DOM helpers ───
function h(tag,attrs,kids){
  var n=doc.createElement(tag);
  if(attrs)for(var k in attrs){
    var v=attrs[k];
    if(v==null||v===false)continue;
    if(k==='class')n.className=v;
    else if(k==='text')n.textContent=v;
    else if(k==='style')n.style.cssText=v;
    else if(k.slice(0,2)==='on')n.addEventListener(k.slice(2),v);
    else n.setAttribute(k,v===true?'':v);
  }
  if(kids!=null)(Array.isArray(kids)?kids:[kids]).forEach(function(c){
    if(c==null)return;
    n.appendChild(typeof c==='string'?doc.createTextNode(c):c);
  });
  return n;
}
function sv(tag,attrs){
  var n=doc.createElementNS(SVGNS,tag);
  if(attrs)for(var k in attrs)if(attrs[k]!=null)n.setAttribute(k,attrs[k]);
  return n;
}
function select(opts,value,onchange,title){
  var s=h('select',{class:'pa-select',title:title||null,onchange:function(){onchange(s.value);}});
  opts.forEach(function(o){
    var op=h('option',{value:o[0],text:o[1]});
    if(String(o[0])===String(value))op.selected=true;
    s.appendChild(op);
  });
  return s;
}
function parseSI(s){
  s=String(s==null?'':s).trim().toLowerCase();
  var m=/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(meg|[tgkmunpf]|µ)?/.exec(s);
  if(!m)return NaN;
  var mult={t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,'µ':1e-6,n:1e-9,p:1e-12,f:1e-15}[m[2]]||1;
  return parseFloat(m[1])*mult;
}
function fmtShort(v,unit){return PA.fmt(v,unit,3);}
function clone(o){return JSON.parse(JSON.stringify(o));}
function unitScale(u){return u===''?'1':u;}

// ═══ UI object ═══
function UI(opts){
  this.opts=opts||{};
  this.source=this.opts.source;
  this.uPlot=this.opts.uPlot||root.uPlot;
  this.cfg=this._withUi(PA.normalizeConfig(this.opts.config));
  this.ins=null;this.acq=null;this.error=null;
  this.dispIdx=-1;this.hold=false;this.playTimer=null;
  this.mode='live';this.cursors=[];
  this.colors={};this.root=null;this.assign=null;
  this.syncKey='pa-'+Math.random().toString(36).slice(2);
  this._evalTimer=null;
}
PA.createUI=function(opts){return new UI(opts);};

UI.prototype._withUi=function(cfg){
  cfg.ui=cfg.ui||{};
  if(!cfg.ui.plot)cfg.ui.plot=null;           // null = defaults (u, i of assigned elements)
  if(!cfg.ui.level)cfg.ui.level=1;
  if(!cfg.ui.collapsed)cfg.ui.collapsed={};
  if(!cfg.ui.tab)cfg.ui.tab='num';
  return cfg;
};
UI.prototype.setConfig=function(cfg){
  this.cfg=this._withUi(PA.normalizeConfig(cfg));
  this.colors={};
  if(this.isOpen()){
    if(this.selLevel)this.selLevel.value=String(this.cfg.ui.level);
    this._syncControls();
    this._showTab(this.cfg.ui.tab);
    this.evaluate();
  }
};
UI.prototype.getConfig=function(){return clone(this.cfg);};
UI.prototype.isOpen=function(){return !!(this.root&&this.root.classList.contains('pa-open'));};
// Full dialog visible (blocks the editor). False while assigning by probe.
UI.prototype.isModal=function(){return this.isOpen()&&!this.assign;};

UI.prototype.open=function(){
  if(!this.root)this._build();
  this.root.classList.add('pa-open');
  this._syncControls();
  var any=this.cfg.elements.some(function(el){return el.u||el.i;});
  this._showTab(any?this.cfg.ui.tab:'ch');
  this.evaluate();
};
UI.prototype.close=function(){
  if(this.assign)this._endAssign(true);
  this._stopPlay();
  if(this.root)this.root.classList.remove('pa-open');
};
// The data source has new data (e.g. a simulation run finished).
UI.prototype.dataChanged=function(){
  if(this.isOpen()&&!this.assign)this.evaluate();
};
UI.prototype._emitConfig=function(){
  if(typeof this.opts.onConfigChange==='function')this.opts.onConfigChange(clone(this.cfg));
};
UI.prototype._configChanged=function(reeval){
  this._emitConfig();
  if(!reeval)return;
  var self=this;
  clearTimeout(this._evalTimer);
  this._evalTimer=setTimeout(function(){self.evaluate();},120);
};

// ─── DOM skeleton ───
UI.prototype._build=function(){
  var self=this;
  this.root=h('div',{class:'pa-root'});
  var backdrop=h('div',{class:'pa-backdrop'});
  this.win=h('div',{class:'pa-win',role:'dialog','aria-label':'Power analyzer'});
  var title=h('div',{class:'pa-titlebar'},[
    h('span',{class:'pa-brand',text:'PA-4'}),
    h('span',{class:'pa-title',text:'Power Analyzer'}),
    h('span',{class:'pa-sub',text:'4 elements · simulated input'}),
    h('span',{class:'pa-spacer'}),
    h('button',{class:'pa-close',title:'Close (Esc)',text:'×',onclick:function(){self.close();}})
  ]);
  this.ctrl=h('div',{class:'pa-controls'});
  this.tabs=h('div',{class:'pa-tabs'});
  var body=h('div',{class:'pa-body'});
  this.paneNum=h('div',{class:'pa-pane pa-pane-num'});
  this.tableWrap=h('div',{class:'pa-table-wrap'});
  this.plotsWrap=h('div',{class:'pa-plots'});
  this.waveDiv=h('div',{class:'pa-plot pa-plot-wave'});
  this.trendDiv=h('div',{class:'pa-plot pa-plot-trend'});
  this.plotHint=h('div',{class:'pa-plot-hint',text:'drag to zoom · double-click to reset · click to set cursor 1/2'});
  this.plotsWrap.appendChild(this.waveDiv);
  this.plotsWrap.appendChild(this.trendDiv);
  this.plotsWrap.appendChild(this.plotHint);
  this.paneNum.appendChild(this.tableWrap);
  this.paneNum.appendChild(this.plotsWrap);
  this.paneVec=h('div',{class:'pa-pane pa-pane-vec'});
  this.paneHarm=h('div',{class:'pa-pane pa-pane-harm'});
  this.paneCh=h('div',{class:'pa-pane pa-pane-ch'});
  this.paneSetup=h('div',{class:'pa-pane pa-pane-setup'});
  this.msg=h('div',{class:'pa-msg'});
  [this.paneNum,this.paneVec,this.paneHarm,this.paneCh,this.paneSetup,this.msg].forEach(function(n){body.appendChild(n);});
  this.status=h('div',{class:'pa-status'});
  this.win.appendChild(title);this.win.appendChild(this.ctrl);this.win.appendChild(this.tabs);
  this.win.appendChild(body);this.win.appendChild(this.status);
  this.assignBar=h('div',{class:'pa-assignbar'});
  this.root.appendChild(backdrop);this.root.appendChild(this.win);this.root.appendChild(this.assignBar);
  (this.opts.host||doc.body).appendChild(this.root);
  this._buildControls();
  this._buildTabs();
  doc.addEventListener('keydown',function(e){
    if(!self.isOpen()||e.key!=='Escape')return;
    if(self.assign){self._endAssign();}
    else{
      var t=e.target&&e.target.tagName;
      if(t==='SELECT'||t==='INPUT'){e.target.blur();}
      self.close();
    }
    e.stopPropagation();e.preventDefault();
  },true);
  if(typeof ResizeObserver!=='undefined'){
    var ro=new ResizeObserver(function(){self._resizePlots();});
    ro.observe(this.waveDiv);ro.observe(this.trendDiv);
  }
};

UI.prototype._buildControls=function(){
  var self=this,c=this.cfg,ctrl=this.ctrl;
  ctrl.textContent='';
  function grp(label,el){return h('label',{class:'pa-ctl'},[h('span',{class:'pa-ctl-lbl',text:label}),el]);}
  this.selWiring=select(Object.keys(PA.WIRINGS).map(function(k){return [k,PA.WIRINGS[k].label];}),c.wiring,function(v){
    self.cfg.wiring=v;self._configChanged(true);
  },'Wiring system');
  this.selSync=select(SYNC_OPTS,c.sync.src,function(v){self.cfg.sync.src=v;self._syncControls();self._configChanged(true);},
    'Synchronisation source: the measurement period is a whole number of its periods');
  this.inpFreq=h('input',{class:'pa-input pa-input-s',value:String(c.sync.freq),title:'Fixed sync frequency [Hz]',
    onchange:function(){var f=parseSI(self.inpFreq.value);if(f>0){self.cfg.sync.freq=f;self._configChanged(true);}}});
  this.selUpdate=select(UPDATE_OPTS,c.update.mode+':'+(c.update.mode==='auto'?c.update.periods:c.update.time),function(v){
    var p=v.split(':');
    self.cfg.update.mode=p[0];
    if(p[0]==='auto')self.cfg.update.periods=+p[1];else self.cfg.update.time=+p[1];
    self._configChanged(true);
  },'Update rate: Auto = every n whole periods of the sync source; fixed times are simulation time');
  this.selAvg=select(AVG_OPTS,c.avg.mode==='off'?'off':(c.avg.mode+':'+(c.avg.mode==='exp'?c.avg.K:c.avg.m)),function(v){
    var p=v.split(':');
    self.cfg.avg.mode=p[0];
    if(p[0]==='exp')self.cfg.avg.K=+p[1];else if(p[0]==='lin')self.cfg.avg.m=+p[1];
    self._configChanged(true);
  },'Averaging: EXP Dn = Dn-1 + (Mn - Dn-1)/K, LIN = moving average over m updates');
  this.selSq=select(SQ_OPTS,c.sq,function(v){self.cfg.sq=v;self._configChanged(true);},
    'Formula for apparent and reactive power of the Σ group');
  this.selEta=select(ETA_OPTS,c.eta,function(v){self.cfg.eta=v;self._renderTable();self._configChanged(true);},
    'Efficiency between the Σ group and element 4');
  this.selFs=select(FS_OPTS,String(c.fs),function(v){self.cfg.fs=(v==='auto')?'auto':+v;self._configChanged(true);},
    'Sampling rate the simulation is resampled to');
  this.inpStart=h('input',{class:'pa-input pa-input-s',value:c.tStart?PA.fmt(c.tStart,'s',4).replace(/\s/g,''):'0',
    title:'Evaluation start time (skip start-up transients), SPICE suffixes allowed: 20m, 1.5m …',
    onchange:function(){var t=parseSI(self.inpStart.value);self.cfg.tStart=isFinite(t)&&t>0?t:0;self._configChanged(true);}});
  this.leds={};
  var leds=h('div',{class:'pa-leds'});
  ['SYNC','OVR','AVG','HOLD'].forEach(function(n){
    var l=h('span',{class:'pa-led',text:n});
    self.leds[n]=l;leds.appendChild(l);
  });
  this.btnPlay=h('button',{class:'pa-btn',title:'Replay the measurement like the running instrument (one update after the other)',
    text:'▶ Replay',onclick:function(){self._togglePlay();}});
  this.btnHold=h('button',{class:'pa-btn',text:'HOLD',title:'Freeze the display',onclick:function(){self._toggleHold();}});
  this.btnSingle=h('button',{class:'pa-btn',text:'SINGLE',title:'In HOLD: advance exactly one update',onclick:function(){self._single();}});
  ctrl.appendChild(grp('Wiring',this.selWiring));
  ctrl.appendChild(grp('Sync',h('span',{class:'pa-inline'},[this.selSync,this.inpFreq])));
  ctrl.appendChild(grp('Update',this.selUpdate));
  ctrl.appendChild(grp('Averaging',this.selAvg));
  ctrl.appendChild(grp('S, Q formula',this.selSq));
  ctrl.appendChild(grp('η',this.selEta));
  ctrl.appendChild(grp('Sampling',this.selFs));
  ctrl.appendChild(grp('Start',this.inpStart));
  ctrl.appendChild(h('span',{class:'pa-spacer'}));
  ctrl.appendChild(leds);
  ctrl.appendChild(h('span',{class:'pa-btn-group'},[this.btnPlay,this.btnHold,this.btnSingle]));
};
UI.prototype._syncControls=function(){
  if(!this.ctrl)return;
  var c=this.cfg;
  this.selWiring.value=c.wiring;
  this.selSync.value=c.sync.src;
  this.inpFreq.style.display=c.sync.src==='fixed'?'':'none';
  this.selUpdate.value=c.update.mode+':'+(c.update.mode==='auto'?c.update.periods:c.update.time);
  this.selAvg.value=c.avg.mode==='off'?'off':(c.avg.mode+':'+(c.avg.mode==='exp'?c.avg.K:c.avg.m));
  this.selSq.value=c.sq;this.selEta.value=c.eta;this.selFs.value=String(c.fs);
  this.inpStart.value=c.tStart?PA.fmt(c.tStart,'s',4).replace(/\s/g,''):'0';
  this.inpFreq.value=String(c.sync.freq);
};

UI.prototype._buildTabs=function(){
  var self=this;
  this.tabs.textContent='';
  this.tabBtns={};
  [['num','Numeric + Plot'],['vec','Phasors'],['harm','Harmonics'],['ch','Channels'],['setup','Setup']].forEach(function(t){
    var b=h('button',{class:'pa-tab',text:t[1],onclick:function(){self._showTab(t[0]);}});
    self.tabBtns[t[0]]=b;self.tabs.appendChild(b);
  });
  this.tabs.appendChild(h('span',{class:'pa-spacer'}));
  this.modeBtns={};
  var modes=h('span',{class:'pa-seg',title:'What the table shows'});
  [['live','Display'],['cursor','Cursor'],['window','Cursor 1→2']].forEach(function(m){
    var b=h('button',{class:'pa-seg-btn',text:m[1],onclick:function(){self._setMode(m[0]);}});
    self.modeBtns[m[0]]=b;modes.appendChild(b);
  });
  this.tabs.appendChild(modes);
  this.selLevel=select(LEVEL_OPTS,String(this.cfg.ui.level),function(v){
    self.cfg.ui.level=+v;self._renderTable();self._emitConfig();
  },'How many quantities the table lists');
  this.tabs.appendChild(h('label',{class:'pa-ctl'},[h('span',{class:'pa-ctl-lbl',text:'Values'}),this.selLevel]));
};
UI.prototype._showTab=function(id){
  this.cfg.ui.tab=id;
  for(var k in this.tabBtns)this.tabBtns[k].classList.toggle('active',k===id);
  var panes={num:this.paneNum,vec:this.paneVec,harm:this.paneHarm,ch:this.paneCh,setup:this.paneSetup};
  for(var p in panes)panes[p].style.display=p===id?'':'none';
  if(id==='ch')this._renderChannels();
  if(id==='vec')this._renderVector();
  if(id==='harm')this._renderHarm();
  if(id==='setup')this._renderSetup();
  if(id==='num')this._resizePlots();
  this._updMsg();
  this._emitConfig();
};
UI.prototype._updMsg=function(){
  if(!this.msg)return;
  var show=(this.busy||this.error)&&(this.cfg.ui.tab==='num'||this.cfg.ui.tab==='harm'||this.cfg.ui.tab==='vec');
  this.msg.style.display=show?'':'none';
  this.msg.textContent=this.busy?'Evaluating '+this.busy+' …':(this.error||'');
};
UI.prototype._setMode=function(m){
  if(m==='window'&&this.cursors.length<2){this._flash('Set two cursors in the plot first (click twice).');return;}
  this.mode=m;
  for(var k in this.modeBtns)this.modeBtns[k].classList.toggle('active',k===m);
  this._renderTable();
  this._refresh();
};

// ─── evaluation ───
UI.prototype.evaluate=function(){
  if(!this.root)return;
  this._stopPlay();
  var self=this,acq=null;
  try{acq=this.source&&this.source.acquire?this.source.acquire(this.cfg):{error:'No data source.'};}
  catch(e){acq={error:'Data source failed: '+e.message};}
  this.acq=acq;
  this.error=acq&&acq.error?acq.error:null;
  this.ins=null;this.wave=null;this.busy=null;
  var job=this._job=(this._job||0)+1;
  if(!this.error){
    var rec=acq.rec,cfg=clone(this.cfg);
    var t0=(typeof performance!=='undefined')?performance.now():0;
    var nvals=this._sampleCount(rec);
    if(this._useWorker(nvals)){
      this.busy=(nvals>=1e6?(nvals/1e6).toFixed(1)+' M':(nvals/1e3).toFixed(0)+' k')+' samples (worker)';
      this._updMsg();
      this.paneNum.classList.add('pa-dimmed');
      this._runWorker(job,cfg,rec,function(res){
        if(job!==self._job)return;
        self.busy=null;
        if(res.fallback){self._workerBroken=true;self.evaluate();return;}
        if(res.error)self.error='Evaluation failed: '+res.error;
        else{
          self.ins=new PA.Instrument(cfg).attach(rec,res.history,{syncLost:res.syncLost});
          self.evalMs=((typeof performance!=='undefined')?performance.now():0)-t0;
          self.evalWorker=true;
          if(!self.ins.history.length)self.error='No complete measurement interval in the data. Run the simulation longer or lower the update rate.';
        }
        self._afterEval(acq);
      });
      return;
    }
    try{
      this.ins=new PA.Instrument(cfg);
      this.ins.run(rec);
      this.evalMs=((typeof performance!=='undefined')?performance.now():0)-t0;
      this.evalWorker=false;
      if(!this.ins.history.length)this.error='No complete measurement interval in the data. Run the simulation longer or lower the update rate.';
    }catch(e2){this.error='Evaluation failed: '+e2.message;if(root.console)console.error(e2);}
  }
  this._afterEval(acq);
};
UI.prototype._afterEval=function(acq){
  if(this.cfg.ui.plot==null)this._defaultPlotSel();
  this.cursors=this.cursors.filter(function(c){return acq&&acq.rec&&c>=acq.rec.t0;});
  if(this.mode==='window'&&this.cursors.length<2)this.mode='live';
  if(this.ins&&this.ins.history.length&&!this.hold)this.dispIdx=this.ins.history.length-1;
  else if(this.ins)this.dispIdx=Math.min(this.dispIdx,this.ins.history.length-1);
  this._updMsg();
  this.paneNum.classList.toggle('pa-dimmed',!!this.error);
  for(var k in this.modeBtns)this.modeBtns[k].classList.toggle('active',k===this.mode);
  this._renderTable();
  this._buildPlots();
  if(this.cfg.ui.tab==='vec')this._renderVector();
  if(this.cfg.ui.tab==='ch')this._renderChannels();
  this._refresh();
};
UI.prototype._sampleCount=function(rec){
  var c=0;
  for(var e=0;e<4;e++){if(rec.u[e])c++;if(rec.i[e])c++;}
  return c*rec.n;
};
UI.prototype._useWorker=function(nvals){
  return !!(this.opts.workerUrl&&typeof Worker!=='undefined'&&!this._workerBroken&&
    nvals>(this.opts.workerThreshold||1e6));
};
// One worker, one job at a time: a newer job terminates a still running one.
UI.prototype._runWorker=function(job,cfg,rec,cb){
  var self=this;
  if(this.worker&&this._workerBusy){this.worker.terminate();this.worker=null;}
  if(!this.worker){
    try{this.worker=new Worker(this.opts.workerUrl);}
    catch(e){cb({fallback:true});return;}
    this.worker.onerror=function(ev){
      if(ev&&ev.preventDefault)ev.preventDefault();
      self._workerBusy=false;
      if(self.worker){self.worker.terminate();self.worker=null;}
      if(self._workerCb)self._workerCb({fallback:true});
    };
    this.worker.onmessage=function(ev){
      var d=ev.data;
      if(d.id!==self._workerJob)return;
      self._workerBusy=false;
      if(self._workerCb)self._workerCb(d);
    };
  }
  this._workerJob=job;this._workerCb=cb;this._workerBusy=true;
  this.worker.postMessage({id:job,cfg:cfg,rec:rec});
};
UI.prototype._defaultPlotSel=function(){
  var sel={};
  for(var e=0;e<4;e++){
    var el=this.cfg.elements[e];
    if(!PA.elementUsed(this.cfg.wiring,e))continue;
    if(el.u)sel['w:u:'+(e+1)]=true;
    if(el.i)sel['w:i:'+(e+1)]=true;
  }
  this.cfg.ui.plot=sel;
};

// The result record the table / phasors show right now.
UI.prototype._current=function(){
  if(!this.ins||!this.ins.history.length)return {res:null,inst:null};
  var hst=this.ins.history;
  if(this.mode==='cursor'&&this.cursors.length){
    var t=this.cursors[0];
    return {res:this.ins.resultAt(t),inst:this.ins.sampleAt(t),t:t};
  }
  if(this.mode==='window'&&this.cursors.length>=2){
    var a=Math.min(this.cursors[0],this.cursors[1]),b=Math.max(this.cursors[0],this.cursors[1]);
    var last=hst[hst.length-1];
    var f=last.values['fSync:S'];
    return {res:this.ins.measureWindow(a,b,f),inst:null,t:b};
  }
  var r=hst[Math.max(0,Math.min(this.dispIdx,hst.length-1))];
  return {res:r,inst:null,t:r?r.t:null};
};

// ─── numeric table ───
// The Σ column also carries the sync frequency, the integration time, η
// and Σp(t), so it stays visible in 1P2W as well.
UI.prototype._sigmaShown=function(){return true;};
UI.prototype._renderTable=function(){
  if(!this.tableWrap)return;
  var self=this,cfg=this.cfg,w=cfg.wiring,G=PA.WIRINGS[w].group;
  var showS=this._sigmaShown();
  var cols=COLS.filter(function(c){return c.id!=='S'||showS;});
  var tbl=h('table',{class:'pa-table'});
  var hr=h('tr');
  hr.appendChild(h('th',{class:'pa-th-q',text:''}));
  this.colHeads={};
  cols.forEach(function(c){
    var head=h('th',{class:'pa-th-col'+(c.id==='S'?' pa-col-s':'')+(c.id==='4'?' pa-col-4':'')});
    var nm=c.id==='S'?'Σ':'CH'+c.id;
    head.appendChild(h('div',{class:'pa-th-name',text:nm}));
    var sub=h('div',{class:'pa-th-sub'});
    head.appendChild(sub);
    self.colHeads[c.id]=sub;
    hr.appendChild(head);
  });
  tbl.appendChild(h('thead',null,hr));
  var tb=h('tbody');
  this.valEls=[];this.chkEls=[];
  var plot=cfg.ui.plot||{};
  PA.GROUPS.forEach(function(g){
    if(g.id==='3'&&!G.length)return;
    if(g.id==='E'&&cfg.eta==='off')return;
    var qs=PA.QUANTITIES.filter(function(q){return q.group===g.id&&(q.level<=cfg.ui.level||g.id==='M');});
    if(!qs.length)return;
    var col=!!cfg.ui.collapsed[g.id];
    var gr=h('tr',{class:'pa-group'+(col?' collapsed':'')});
    gr.appendChild(h('td',{colspan:String(cols.length+1)},[
      h('span',{class:'pa-caret',text:col?'▸':'▾'}),' '+g.label
    ]));
    gr.addEventListener('click',function(){
      cfg.ui.collapsed[g.id]=!cfg.ui.collapsed[g.id];
      self._renderTable();self._refresh();self._emitConfig();
    });
    tb.appendChild(gr);
    if(col)return;
    qs.forEach(function(q){
      var tr=h('tr');
      var lab=h('th',{class:'pa-q',title:(q.unit?q.unit+' · ':'')+'click to plot / unplot the whole row'},[
        q.label,q.unit?h('span',{class:'pa-unit',text:' ['+q.unit+']'}):null
      ]);
      tr.appendChild(lab);
      var rowKeys=[];
      cols.forEach(function(c){
        var td=h('td',{class:'pa-cell'+(c.id==='S'?' pa-col-s':'')+(c.id==='4'?' pa-col-4':'')});
        var applies=self._applies(q,c);
        if(applies){
          var key=q.key+':'+c.id;
          var pk=(q.group==='M'?'w:':'t:')+key;
          if(q.key!=='rot'){
            var cb=h('input',{type:'checkbox',class:'pa-chk',title:'Plot '+q.label+' '+(c.id==='S'?'Σ':'CH'+c.id)});
            cb.checked=!!plot[pk];
            cb.addEventListener('change',function(){self._setPlot(pk,cb.checked);});
            td.appendChild(cb);
            self.chkEls.push({el:cb,pk:pk,td:td});
            rowKeys.push(pk);
            if(plot[pk])td.classList.add('pa-plotted');
          }
          var span=h('span',{class:'pa-val'});
          td.appendChild(span);
          self.valEls.push({el:span,td:td,key:key,q:q,col:c});
        }
        tr.appendChild(td);
      });
      lab.addEventListener('click',function(){
        if(!rowKeys.length)return;
        var p=self.cfg.ui.plot||{};
        var on=!rowKeys.every(function(k){return p[k];});
        rowKeys.forEach(function(k){p[k]=on;});
        self.cfg.ui.plot=p;
        self._afterPlotSel();
      });
      tb.appendChild(tr);
    });
  });
  tbl.appendChild(tb);
  this.tableWrap.textContent='';
  this.tableWrap.appendChild(tbl);
};
// Does quantity q have a value in column c (for this wiring)?
UI.prototype._applies=function(q,c){
  var w=this.cfg.wiring;
  if(c.id==='S'){
    if(q.cols==='S')return true;
    if(q.cols!=='ES')return false;
    if(q.group==='M')return q.key==='p';
    return PA.WIRINGS[w].group.length>0;
  }
  if(q.cols==='S')return false;
  if(!PA.elementUsed(w,c.e)){
    // 3P3W: element 3 shows the computed u12 / i3
    return q.key==='Urms'||q.key==='Irms';
  }
  return true;
};
UI.prototype._setPlot=function(pk,on){
  var p=this.cfg.ui.plot||{};
  p[pk]=on;this.cfg.ui.plot=p;
  this._afterPlotSel();
};
UI.prototype._afterPlotSel=function(){
  var p=this.cfg.ui.plot||{};
  this.chkEls.forEach(function(c){c.el.checked=!!p[c.pk];c.td.classList.toggle('pa-plotted',!!p[c.pk]);});
  this._buildPlots();
  this._refresh();
  this._emitConfig();
};

UI.prototype._refresh=function(){
  this._updateValues();
  this._updateStatus();
  this._redrawPlots();
  if(this.cfg.ui.tab==='vec')this._renderVector();
  if(this.cfg.ui.tab==='harm')this._renderHarm();
};

UI.prototype._updateValues=function(){
  if(!this.valEls)return;
  var cur=this._current(),res=cur.res,inst=cur.inst,cfg=this.cfg;
  var v=res?res.values:{},fl=res?res.flags:null;
  var three=cfg.wiring==='3P3W';
  for(var k=0;k<this.valEls.length;k++){
    var it=this.valEls[k],q=it.q,c=it.col,txt,cls='';
    if(q.group==='M'){
      txt=inst?PA.fmt(inst[it.key],q.unit):'···';
    }else{
      var val=v[it.key];
      if(three&&c.e===2){
        val=q.key==='Urms'?v['U12:S']:(q.key==='Irms'?v['IX:S']:val);
        cls='pa-dim';
      }
      if(three&&(c.e===0||c.e===1)&&(q.group==='P'||q.group==='F'))cls='pa-dim';
      txt=PA.fmt(val,q.unit);
      if(fl&&c.e>=0){
        var ou=fl.ovrU&&fl.ovrU[c.e],oi=fl.ovrI&&fl.ovrI[c.e];
        var g=q.group;
        if((g==='U'&&ou)||(g==='I'&&oi)||((g==='P'||g==='F')&&(ou||oi))){txt='-OL-';cls='pa-ovr';}
      }
    }
    if(it.el.textContent!==txt)it.el.textContent=txt;
    it.td.classList.toggle('pa-dim',cls==='pa-dim');
    it.td.classList.toggle('pa-ovr',cls==='pa-ovr');
  }
  // column headers: assigned sources and ranges
  for(var e=0;e<4;e++){
    var sub=this.colHeads&&this.colHeads[String(e+1)];
    if(!sub)continue;
    var el=cfg.elements[e],parts=[];
    if(!PA.elementUsed(cfg.wiring,e))parts.push('computed');
    else{
      parts.push(el.u?el.u.label:'U: none');
      parts.push(el.i?el.i.label:'I: none');
      var adc=this.ins&&this.ins.prep&&this.ins.prep.adc;
      var ru=adc?adc.u[e]:(fl&&fl.uRange[e]),ri=adc?adc.i[e]:(fl&&fl.iRange[e]);
      if(ru||ri)parts.push((adc?'ADC ':'')+(ru?fmtShort(ru,'V').replace(/\.0+ /,' '):'n/a')+' / '+(ri?fmtShort(ri,'A').replace(/\.0+ /,' '):'n/a'));
    }
    sub.textContent=parts.join(' · ');
    sub.title=PA.elementRole(cfg.wiring,e);
  }
  if(this.colHeads&&this.colHeads.S)this.colHeads.S.textContent=PA.WIRINGS[cfg.wiring].group.length?cfg.wiring+' · '+cfg.sq:'';
};

UI.prototype._updateStatus=function(){
  if(!this.status)return;
  var cfg=this.cfg,cur=this._current(),res=cur.res;
  var L=this.leds;
  var syncOk=res&&res.sync==='ok';
  L.SYNC.className='pa-led'+(cfg.sync.src==='none'?'':(syncOk||(res&&res.sync==='window')?' on-green':(res?' on-red':'')));
  L.SYNC.title=cfg.sync.src==='none'?'No synchronisation (fixed windows)':(syncOk?'Locked to '+cfg.sync.src:'No periods detected on '+cfg.sync.src);
  var ovr=false;
  if(res&&res.flags)for(var e=0;e<4;e++)if(res.flags.ovrU[e]||res.flags.ovrI[e])ovr=true;
  L.OVR.className='pa-led'+(ovr?' on-red':'');
  L.AVG.className='pa-led'+(cfg.avg.mode!=='off'?' on-amber':'');
  L.HOLD.className='pa-led'+(this.hold?' on-amber':'');
  this.btnHold.classList.toggle('active',this.hold);
  this.btnPlay.classList.toggle('active',!!this.playTimer);
  this.btnPlay.textContent=this.playTimer?'■ Stop':'▶ Replay';
  var parts=[],warn=[];
  if(this.ins&&this.ins.history.length&&res){
    var n=this.ins.history.length,idx=this.ins.history.indexOf(res);
    if(this.mode==='window')parts.push('Cursor window '+fmtShort(res.ta,'s')+' … '+fmtShort(res.tb,'s'));
    else parts.push('Update '+(idx+1)+'/'+n+' at t = '+PA.fmt(res.t,'s',4));
    parts.push('period '+fmtShort(res.tb-res.ta,'s')+(res.periods?' ('+res.periods+'× T, f = '+PA.fmt(res.values['fSync:S'],'Hz',5)+')':' (not synchronised)'));
    if(cfg.avg.mode!=='off'&&this.mode!=='window')parts.push(cfg.avg.mode.toUpperCase()+' '+(cfg.avg.mode==='exp'?'K='+cfg.avg.K:'m='+cfg.avg.m)+', n='+res.avgN);
    if(this.acq&&this.acq.fs)parts.push('fs = '+PA.fmt(this.acq.fs,'S/s',3));
    if(cfg.adc&&cfg.adc.enabled)parts.push('ADC '+cfg.adc.bits+' bit'+(+cfg.adc.bw>0?', BW '+fmtShort(+cfg.adc.bw,'Hz'):'')+(+cfg.adc.noise>0?', noise '+cfg.adc.noise+' LSB':''));
    if(this.evalMs!=null)parts.push(Math.round(this.evalMs)+' ms'+(this.evalWorker?' (worker)':''));
    if(this.ins.syncLost)warn.push('No periods found on '+cfg.sync.src+': fixed windows used');
    var f=res.values['fSync:S'];
    if(this.acq&&this.acq.maxStep&&f>0&&this.acq.maxStep>1/(50*f))
      warn.push('Coarse simulator steps (max '+fmtShort(this.acq.maxStep,'s')+' vs. period '+fmtShort(1/f,'s')+'): set a Max step in the analysis settings');
  }
  if(this.acq&&this.acq.warnings)warn=warn.concat(this.acq.warnings);
  this.status.textContent='';
  this.status.appendChild(h('span',{text:parts.join(' · ')}));
  if(warn.length)this.status.appendChild(h('span',{class:'pa-warn',text:'⚠ '+warn.join(' · ')}));
};
UI.prototype._flash=function(text){
  if(!this.status)return;
  var s=h('span',{class:'pa-warn',text:text});
  this.status.appendChild(s);
  setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s);},3500);
};

// ─── playback / hold ───
UI.prototype._togglePlay=function(){
  if(this.playTimer){this._stopPlay();this._refresh();return;}
  if(!this.ins||this.ins.history.length<2)return;
  var self=this,n=this.ins.history.length;
  this.hold=false;
  if(this.mode!=='live')this._setMode('live');
  this.dispIdx=0;
  var step=Math.max(40,Math.min(300,6000/n));
  this.playTimer=setInterval(function(){
    if(self.hold)return;
    if(self.dispIdx>=self.ins.history.length-1){self._stopPlay();self._refresh();return;}
    self.dispIdx++;
    self._refresh();
  },step);
  this._refresh();
};
UI.prototype._stopPlay=function(){
  if(this.playTimer){clearInterval(this.playTimer);this.playTimer=null;}
};
UI.prototype._toggleHold=function(){
  this.hold=!this.hold;
  if(!this.hold&&!this.playTimer&&this.ins)this.dispIdx=this.ins.history.length-1;
  this._refresh();
};
UI.prototype._single=function(){
  if(!this.ins)return;
  if(!this.hold){this.hold=true;this._stopPlay();}
  else this.dispIdx=Math.min(this.ins.history.length-1,this.dispIdx+1);
  if(this.mode!=='live')this._setMode('live');
  this._refresh();
};

// ─── plots ───
UI.prototype._color=function(key){
  if(!this.colors[key]){
    var used={};for(var k in this.colors)used[this.colors[k]]=true;
    var c=PALETTE.find(function(p){return !used[p];})||PALETTE[Object.keys(this.colors).length%PALETTE.length];
    this.colors[key]=c;
  }
  return this.colors[key];
};
UI.prototype._waveData=function(){
  if(this.wave)return this.wave;
  var p=this.ins&&this.ins.prep;
  if(!p)return null;
  var n=p.n,MAX=60000,b=Math.max(1,Math.ceil(n/(MAX/2)));
  var full={};
  function raw(key){
    if(full[key])return full[key];
    var m=/^([uip]):([1-4S])$/.exec(key);
    if(!m)return null;
    var out=null,e=m[2]==='S'?-1:(+m[2]-1);
    if(m[1]==='u')out=p.u[e];
    else if(m[1]==='i')out=p.i[e];
    else if(e>=0){
      if(p.u[e]&&p.i[e]){out=new Float64Array(n);for(var k=0;k<n;k++)out[k]=p.u[e][k]*p.i[e][k];}
    }else{
      out=new Float64Array(n);var any=false;
      for(var e2=0;e2<3;e2++)if(p.u[e2]&&p.i[e2]){any=true;for(var k2=0;k2<n;k2++)out[k2]+=p.u[e2][k2]*p.i[e2][k2];}
      if(!any)out=null;
    }
    full[key]=out;return out;
  }
  var x,dec;
  if(b===1){
    x=new Float64Array(n);for(var i=0;i<n;i++)x[i]=p.t0+i*p.dt;
    dec=function(a){return a;};
  }else{
    // min/max per bucket keeps PWM edges and peaks visible
    var nb=Math.ceil(n/b);
    x=new Float64Array(nb*2);
    for(var j=0;j<nb;j++){x[2*j]=p.t0+j*b*p.dt;x[2*j+1]=p.t0+(j*b+b/2)*p.dt;}
    dec=function(a){
      var o=new Float64Array(nb*2);
      for(var j2=0;j2<nb;j2++){
        var lo=j2*b,hi=Math.min(n,lo+b),mn=Infinity,mx=-Infinity,imn=lo,imx=lo;
        for(var q=lo;q<hi;q++){var v=a[q];if(v<mn){mn=v;imn=q;}if(v>mx){mx=v;imx=q;}}
        if(imn<=imx){o[2*j2]=mn;o[2*j2+1]=mx;}else{o[2*j2]=mx;o[2*j2+1]=mn;}
      }
      return o;
    };
  }
  this.wave={x:x,get:function(key){var r=raw(key);return r?dec(r):null;}};
  return this.wave;
};
UI.prototype._seriesFor=function(prefix){
  var sel=this.cfg.ui.plot||{},out=[];
  var keys=Object.keys(sel).filter(function(k){return sel[k]&&k.indexOf(prefix)===0;});
  keys.sort();
  for(var i=0;i<keys.length;i++){
    var parts=keys[i].split(':');   // w:u:1 | t:Urms:S
    var q=PA.quantity(parts[1]);
    if(!q)continue;
    var col=parts[2];
    out.push({pk:keys[i],key:parts[1]+':'+col,q:q,label:q.label.replace(/\(t\)$/,'')+(col==='S'?' Σ':' '+col),unit:q.unit});
  }
  return out;
};
UI.prototype._destroyPlots=function(){
  if(this.pWave){this.pWave.destroy();this.pWave=null;}
  if(this.pTrend){this.pTrend.destroy();this.pTrend=null;}
};
UI.prototype._buildPlots=function(){
  this._destroyPlots();
  this.waveDiv.textContent='';this.trendDiv.textContent='';
  if(!this.uPlot){this.waveDiv.textContent='Plot library (uPlot) not loaded.';return;}
  if(!this.ins||!this.ins.history.length){this.waveDiv.style.display='';this.trendDiv.style.display='none';return;}
  var self=this;
  var ws=this._seriesFor('w:'),ts=this._seriesFor('t:');
  this.waveDiv.style.display=ws.length||!ts.length?'':'none';
  this.trendDiv.style.display=ts.length?'':'none';
  this.plotsWrap.classList.toggle('pa-two',!!(ws.length&&ts.length));
  var wd=this._waveData();
  var tEnd=wd.x[wd.x.length-1],tBeg=wd.x[0];
  if(ws.length||!ts.length){
    var data=[wd.x],defs=[];
    ws.forEach(function(s){var a=wd.get(s.key);if(a){data.push(a);defs.push(s);}});
    if(!defs.length){
      this.waveDiv.appendChild(h('div',{class:'pa-plot-empty',text:'Tick a value in the table to plot it (waveform rows: u, i, p).'}));
    }else this.pWave=this._makePlot(this.waveDiv,data,defs,false,[tBeg,tEnd]);
  }
  if(ts.length){
    var hst=this.ins.history,tx=new Float64Array(hst.length);
    for(var i=0;i<hst.length;i++)tx[i]=hst[i].t;
    var tdata=[tx],tdefs=[];
    var three=this.cfg.wiring==='3P3W';
    ts.forEach(function(s){
      var arr=hst.map(function(r){
        var v=r.values[s.key];
        if(three&&s.key==='Urms:3')v=r.values['U12:S'];
        if(three&&s.key==='Irms:3')v=r.values['IX:S'];
        return (typeof v==='number'&&isFinite(v))?v:null;
      });
      tdata.push(arr);tdefs.push(s);
    });
    this.pTrend=this._makePlot(this.trendDiv,tdata,tdefs,true,[tBeg,tEnd]);
  }
  this._resizePlots();
  // the legends only get their final height after layout: fit once more
  if(typeof requestAnimationFrame!=='undefined')requestAnimationFrame(function(){self._resizePlots();});
};
UI.prototype._makePlot=function(div,data,defs,stepped,xr){
  var self=this,U=this.uPlot;
  var units=[];
  defs.forEach(function(d){var u=unitScale(d.unit);if(units.indexOf(u)<0)units.push(u);});
  var scales={x:{time:false,range:function(u,mn,mx){return [mn,mx];}}};
  units.forEach(function(u){scales[u]={auto:true};});
  var series=[{label:'t',value:function(u,v){return v==null?'':PA.fmt(v,'s',5);}}];
  defs.forEach(function(d){
    var s={label:d.label,stroke:self._color(d.pk),width:1.5,scale:unitScale(d.unit),
      value:function(u,v){return v==null?'···':PA.fmt(v,d.unit);}};
    if(stepped&&U.paths&&U.paths.stepped)s.paths=U.paths.stepped({align:1});
    if(stepped)s.points={show:false};
    series.push(s);
  });
  var axisCol='#a9bccd',grid='#1c2730';
  var axes=[{stroke:axisCol,grid:{stroke:grid},ticks:{stroke:grid},
    values:function(u,t){return t.map(function(v){return fmtShort(v,'s');});}}];
  units.slice(0,2).forEach(function(un,k){
    axes.push({scale:un,side:k?1:3,stroke:axisCol,grid:{show:k===0,stroke:grid},ticks:{stroke:grid},size:62,
      values:function(u,t){return t.map(function(v){return fmtShort(v,un==='1'?'':un).replace(/\.0+(?=\s|$)/,'');});}});
  });
  var opts={
    width:Math.max(200,div.clientWidth||600),height:Math.max(80,div.clientHeight||200),
    series:series,scales:scales,axes:axes,
    cursor:{sync:{key:this.syncKey,setSeries:false},drag:{x:true,y:false,uni:8}},
    legend:{live:true},
    hooks:{
      draw:[function(u){self._drawOverlay(u,stepped);}],
      setScale:[function(u,key){
        if(key!=='x'||self._xSyncing)return;
        var other=(u===self.pWave)?self.pTrend:self.pWave;
        if(!other)return;
        self._xSyncing=true;
        other.setScale('x',{min:u.scales.x.min,max:u.scales.x.max});
        self._xSyncing=false;
      }],
      ready:[function(u){self._bindPlotClicks(u,xr);}]
    }
  };
  var p=new U(opts,data,div);
  p.setScale('x',{min:xr[0],max:xr[1]});
  return p;
};
UI.prototype._bindPlotClicks=function(u,xr){
  var self=this,dx=null,dy=null;
  u.over.addEventListener('mousedown',function(e){dx=e.clientX;dy=e.clientY;});
  u.over.addEventListener('mouseup',function(e){
    if(dx==null)return;
    var moved=Math.abs(e.clientX-dx)>4||Math.abs(e.clientY-dy)>4;
    dx=null;
    if(moved)return;
    var r=u.over.getBoundingClientRect();
    var t=u.posToVal(e.clientX-r.left,'x');
    if(!isFinite(t))return;
    self.cursors.push(t);
    if(self.cursors.length>2)self.cursors.shift();
    if(self.mode==='live')self._setMode('cursor');
    else self._refresh();
  });
  u.over.addEventListener('dblclick',function(){
    self.cursors=[];
    [self.pWave,self.pTrend].forEach(function(p){if(p)p.setScale('x',{min:xr[0],max:xr[1]});});
    self._setMode('live');
  });
};
// Interval bands, the current display moment and the cursors.
UI.prototype._drawOverlay=function(u,isTrend){
  var ctx=u.ctx,bb=u.bbox,dpr=bb.width/(u.over.clientWidth||bb.width)||1;
  var x0=u.scales.x.min,x1=u.scales.x.max;
  ctx.save();
  ctx.beginPath();ctx.rect(bb.left,bb.top,bb.width,bb.height);ctx.clip();
  var cur=this._current();
  if(!isTrend&&this.ins){
    var hst=this.ins.history,vis=[];
    for(var i=0;i<hst.length;i++)if(hst[i].tb>=x0&&hst[i].ta<=x1)vis.push(hst[i]);
    if(vis.length&&vis.length<=400){
      for(var k=0;k<vis.length;k++){
        var a=u.valToPos(vis[k].ta,'x',true),b=u.valToPos(vis[k].tb,'x',true);
        ctx.fillStyle=(vis[k]===cur.res)?'rgba(0,200,255,0.10)':(hst.indexOf(vis[k])%2?'rgba(255,255,255,0.025)':'rgba(255,255,255,0.0)');
        ctx.fillRect(a,bb.top,b-a,bb.height);
      }
    }else if(cur.res&&cur.res.tb>=x0){
      var a2=u.valToPos(cur.res.ta,'x',true),b2=u.valToPos(cur.res.tb,'x',true);
      ctx.fillStyle='rgba(0,200,255,0.10)';ctx.fillRect(a2,bb.top,b2-a2,bb.height);
    }
  }
  if(this.mode==='window'&&this.cursors.length>=2){
    var w1=u.valToPos(Math.min(this.cursors[0],this.cursors[1]),'x',true),w2=u.valToPos(Math.max(this.cursors[0],this.cursors[1]),'x',true);
    ctx.fillStyle='rgba(255,208,64,0.08)';ctx.fillRect(w1,bb.top,w2-w1,bb.height);
  }
  if(this.mode==='live'&&cur.res){
    var xm=u.valToPos(cur.res.t,'x',true);
    ctx.strokeStyle='rgba(0,200,255,0.7)';ctx.lineWidth=1*dpr;ctx.setLineDash([3*dpr,3*dpr]);
    ctx.beginPath();ctx.moveTo(xm,bb.top);ctx.lineTo(xm,bb.top+bb.height);ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.font=(10*dpr)+'px "Share Tech Mono", monospace';
  for(var c=0;c<this.cursors.length;c++){
    var xc=u.valToPos(this.cursors[c],'x',true);
    ctx.strokeStyle='#ffd040';ctx.lineWidth=1*dpr;
    ctx.beginPath();ctx.moveTo(xc,bb.top);ctx.lineTo(xc,bb.top+bb.height);ctx.stroke();
    ctx.fillStyle='#ffd040';ctx.fillText(String(c+1),xc+3*dpr,bb.top+11*dpr);
  }
  ctx.restore();
};
UI.prototype._redrawPlots=function(){
  if(this.pWave)this.pWave.redraw(false,false);
  if(this.pTrend)this.pTrend.redraw(false,false);
};
UI.prototype._resizePlots=function(){
  [[this.pWave,this.waveDiv],[this.pTrend,this.trendDiv]].forEach(function(pd){
    var p=pd[0],d=pd[1];
    if(!p||!d.clientWidth)return;
    var legend=p.root.querySelector('.u-legend');
    var lh=legend?Math.min(44,legend.offsetHeight):0;   // CSS caps the legend at 44 px
    var wdt=Math.max(200,d.clientWidth),hgt=Math.max(80,d.clientHeight-lh-4);
    if(Math.abs(p.width-wdt)>1||Math.abs(p.height-hgt)>1)p.setSize({width:wdt,height:hgt});
  });
};

// ─── phasor diagram ───
UI.prototype._renderVector=function(){
  var pane=this.paneVec,cfg=this.cfg,self=this;
  pane.textContent='';
  if(!PA.WIRINGS[cfg.wiring].group.length){
    pane.appendChild(h('div',{class:'pa-empty',text:'The phasor diagram needs a three-phase wiring (3P4W, 3P3W or 3V3A). Change it in the control bar.'}));
    return;
  }
  var res=this._current().res;
  var ph=res?PA.phasors(res.prim,cfg.wiring):null;
  if(!ph||!ph.U[0]){
    pane.appendChild(h('div',{class:'pa-empty',text:'No fundamental phasors yet: assign all three phases and make sure the sync source locks (SYNC lamp green).'}));
    return;
  }
  var C=PA.complex;
  var rot=-C.arg(ph.U[0]);
  function rotd(z){if(!z)return null;var a=C.arg(z)+rot;var m=C.abs(z);return {re:m*Math.cos(a),im:m*Math.sin(a),mag:m,deg:a*180/Math.PI};}
  var U=ph.U.map(rotd),I=ph.I.map(rotd),L=ph.L.map(rotd);
  var Umax=0,Imax=0;
  U.concat(cfg.ui.showLL?L:[]).forEach(function(z){if(z&&z.mag>Umax)Umax=z.mag;});
  I.forEach(function(z){if(z&&z.mag>Imax)Imax=z.mag;});
  function nice(v){if(!(v>0))return 1;var p=Math.pow(10,Math.floor(Math.log10(v)));var m=v/p;return (m<=1?1:m<=2?2:m<=5?5:10)*p;}
  var Ufs=nice(Umax),Ifs=nice(Imax);
  var S=380,cx=S/2,cy=S/2,R=S/2-34;
  var svg=sv('svg',{viewBox:'0 0 '+S+' '+S,class:'pa-vec-svg'});
  for(var r=1;r<=4;r++){
    svg.appendChild(sv('circle',{cx:cx,cy:cy,r:R*r/4,fill:'none',stroke:'#1f2a33','stroke-width':r===4?1.2:0.8}));
  }
  for(var a=0;a<360;a+=30){
    var ar=a*Math.PI/180;
    svg.appendChild(sv('line',{x1:cx,y1:cy,x2:cx+R*Math.cos(ar),y2:cy-R*Math.sin(ar),stroke:'#18222a','stroke-width':a%90?0.6:1}));
    if(a%90===0){
      var tx=sv('text',{x:cx+(R+16)*Math.cos(ar),y:cy-(R+16)*Math.sin(ar)+4,'text-anchor':'middle',class:'pa-vec-lbl'});
      tx.textContent=(a>180?a-360:a)+'°';svg.appendChild(tx);
    }
  }
  var lu=sv('text',{x:cx+4,y:cy-R-4,class:'pa-vec-scale'});lu.textContent='U '+fmtShort(Ufs,'V');svg.appendChild(lu);
  var li=sv('text',{x:cx+4,y:cy-R*0.75-4,class:'pa-vec-scale pa-vec-scale-i'});li.textContent='I '+fmtShort(Ifs,'A')+' (┄)';svg.appendChild(li);
  var defs=sv('defs');
  PHASE_COL.forEach(function(col,k){
    var m=sv('marker',{id:'pa-ah'+k,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});
    m.appendChild(sv('path',{d:'M0,0 L10,5 L0,10 z',fill:col}));
    defs.appendChild(m);
  });
  var mLL=sv('marker',{id:'pa-ahll',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});
  mLL.appendChild(sv('path',{d:'M0,0 L10,5 L0,10 z',fill:'#5f7488'}));defs.appendChild(mLL);
  svg.appendChild(defs);
  function tip(z,fs,rr){return {x:cx+rr*z.re/fs,y:cy-rr*z.im/fs};}
  if(cfg.ui.showLL){
    // line voltages as the triangle between the phase-voltage tips: u12 = u1N − u2N
    var pairs=[[0,1],[1,2],[2,0]];
    pairs.forEach(function(pq){
      if(!U[pq[0]]||!U[pq[1]])return;
      var A=tip(U[pq[1]],Ufs,R),B=tip(U[pq[0]],Ufs,R);
      svg.appendChild(sv('line',{x1:A.x,y1:A.y,x2:B.x,y2:B.y,stroke:'#5f7488','stroke-width':1.2,'marker-end':'url(#pa-ahll)'}));
    });
  }
  for(var k=0;k<3;k++){
    if(U[k]){
      var t=tip(U[k],Ufs,R);
      svg.appendChild(sv('line',{x1:cx,y1:cy,x2:t.x,y2:t.y,stroke:PHASE_COL[k],'stroke-width':2.6,'marker-end':'url(#pa-ah'+k+')'}));
      var tl=sv('text',{x:t.x+(t.x>=cx?6:-6),y:t.y+(t.y>=cy?12:-5),'text-anchor':t.x>=cx?'start':'end',class:'pa-vec-name',fill:PHASE_COL[k]});
      tl.textContent='U'+(k+1)+(cfg.wiring==='3P4W'?'':'*');svg.appendChild(tl);
    }
    if(I[k]){
      var ti=tip(I[k],Ifs,R*0.75);
      svg.appendChild(sv('line',{x1:cx,y1:cy,x2:ti.x,y2:ti.y,stroke:PHASE_COL[k],'stroke-width':1.6,'stroke-dasharray':'5 3','marker-end':'url(#pa-ah'+k+')'}));
      var il=sv('text',{x:ti.x+(ti.x>=cx?5:-5),y:ti.y+(ti.y>=cy?11:-4),'text-anchor':ti.x>=cx?'start':'end',class:'pa-vec-name pa-vec-name-i',fill:PHASE_COL[k]});
      il.textContent='I'+(k+1);svg.appendChild(il);
    }
  }
  svg.appendChild(sv('circle',{cx:cx,cy:cy,r:2.5,fill:'#a9bccd'}));
  var left=h('div',{class:'pa-vec-left'},[svg,
    h('label',{class:'pa-vec-opt'},[(function(){
      var cb=h('input',{type:'checkbox'});cb.checked=!!cfg.ui.showLL;
      cb.addEventListener('change',function(){cfg.ui.showLL=cb.checked;self._emitConfig();self._renderVector();});
      return cb;
    })(),' line voltages U12, U23, U31'])
  ]);
  var v=res.values;
  var rows=[];
  function row(name,mag,unit,deg,col){rows.push(h('tr',null,[
    h('th',{style:col?'color:'+col:null,text:name}),h('td',{text:PA.fmt(mag,unit)}),h('td',{text:deg==null?'':PA.fmt(deg,'°')})]));}
  for(k=0;k<3;k++)if(U[k])row('U'+(k+1)+'N'+(cfg.wiring==='3P4W'?'':' *'),U[k].mag,'V',U[k].deg,PHASE_COL[k]);
  for(k=0;k<3;k++)if(L[k])row(['U12','U23','U31'][k],L[k].mag,'V',L[k].deg,null);
  for(k=0;k<3;k++)if(I[k])row('I'+(k+1)+(cfg.wiring==='3P3W'&&k===2?' (calc.)':''),I[k].mag,'A',I[k].deg,PHASE_COL[k]);
  for(k=0;k<3;k++)if(U[k]&&I[k]){
    var d=U[k].deg-I[k].deg;d=((d+180)%360+360)%360-180;
    rows.push(h('tr',null,[h('th',{text:'φ'+(k+1)+' (U'+(k+1)+'N ∠ I'+(k+1)+')'}),h('td',{text:PA.fmt(d,'°')}),h('td',{text:d>0.05?'lag (ind.)':(d<-0.05?'lead (cap.)':'')})]));
  }
  var extra=[['U+ positive seq.','Upos:S','V'],['U− negative seq.','Uneg:S','V'],['U0 zero seq.','U0:S','V'],
    ['Unbalance U','uU2:S','%'],['Unbalance I','uI2:S','%'],['Phase sequence','rot:S','']];
  extra.forEach(function(x){rows.push(h('tr',null,[h('th',{text:x[0]}),h('td',{colspan:'2',text:PA.fmt(v[x[1]],x[2])})]));});
  var tbl=h('table',{class:'pa-vec-table'},[h('thead',null,h('tr',null,[h('th',{text:'Fundamental'}),h('th',{text:'rms'}),h('th',{text:'angle'})])),h('tbody',null,rows)]);
  var note=h('div',{class:'pa-note',text:'Reference: U1N at 0°, counter-clockwise positive. '+
    (cfg.wiring==='3P4W'?'':'* phase voltages of a virtual star point, computed from the line voltages. ')+
    'Follows the table mode (display / cursor / cursor window).'});
  pane.appendChild(left);
  pane.appendChild(h('div',{class:'pa-vec-right'},[tbl,note]));
};

// ─── channel assignment ───
UI.prototype._renderChannels=function(){
  var self=this,cfg=this.cfg,pane=this.paneCh,src=this.source||{};
  pane.textContent='';
  var canPick=typeof src.beginPick==='function';
  var sigU=src.listSignals?src.listSignals('U'):[],sigI=src.listSignals?src.listSignals('I'):[];
  var tbl=h('table',{class:'pa-ch-table'});
  tbl.appendChild(h('thead',null,h('tr',null,['Element','Role ('+cfg.wiring+')','Voltage','Current','I sign','U range','I range','U factor','I factor'].map(function(t){return h('th',{text:t});}))));
  var tb=h('tbody');
  function sigSelect(list,cur,onch){
    var s=h('select',{class:'pa-select pa-sig'});
    s.appendChild(h('option',{value:'',text:'(none)'}));
    var groups={},found=false;
    list.forEach(function(x){
      var g=x.group||'Signals';
      if(!groups[g]){groups[g]=h('optgroup',{label:g});s.appendChild(groups[g]);}
      var o=h('option',{value:x.id,text:x.label});
      if(cur&&cur.id===x.id){o.selected=true;found=true;}
      groups[g].appendChild(o);
    });
    if(cur&&!found){
      var missing=typeof src.hasSignal==='function'&&!src.hasSignal(cur.id);
      var o2=h('option',{value:cur.id,text:cur.label+(missing?' (not in last run)':'')});o2.selected=true;s.appendChild(o2);
    }
    s.addEventListener('change',function(){
      var id=s.value,lab=s.options[s.selectedIndex]?s.options[s.selectedIndex].text:'';
      onch(id?{id:id,label:lab.replace(/ \(not in last run\)$/,'')}:null);
    });
    return s;
  }
  function rangeSel(list,cur,unit,onch){
    var opts=[['auto','Auto']].concat(list.filter(function(r){return r>=(unit==='V'?0.1:0.01);}).map(function(r){return [String(r),fmtShort(r,unit).replace(/\.0+ /,' ')];}));
    return select(opts,String(cur),function(v){onch(v==='auto'?'auto':+v);});
  }
  for(var e=0;e<4;e++)(function(e){
    var el=cfg.elements[e],used=PA.elementUsed(cfg.wiring,e);
    var tr=h('tr',{class:used?'':'pa-unused'});
    tr.appendChild(h('th',{text:'CH'+(e+1)}));
    tr.appendChild(h('td',{class:'pa-role',text:PA.elementRole(cfg.wiring,e)}));
    if(!used){tr.appendChild(h('td',{colspan:'7',class:'pa-role',text:'computed from CH1 and CH2 (Kirchhoff)'}));tb.appendChild(tr);return;}
    var uCell=h('td',{class:'pa-sigcell'},[sigSelect(sigU,el.u,function(v){el.u=v;self._chChanged();})]);
    if(canPick)uCell.appendChild(h('button',{class:'pa-pick',title:'Pick the voltage on the schematic (click a net, or drag from net A to net B for V(A)-V(B))',
      text:'⌖',onclick:function(){self._startAssign(e,'U');}}));
    var iCell=h('td',{class:'pa-sigcell'},[sigSelect(sigI,el.i,function(v){el.i=v;self._chChanged();})]);
    if(canPick)iCell.appendChild(h('button',{class:'pa-pick',title:'Pick the current on the schematic (click a device pin)',
      text:'⌖',onclick:function(){self._startAssign(e,'I');}}));
    tr.appendChild(uCell);tr.appendChild(iCell);
    var inv=h('input',{type:'checkbox',title:'Invert the current direction (load reference arrow)'});
    inv.checked=!!el.iInvert;
    inv.addEventListener('change',function(){el.iInvert=inv.checked;self._chChanged();});
    tr.appendChild(h('td',{class:'pa-center'},[h('label',{class:'pa-inv'},[inv,' invert'])]));
    tr.appendChild(h('td',null,rangeSel(PA.U_RANGES,el.uRange,'V',function(v){el.uRange=v;self._chChanged();})));
    tr.appendChild(h('td',null,rangeSel(PA.I_RANGES,el.iRange,'A',function(v){el.iRange=v;self._chChanged();})));
    function factor(key){
      var inp=h('input',{class:'pa-input pa-input-s',value:String(el[key]),title:'Scaling (transformer / sensor ratio)'});
      inp.addEventListener('change',function(){var f=parseSI(inp.value);if(isFinite(f)&&f!==0){el[key]=f;self._chChanged();}else inp.value=String(el[key]);});
      return inp;
    }
    tr.appendChild(h('td',null,factor('uScale')));
    tr.appendChild(h('td',null,factor('iScale')));
    tb.appendChild(tr);
  })(e);
  tbl.appendChild(tb);
  pane.appendChild(tbl);
  var btns=h('div',{class:'pa-ch-btns'});
  if(canPick)btns.appendChild(h('button',{class:'pa-btn',text:'⌖ Assign all by probing',
    title:'Walk through U1, I1, U2, I2 … and pick each on the schematic',onclick:function(){self._startAssign(0,'U');}}));
  if(typeof src.suggestChannels==='function')btns.appendChild(h('button',{class:'pa-btn',text:'Take from plot probes',
    title:'Fill the channels from the probes of the simulation plot (voltage probes in order to U1…, current probes to I1…)',
    onclick:function(){
      var sug=src.suggestChannels()||[];
      for(var k=0;k<4;k++){
        var s=sug[k]||{};
        cfg.elements[k].u=s.u||null;cfg.elements[k].i=s.i||null;
      }
      self._chChanged();
    }}));
  btns.appendChild(h('button',{class:'pa-btn',text:'Clear all',onclick:function(){
    for(var k=0;k<4;k++){cfg.elements[k].u=null;cfg.elements[k].i=null;}
    self._chChanged();
  }}));
  pane.appendChild(btns);
  pane.appendChild(h('div',{class:'pa-note',text:
    'Voltage: a node voltage V(net) or a differential voltage V(a)-V(b). Current: a device current; its sign follows the probe '+
    '(current into the probed pin). For the Σ functions the load reference arrow must point into the load: '+
    'if P comes out negative on a load, tick "invert". 3P3W (Aron): CH1 = u13 / i1, CH2 = u23 / i2. '+
    '3V3A additionally CH3 = u12 / i3. 3P4W: phase voltages against N.'}));
};
UI.prototype._chChanged=function(){
  this.cfg.ui.plot=null;   // re-derive the default plot selection
  this._renderChannels();
  this._configChanged(true);
};

// Assignment by probing: the dialog collapses to a bar, the schematic is usable.
UI.prototype._targets=function(){
  var out=[];
  for(var e=0;e<4;e++)if(PA.elementUsed(this.cfg.wiring,e)){out.push([e,'U']);out.push([e,'I']);}
  return out;
};
UI.prototype._startAssign=function(e,kind){
  var self=this,src=this.source;
  if(!src||typeof src.beginPick!=='function')return;
  this.assign={e:e,kind:kind};
  this.root.classList.add('pa-assigning');
  this._renderAssignBar();
  src.beginPick(kind,function(sig){self._onPick(sig);});
};
UI.prototype._onPick=function(sig){
  if(!this.assign||!sig)return;
  var a=this.assign,el=this.cfg.elements[a.e];
  el[a.kind==='U'?'u':'i']={id:sig.id,label:sig.label};
  this.cfg.ui.plot=null;
  this._emitConfig();
  this._advanceAssign();
};
UI.prototype._advanceAssign=function(){
  var t=this._targets(),a=this.assign,idx=-1;
  for(var k=0;k<t.length;k++)if(t[k][0]===a.e&&t[k][1]===a.kind)idx=k;
  if(idx<0||idx+1>=t.length){this._endAssign();return;}
  this._startAssign(t[idx+1][0],t[idx+1][1]);
};
UI.prototype._renderAssignBar=function(){
  var self=this,a=this.assign,bar=this.assignBar;
  bar.textContent='';
  if(!a)return;
  var what=a.kind==='U'
    ?'voltage: click a net, or drag from net A to net B for V(A)-V(B)'
    :'current: click a device pin';
  var chips=h('span',{class:'pa-assign-chips'});
  this._targets().forEach(function(t){
    var el=self.cfg.elements[t[0]],sig=el[t[1]==='U'?'u':'i'];
    var active=t[0]===a.e&&t[1]===a.kind;
    chips.appendChild(h('span',{class:'pa-chip'+(active?' active':'')+(sig?' set':''),
      title:sig?sig.label:'not assigned',text:t[1]+(t[0]+1)+(sig?' ✓':'')}));
  });
  bar.appendChild(h('span',{class:'pa-brand',text:'PA-4'}));
  bar.appendChild(h('span',{class:'pa-assign-what'},[h('b',{text:'CH'+(a.e+1)+' '}),what]));
  bar.appendChild(chips);
  bar.appendChild(h('button',{class:'pa-btn',text:'Skip',onclick:function(){self._advanceAssign();}}));
  bar.appendChild(h('button',{class:'pa-btn pa-btn-primary',text:'Done',onclick:function(){self._endAssign();}}));
};
UI.prototype._endAssign=function(silent){
  if(!this.assign)return;
  this.assign=null;
  if(this.source&&typeof this.source.endPick==='function')this.source.endPick();
  this.root.classList.remove('pa-assigning');
  this.assignBar.textContent='';
  if(!silent){
    this._showTab('ch');
    this.evaluate();
  }
};

// ─── setup tab ───
// Everything that a real instrument keeps in its setup menus rather than on
// the front panel: sync details, averaging variant, power formulas,
// harmonics, integration and the simulated input stage.
UI.prototype._renderSetup=function(){
  var self=this,c=this.cfg,pane=this.paneSetup;
  pane.textContent='';
  function changed(re){self._configChanged(true);if(re)self._renderSetup();}
  function row(label,ctl,hint){
    return h('div',{class:'pa-set-row'},[h('label',{class:'pa-set-lbl',text:label}),h('div',{class:'pa-set-ctl'},ctl),
      hint?h('div',{class:'pa-set-hint',text:hint}):null]);
  }
  function section(title,rows){
    var sec=h('div',{class:'pa-set-sec'},[h('div',{class:'pa-set-title',text:title})]);
    rows.forEach(function(r){sec.appendChild(r);});
    return sec;
  }
  function check(val,onch,label){
    var cb=h('input',{type:'checkbox'});cb.checked=!!val;
    cb.addEventListener('change',function(){onch(cb.checked);});
    return h('label',{class:'pa-set-check'},[cb,' '+(label||'')]);
  }
  function num(val,onch,ph,title){
    var inp=h('input',{class:'pa-input',value:val==null?'':String(val),placeholder:ph||'',title:title||null});
    inp.addEventListener('change',function(){onch(inp.value.trim());});
    return inp;
  }
  var cols=h('div',{class:'pa-set-cols'});
  cols.appendChild(section('Synchronisation',[
    row('Coupling',select([['ac','AC: remove the mean'],['dc','DC: true zero crossings']],c.sync.coupling,
      function(v){c.sync.coupling=v;changed();}),
      'DC is what the instruments do; AC also locks onto signals with an offset.'),
    row('Hysteresis',select([['0.01','1 %'],['0.02','2 %'],['0.05','5 %'],['0.1','10 %'],['0.2','20 %']],String(c.sync.hyst),
      function(v){c.sync.hyst=+v;changed();}),
      'Of the signal amplitude. Larger values ignore ripple and switching noise around the crossing.'),
    row('Zero-cross filter',[check(c.sync.filter,function(v){c.sync.filter=v;changed(true);},'low-pass the sync signal'),
      c.sync.filter?h('span',{class:'pa-inline'},[num(c.sync.filterHz,function(v){var f=parseSI(v);if(f>0){c.sync.filterHz=f;changed();}},'1k','Cut-off frequency'),h('span',{class:'pa-unit',text:' Hz'})]):null],
      'Needed for PWM voltages: the sync then follows the fundamental instead of every edge.')
  ]));
  cols.appendChild(section('Averaging and power',[
    row('RMS averaging',select([['lin','Linear (like the instruments)'],['quad','Quadratic (exact)']],c.avg.rmsQuad?'quad':'lin',
      function(v){c.avg.rmsQuad=v==='quad';changed();}),
      'Quadratic averages U², I² and is exact for varying amplitudes.'),
    row('Apparent power',select([['rms','S = Urms · Irms'],['mn','S = Umn · Irms']],c.sBase,function(v){c.sBase=v;changed();}),
      'Umn (rectified mean, rms calibrated) matches older or mean-reading instruments on PWM.'),
    row('Power factor',check(c.lambdaSign,function(v){c.lambdaSign=v;changed();},'λ with lead / lag sign (Hioki style)')),
    row('Range crest factor',select([['2','CF 2'],['3','CF 3'],['6','CF 6']],String(c.crest),function(v){c.crest=+v;changed();}),
      'Peak capability of a range: peak ≤ CF · range, otherwise -OL-.')
  ]));
  cols.appendChild(section('Harmonics and integration',[
    row('Harmonics',check(c.harm.enabled,function(v){c.harm.enabled=v;changed(true);},'measure (PLL sampling of every synchronised interval)')),
    c.harm.enabled?row('Max. order',select([10,20,30,40,50,63,100].map(function(o){return [String(o),String(o)];}),String(c.harm.order),
      function(v){c.harm.order=+v;changed();}),'THD is computed from the orders 2 … max.'):null,
    row('Integration start',[num(c.integ.start==null?'':PA.fmt(c.integ.start,'s',4).replace(/\s/g,''),function(v){
        if(v===''){c.integ.start=null;changed();return;}
        var t=parseSI(v);if(isFinite(t)&&t>=0){c.integ.start=t;changed();}
      },'= start','Empty: integrate from the evaluation start')],
      'WP, WP+, WP−, q integrate continuously from here to every display update.')
  ].filter(Boolean)));
  var adc=c.adc;
  cols.appendChild(section('Input stage (realism)',[
    row('Simulate',check(adc.enabled,function(v){adc.enabled=v;changed(true);},'bandwidth, ADC quantisation, noise and clipping')),
    adc.enabled?row('ADC resolution',select([8,10,12,14,16,18,20,24].map(function(b){return [String(b),b+' bit'];}),String(adc.bits),
      function(v){adc.bits=+v;changed();}),'Over the full scale ±CF · range (fixed range, or the auto range the record settles to).'):null,
    adc.enabled?row('Bandwidth',[num(+adc.bw>0?PA.fmt(+adc.bw,'',4).replace(/\s/g,''):'',function(v){
        var f=v===''?0:parseSI(v);if(isFinite(f)&&f>=0){adc.bw=f;changed();}
      },'off','First-order -3 dB frequency of the input'),h('span',{class:'pa-unit',text:' Hz'})],
      'First-order low-pass of the analog input. Shows as amplitude and phase error at higher frequencies.'):null,
    adc.enabled?row('Noise',[num(adc.noise||'',function(v){var f=v===''?0:parseFloat(v);if(isFinite(f)&&f>=0){adc.noise=f;changed();}},'0','rms noise in LSB'),
      h('span',{class:'pa-unit',text:' LSB rms'})],'Gaussian, reproducible (fixed seed).'):null
  ].filter(Boolean)));
  pane.appendChild(cols);
  pane.appendChild(h('div',{class:'pa-note',text:'All settings are part of the instrument setup and are saved with the schematic. '+
    (this.opts.workerUrl?'Records above '+((this.opts.workerThreshold||1e6)/1e6)+' M sample values are evaluated in a background worker.':'')}));
};

// ─── harmonics tab ───
UI.prototype._harmSignals=function(){
  var out=[];
  for(var e=0;e<4;e++){
    var el=this.cfg.elements[e];
    if(!PA.elementUsed(this.cfg.wiring,e))continue;
    if(el.u)out.push(['U:'+e,'U'+(e+1)+' · '+el.u.label]);
    if(el.i)out.push(['I:'+e,'I'+(e+1)+' · '+el.i.label]);
    if(el.u&&el.i)out.push(['P:'+e,'P'+(e+1)+' (power per order)']);
  }
  return out;
};
UI.prototype._renderHarm=function(){
  var self=this,c=this.cfg,ui=c.ui,pane=this.paneHarm;
  pane.textContent='';
  if(this.error||this.busy)return;
  if(!c.harm.enabled){
    pane.appendChild(h('div',{class:'pa-empty'},['Harmonic measurement is off. ',
      h('button',{class:'pa-btn',text:'Enable',onclick:function(){c.harm.enabled=true;self._configChanged(true);self._renderHarm();}}),
      ' (or in the Setup tab)']));
    return;
  }
  var sigs=this._harmSignals();
  if(!sigs.length){pane.appendChild(h('div',{class:'pa-empty',text:'No channel assigned (Channels tab).'}));return;}
  if(!ui.harmSig||!sigs.some(function(s){return s[0]===ui.harmSig;}))ui.harmSig=sigs[0][0];
  var parts=ui.harmSig.split(':'),kind=parts[0],e=+parts[1];
  var res=this._current().res;
  var hd=res?PA.harmonics(res.prim,kind,e):null;
  var bar=h('div',{class:'pa-harm-bar'},[
    h('label',{class:'pa-ctl'},[h('span',{class:'pa-ctl-lbl',text:'Signal'}),
      select(sigs,ui.harmSig,function(v){ui.harmSig=v;self._emitConfig();self._renderHarm();})]),
    kind!=='P'?h('label',{class:'pa-ctl'},[h('span',{class:'pa-ctl-lbl',text:'Scale'}),
      select([['pct','% of fundamental'],['abs','absolute']],ui.harmScale||'pct',function(v){ui.harmScale=v;self._emitConfig();self._renderHarm();})]):null,
    kind!=='P'?h('label',{class:'pa-set-check'},[(function(){var cb=h('input',{type:'checkbox'});cb.checked=!!ui.harmLog;
      cb.addEventListener('change',function(){ui.harmLog=cb.checked;self._emitConfig();self._renderHarm();});return cb;})(),' log']):null,
    h('label',{class:'pa-set-check'},[(function(){var cb=h('input',{type:'checkbox'});cb.checked=!!ui.harmDC;
      cb.addEventListener('change',function(){ui.harmDC=cb.checked;self._emitConfig();self._renderHarm();});return cb;})(),' DC (order 0)']),
    h('span',{class:'pa-spacer'}),
    hd&&kind!=='P'?h('span',{class:'pa-harm-sum'},[
      h('span',{text:(kind==='U'?'U':'I')+'(1) = '+PA.fmt(hd.mag[1],kind==='U'?'V':'A')}),
      h('span',{text:'THD = '+PA.fmt(hd.thd,'%')})]):null,
    hd&&kind==='P'?h('span',{class:'pa-harm-sum'},[h('span',{text:'P(1) = '+PA.fmt(hd.mag[1],'W')}),
      h('span',{text:'Σ P(k≥2) = '+PA.fmt(sumFrom(hd.mag,2),'W')})]):null
  ]);
  pane.appendChild(bar);
  if(!hd){
    pane.appendChild(h('div',{class:'pa-empty',text:'No harmonics for this display: they need a synchronised interval (SYNC lamp green). '+
      'With a fixed update time, every window must contain at least one whole period.'}));
    return;
  }
  var unit=kind==='U'?'V':(kind==='I'?'A':'W');
  var usePct=kind!=='P'&&(ui.harmScale||'pct')==='pct';
  var logY=kind!=='P'&&!!ui.harmLog;
  var k0=ui.harmDC?0:1,o=hd.order;
  var vals=[];
  for(var k=k0;k<=o;k++)vals.push(usePct?Math.abs(hd.pct[k]):(kind==='P'?hd.mag[k]:Math.abs(hd.mag[k])));
  pane.appendChild(this._harmChart(vals,k0,unit,usePct,logY,kind==='P',hd,kind));
  // table
  var tb=h('tbody');
  for(var k2=k0;k2<=o;k2++){
    var pc=hd.pct[k2];
    if(k2>1&&!(Math.abs(pc)>=0.01)&&k2>15)continue;   // long tail: hide empty orders
    tb.appendChild(h('tr',{class:k2===1?'pa-harm-fund':null},[
      h('th',{text:String(k2)}),
      h('td',{text:PA.fmt(hd.mag[k2],unit)}),
      h('td',{text:PA.fmt(pc,'%')}),
      h('td',{text:k2===0?'':PA.fmt(hd.deg[k2],'°')})
    ]));
  }
  var head=h('tr',null,[h('th',{text:'k'}),h('th',{text:kind==='P'?'P(k)':'rms'}),h('th',{text:kind==='P'?'% of P(1)':'% of (1)'}),
    h('th',{text:kind==='P'?'φ(k) U∠I':'phase'})]);
  pane.appendChild(h('div',{class:'pa-harm-tablewrap'},[h('table',{class:'pa-vec-table pa-harm-table'},[h('thead',null,head),tb]),
    h('div',{class:'pa-note',text:(kind==='P'
      ?'P(k) = U(k)·I(k)·cos φ(k). Negative orders feed power back towards the source.'
      :'Phase: φ(k) − k·φ(1) of the sync source, cosine reference. Orders above 15 without content are hidden.')+
      ' Follows the table mode (display / cursor / cursor window).'})]));
};
function sumFrom(a,k0){var s=0;for(var k=k0;k<a.length;k++)s+=a[k];return s;}
UI.prototype._harmChart=function(vals,k0,unit,usePct,logY,signed,hd,kind){
  var W=1000,H=300,L=64,R=12,T=14,B=30,pw=W-L-R,ph=H-T-B;
  var svg=sv('svg',{viewBox:'0 0 '+W+' '+H,class:'pa-harm-svg',preserveAspectRatio:'none'});
  var max=0,min=0;
  vals.forEach(function(v){if(isFinite(v)){if(v>max)max=v;if(v<min)min=v;}});
  if(!(max>0))max=1;
  var y,ticks=[];
  var u=usePct?'%':unit;
  if(logY){
    var top=Math.pow(10,Math.ceil(Math.log10(max))),bot=top/1e5;
    y=function(v){var c=Math.max(bot,Math.abs(v));return T+ph*(1-(Math.log10(c)-Math.log10(bot))/(Math.log10(top)-Math.log10(bot)));};
    for(var d=bot;d<=top*1.0001;d*=10)ticks.push(d);
  }else{
    var span=niceNum(Math.max(max,-min));
    var lo=min<0?-span:0,hi=span;
    y=function(v){return T+ph*(1-(v-lo)/(hi-lo));};
    for(var q=0;q<=4;q++)ticks.push(lo+(hi-lo)*q/4);
  }
  ticks.forEach(function(tv){
    var yy=y(tv);
    svg.appendChild(sv('line',{x1:L,x2:W-R,y1:yy,y2:yy,stroke:'#1c2730','stroke-width':1}));
    var tx=sv('text',{x:L-6,y:yy+4,'text-anchor':'end',class:'pa-harm-axis'});
    tx.textContent=usePct?(+tv.toPrecision(3))+' %':fmtShort(tv,u).replace(/\.0+(?=\s)/,'');
    svg.appendChild(tx);
  });
  var n=vals.length,bw=pw/n;
  var col=kind==='U'?'#00c8ff':(kind==='I'?'#ff9040':'#40ff90');
  for(var i=0;i<n;i++){
    var v=vals[i],k=k0+i;
    if(!isFinite(v))continue;
    var y0=signed?y(0):(logY?T+ph:y(0)),y1=y(v);
    var rect=sv('rect',{x:L+i*bw+bw*0.15,width:Math.max(1,bw*0.7),y:Math.min(y0,y1),height:Math.max(0.5,Math.abs(y1-y0)),
      fill:k===1?'#e8edf2':(signed&&v<0?'#ff5f87':col),opacity:k===1?0.55:0.9});
    var tt=sv('title');
    tt.textContent='Order '+k+': '+PA.fmt(hd.mag[k],unit)+' · '+PA.fmt(hd.pct[k],'%')+(k?' · '+PA.fmt(hd.deg[k],'°'):'');
    rect.appendChild(tt);
    svg.appendChild(rect);
    if(k===1||k%5===0||n<=25){
      var lx=sv('text',{x:L+i*bw+bw/2,y:H-B+16,'text-anchor':'middle',class:'pa-harm-axis'});
      lx.textContent=String(k);svg.appendChild(lx);
    }
  }
  svg.appendChild(sv('line',{x1:L,x2:W-R,y1:signed?y(0):T+ph,y2:signed?y(0):T+ph,stroke:'#7f95a8','stroke-width':1}));
  return h('div',{class:'pa-harm-chart'},svg);
};
function niceNum(v){if(!(v>0))return 1;var p=Math.pow(10,Math.floor(Math.log10(v)));var m=v/p;return (m<=1?1:m<=2?2:m<=2.5?2.5:m<=5?5:10)*p;}

if(typeof module!=='undefined'&&module.exports)module.exports=PA;
})(typeof window!=='undefined'?window:globalThis);
