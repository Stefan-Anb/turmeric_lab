function getNetName(x,y){
  for(var wi=0;wi<S.wires.length;wi++){
    var w=S.wires[wi];
    if(!w.points||w.points.length<2)continue;
    var f=w.points[0],l=w.points[w.points.length-1];
    if((f.x===x&&f.y===y)||(l.x===x&&l.y===y)){
      if(w.net)return w.net;
    }
  }
  var j=juncAt(x,y);
  if(j){
    for(var wii=0;wii<j.wires.length;wii++){
      var jw=S.wires.find(function(ww){return ww.id===j.wires[wii];});
      if(jw&&jw.net)return jw.net;
    }
  }
  for(var ci=0;ci<S.components.length;ci++){
    var c=S.components[ci];
    if(c.type==='gnd'||c.type==='vcc'||c.type==='netconn'||c.type==='sw'){
      var tp=xfPin(CD[c.type].pins[0].x,CD[c.type].pins[0].y,c.rot||0,c.mirror||false);
      if(c.x+tp.x===x&&c.y+tp.y===y){
        return c.type==='gnd'?'0':(c.label||c.value);
      }
    }
  }
  var wseg=findWireSeg(x,y,10);
  if(wseg){
    var w=S.wires.find(function(wi){return wi.id===wseg.wireId;});
    if(w&&w.net)return w.net;
  }
  return null;
}

function getNetNameWithTempNames(x,y){
  var explicitNet=getNetName(x,y);
  if(explicitNet)return explicitNet;
  
  for(var ci=0;ci<S.components.length;ci++){
    var c=S.components[ci];
    if(c.type==='gnd'||c.type==='vcc'||c.type==='netconn'||c.type==='source'){
      var def=CD[c.type];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        if(c.x+tp.x===x&&c.y+tp.y===y){
          if(c.type==='gnd')return'0';
          if(c.type==='vcc')return c.label||c.value||'VCC';
          if(c.type==='netconn')return c.label||'NET';
          if(c.type==='source'){
            var netName=getNetName(x,y);
            if(netName)return netName;
            return getTempNetNameFromPin(c.id,pi);
          }
        }
      }
    }
  }
  
  var wseg=findWireSeg(x,y,10);
  if(wseg){
    return getTempNetName(wseg.wireId);
  }
  var j=juncAt(x,y);
  if(j&&j.wires.length>0){
    return getTempNetName(j.wires[0]);
  }
  for(var wi=0;wi<S.wires.length;wi++){
    var w=S.wires[wi];
    if(!w.points||w.points.length<2)continue;
    var f=w.points[0],l=w.points[w.points.length-1];
    if((f.x===x&&f.y===y)||(l.x===x&&l.y===y)){
      return getTempNetName(w.id);
    }
  }
  return'n000';
}

function getTempNetNameFromPin(compId,pinIdx){
  var comp=S.components.find(function(c){return c.id===compId;});
  if(!comp)return null;
  var def=CD[comp.type];
  var pin=def.pins[pinIdx];
  var tp=xfPin(pin.x,pin.y,comp.rot||0,comp.mirror||false);
  var px=comp.x+tp.x,py=comp.y+tp.y;
  var wseg=findWireSeg(px,py,10);
  if(wseg)return getTempNetName(wseg.wireId);
  var j=juncAt(px,py);
  if(j&&j.wires.length>0)return getTempNetName(j.wires[0]);
  for(var wi=0;wi<S.wires.length;wi++){
    var w=S.wires[wi];
    if(!w.points||w.points.length<2)continue;
    var f=w.points[0],l=w.points[w.points.length-1];
    if((f.x===px&&f.y===py)||(l.x===px&&l.y===py)){
      return getTempNetName(w.id);
    }
  }
  return null;
}

var tempNetNamesGen={};
var tempNetCounterGen=0;
function getTempNetName(wireId){
  if(!tempNetNamesGen||Object.keys(tempNetNamesGen).length===0){
    tempNetNamesGen={};
    tempNetCounterGen=1;
    var processedWires={};
    for(var wi=0;wi<S.wires.length;wi++){
      var w=S.wires[wi];
      if(processedWires[w.id])continue;
      var netIds=getNetWires(w.id);
      var netName=null;
      for(var ni=0;ni<netIds.length;ni++){
        var nw=S.wires.find(function(nwi){return nwi.id===netIds[ni];});
        if(nw&&nw.net){netName=nw.net;break;}
      }
      if(!netName){
        var hasGnd=false;
        for(var ni=0;ni<netIds.length;ni++){
          var nw=S.wires.find(function(nwi){return nwi.id===netIds[ni];});
          if(!nw)continue;
          var eps=[nw.points[0],nw.points[nw.points.length-1]];
          for(var ei=0;ei<eps.length;ei++){
            for(var ci=0;ci<S.components.length;ci++){
              var c=S.components[ci];
              if(c.type!=='gnd')continue;
              var tp=xfPin(CD.gnd.pins[0].x,CD.gnd.pins[0].y,c.rot||0,c.mirror||false);
              if(c.x+tp.x===eps[ei].x&&c.y+tp.y===eps[ei].y){hasGnd=true;break;}
            }
            if(hasGnd)break;
          }
          if(hasGnd)break;
        }
        if(hasGnd){
          netName='0';
        } else {
          netName='n'+String(tempNetCounterGen).padStart(3,'0');
          tempNetCounterGen++;
        }
      }
      for(var nij=0;nij<netIds.length;nij++){
        processedWires[netIds[nij]]=true;
      }
      var netKey=netIds.slice().sort().join(',');
      tempNetNamesGen[netKey]=netName;
    }
  }
  var netIds=getNetWires(wireId);
  var netKey=netIds.slice().sort().join(',');
  return tempNetNamesGen[netKey]||'n000';
}

// ═══ SPICE DEVICE REFERENCES ═══
// Single source of truth for the instance name each component gets in the
// netlist. generateNetlist() uses it for the emitted cards, the probe code uses
// it to build current-vector names — so both can never drift apart.
function buildSpiceRefMap(){
  var map={},counts={vcc:0,source:0};
  var passive=['resistor','capacitor','inductor'];
  for(var i=0;i<S.components.length;i++){
    var c=S.components[i],t=c.type;
    if(t==='gnd')continue;
    if(t==='vcc'){counts.vcc++;map[c.id]='V'+counts.vcc;continue;}
    if(t==='source'){
      counts.source++;
      var sref=c.label||'SRC'+counts.source;
      var meas=c.meas||'V';
      var mode=c.mode||'DC';
      var pre=(mode==='BEHAV')?(meas==='I'?'G':'E'):(meas==='I'?'I':'V');
      map[c.id]=pre+sref;continue;
    }
    if(t==='sw'){map[c.id]='S'+(c.label||'');continue;}
    if(t==='npn'||t==='pnp'){map[c.id]='Q'+(c.label||'');continue;}
    if(t==='nmos'||t==='pmos'){map[c.id]='M'+(c.label||'');continue;}
    if(t==='diode'||t==='led'||t==='zener'){map[c.id]='D'+(c.label||'');continue;}
    if(t==='scr'||t==='pwmgen'){map[c.id]='X'+(c.label||'');continue;}
    if(t.indexOf('custom_')===0){map[c.id]='X'+(c.label||'');continue;}
    if(passive.indexOf(t)>=0){map[c.id]=c.label||'';continue;}
  }
  return map;
}

// Candidate ngspice vector names for the current flowing INTO a given pin, plus
// the sign that converts the device vector into that terminal current.
// Device currents come from `.options savecurrents` (@dev[i], @dev[ic], …);
// voltage-source branch currents are saved by ngspice anyway (i(v1)).
// Several candidates are returned because the exact parameter name differs
// between device types and ngspice versions — the plotter takes the first one
// the result actually contains.
function currentVectorsForPin(comp,pinIdx){
  var ref=(buildSpiceRefMap()[comp.id]||'').toLowerCase();
  if(!ref)return null;
  var t=comp.type;
  var def=CD[t];
  var pinName=(def&&def.pins[pinIdx])?def.pins[pinIdx].n:String(pinIdx);
  function res(cands,sign){
    return {cands:cands,sign:sign,dev:ref,pin:pinName};
  }
  // Two-terminal devices: the device current is defined from pin 0 to pin 1.
  if(t==='resistor'||t==='capacitor'||t==='inductor'||t==='sw'){
    return res(['@'+ref+'[i]'],pinIdx===0?1:-1);
  }
  if(t==='diode'||t==='led'||t==='zener'){
    return res(['@'+ref+'[id]','@'+ref+'[i]'],pinIdx===0?1:-1);
  }
  if(t==='vcc'){
    // Rail source: pin 0 is the rail node, current is drawn out of it.
    return res(['i('+ref+')','@'+ref+'[i]'],-1);
  }
  if(t==='source'){
    // i(Vx) is positive for current flowing into the + terminal (pin 0).
    return res(['i('+ref+')','@'+ref+'[i]'],pinIdx===0?1:-1);
  }
  if(t==='npn'||t==='pnp'){
    var bjt=['ib','ic','ie'][pinIdx]; // pins: B, C, E
    if(!bjt)return null;
    return res(['@'+ref+'['+bjt+']'],1);
  }
  if(t==='nmos'||t==='pmos'){
    var mos=['ig','id','is'][pinIdx]; // pins: G, D, S
    if(!mos)return null;
    return res(['@'+ref+'['+mos+']'],1);
  }
  // Subcircuit devices: ngspice exposes the currents of the parts inside the
  // subcircuit (i(v.xscr1.vsense) …), so the built-in models can still be
  // probed. A user-supplied model has an unknown interior — no probe then.
  if(t==='scr'&&!comp.model){
    if(pinIdx===2)return null;                       // gate current not modelled
    return res(['i(v.'+ref+'.vsense)','@v.'+ref+'.vsense[i]'],pinIdx===0?1:-1);
  }
  if(t==='pwmgen'){
    // pins: IN, OUTH, COMH, OUTL, COML — the two output sources can be probed,
    // their return pins carry the same current with the opposite sign.
    var bsrc=[null,'bouth','bouth','boutl','boutl'][pinIdx];
    if(!bsrc)return null;
    return res(['i(b.'+ref+'.'+bsrc+')','@b.'+ref+'.'+bsrc+'[i]'],(pinIdx===1||pinIdx===3)?1:-1);
  }
  return null;
}

// ═══ MODEL / SUBCIRCUIT TEMPLATES FOR THE COMPOSITE PARTS ═══

// Z-diode: a plain diode model with the instance's breakdown voltage. IBV is
// the current at which BV is specified, so it doubles as the knee current.
function zenerModelCard(name,c){
  var bv=(c.bv||'5.1'),rs=(c.rs||'1'),iz=(c.iz||'5m');
  return '.model '+name+' D(IS=1e-14 N=1.6 RS='+rs+' CJO=100p BV='+bv+' IBV='+iz+')';
}

// Thyristor: behavioural latch model. A plain two-transistor macro model cannot
// hold off (its loop gain a_npn + a_pnp is > 1 at any current, so it self-fires
// at a few mA), therefore the latch state is kept explicitly: it sets when the
// gate exceeds Vgt and holds as long as the anode current stays above Ih. The
// state node drives a switch in series with a diode for the forward drop; the
// RC on the state node breaks the algebraic feedback loop.
function scrSubckt(name,c){
  var vgt=c.vgt||'0.7',ih=c.ih||'5m',ron=c.ron||'0.1';
  return [
    '* Thyristor (SCR) — behavioural latch ('+name+')',
    '.subckt '+name+' A G K',
    'Vsense A a1 DC 0',
    'Dfwd  a1 a2 '+name+'_d',
    'Ssw   a2 K  st 0 '+name+'_sw',
    'Blatch stx 0 V = ( (v(G,K) > '+vgt+') || (v(st) > 0.5 && i(Vsense) > '+ih+') ) ? 1 : 0',
    'Rlat  stx st 100',
    'Clat  st  0  10n',
    'Rgk   G   K  1k',
    'Roff  A   K  10meg',
    '.model '+name+'_sw SW(vt=0.5 vh=0.2 ron='+ron+' roff=1e9)',
    '.model '+name+'_d  D(IS=1e-12 N=1.2 RS=0.05)',
    '.ends '+name
  ];
}

// PWM generator with half-bridge gate-drive outputs, built from behavioural
// sources. A sawtooth of amplitude `range` is compared against the IN voltage,
// so IN = 0 … range maps to 0 … 100 % duty. IN and the modulator are referenced
// to real ground (node 0, global inside subcircuits); each output drives
// against its own return, OUTH/COMH for the high side and OUTL/COML for the
// low side, so the high-side pair can float with the switch node.
//
// The dead time is inserted by shifting the comparison thresholds rather than
// by delaying the logic signals: the sawtooth climbs `range` volts per period,
// so a dead time `dt` corresponds to the voltage offset dv = dt·f·range. The
// high side then conducts while dv < saw < V(IN) and the low side while
// saw > V(IN) + dv, which delays both turn-ons without touching the turn-offs.
// (The `delay()` operator of the reference model hangs this WASM ngspice
// build, and it would also introduce an algebraic loop.)
function pwmGenSubckt(name,c){
  var f=c.pwm_freq||'10k';
  var range=c.pwm_range||'5';
  var vhigh=c.pwm_vhigh||'12';
  var vlow=c.pwm_vlow||'0';
  var dt=String(c.pwm_deadtime||'0').trim();
  var hasDt=!!dt&&parseFloat(dt)!==0;
  var dv=hasDt?('('+dt+'*'+f+'*'+range+')'):'0';
  return [
    '* PWM generator + half-bridge drive ('+name+'), dead time '+(hasDt?dt+'s':'off'),
    '.subckt '+name+' IN OUTH COMH OUTL COML',
    'Bsaw  saw  0 v = (time - floor(time*'+f+')/'+f+') * '+range+' * '+f,
    'Bouth OUTH COMH v = (v(saw) > '+dv+' && v(saw) < v(IN)) ? '+vhigh+' : '+vlow,
    'Boutl OUTL COML v = (v(saw) > (v(IN) + '+dv+')) ? '+vhigh+' : '+vlow,
    '.ends '+name
  ];
}

function generateNetlist(){
  tempNetNamesGen={};
  tempNetCounterGen=0;
  getTempNetName(S.wires.length>0?S.wires[0].id:null);
  var refMap=buildSpiceRefMap();
  var lines=[];
  var subcircuits=[];
  var passive=['resistor','capacitor','inductor'];
  var swModels=[];
  var zenerModels=[];   // per-instance .model cards for Z-diodes
  var pwmSubs=[];       // per-instance PWM generator subcircuits
  var scrSubs=[];       // per-instance thyristor subcircuits
  // Determine which component classes are actually present, so we only emit
  // the default .model card for classes that have at least one instance.
  var present={};
  for(var hi=0;hi<S.components.length;hi++)present[S.components[hi].type]=true;

  lines.push('* SPICE Netlist generated by SchematicForge');
  if(present.sw)lines.push('.model defaultswitch sw vt=1 vh=0.2 ron=1u roff=1e+12');
  if(present.diode||present.led)lines.push('.model defaultdiode D');
  if(present.npn)lines.push('.model npn_default NPN ( IS=1e-14 BF=200 NF=1 VAF=100 IKF=0.3 ISE=1e-13 NE=1.5 BR=5 NR=1 VAR=20 IKR=0.1 ISC=1e-13 NC=2 RE=0.5 RC=0.5 RB=10 CJE=2e-12 VJE=0.75 MJE=0.33 CJC=1e-12 VJC=0.6 MJC=0.33 TF=0.5e-9 TR=50e-9 XTB=1.5 EG=1.11 XTI=3 KF=1e-15 AF=1 )');
  if(present.pnp)lines.push('.model pnp_default PNP ( IS=1e-14 BF=150 NF=1 VAF=80 IKF=0.2 ISE=1e-13 NE=1.5 BR=3 NR=1 VAR=15 IKR=0.08 ISC=1e-13 NC=2 RE=0.6 RC=0.6 RB=12 CJE=2.5e-12 VJE=0.75 MJE=0.33 CJC=1.2e-12 VJC=0.6 MJC=0.33 TF=0.6e-9 TR=60e-9 XTB=1.5 EG=1.11 XTI=3 KF=1e-15 AF=1 )');
  if(present.nmos)lines.push('.model mos_n_default VDMOS ( VTO=4.0 KP=8 LAMBDA=0.02 RDS=0.08 RD=0.02 RS=0.02 RG=2 IS=1e-12 N=1.2 BV=100 IBV=1e-3 CGS=1.5e-9 CGD=0.8e-9 CBD=0.6e-9 TOX=1e-7 UO=600 VMAX=1e5 THETA=0.1 TCV=0.003 )');
  if(present.pmos)lines.push('.model mos_p_default VDMOS ( VTO=-4.0 KP=8 LAMBDA=0.02 RDS=0.08 RD=0.02 RS=0.02 RG=2 IS=1e-12 N=1.2 BV=100 IBV=1e-3 CGS=1.5e-9 CGD=0.8e-9 CBD=0.6e-9 TOX=1e-7 UO=600 VMAX=1e5 THETA=0.1 TCV=0.003 )');
  lines.push('');

  for(var ci=0;ci<S.components.length;ci++){
    var c=S.components[ci];
    var def=CD[c.type];
    if(c.type==='vcc'){
      var ref=refMap[c.id];
      var tp=xfPin(def.pins[0].x,def.pins[0].y,c.rot||0,c.mirror||false);
      var px=c.x+tp.x,py=c.y+tp.y;
      var netName=getNetNameWithTempNames(px,py);
      var voltage=c.value||def.val||'5V';
      var line=ref+' '+netName+' 0 DC '+voltage;
      lines.push(line);
      continue;
    }
    if(c.type==='source'){
      var mode=c.mode||'DC';
      // refMap already carries the type prefix (V/I, or E/G for behavioural).
      var dev=refMap[c.id];
      var tp1=xfPin(def.pins[0].x,def.pins[0].y,c.rot||0,c.mirror||false);
      var tp2=xfPin(def.pins[1].x,def.pins[1].y,c.rot||0,c.mirror||false);
      var px1=c.x+tp1.x,py1=c.y+tp1.y;
      var px2=c.x+tp2.x,py2=c.y+tp2.y;
      // Use the temp-name resolver (like every other device) so unnamed nets
      // get n0xx names instead of resolving to null and shorting the source.
      var net1=getNetNameWithTempNames(px1,py1);
      var net2=getNetNameWithTempNames(px2,py2);
      var line='';
      if(mode==='DC'){
        var val=c.value||def.val||'1';
        line=dev+' '+net1+' '+net2+' DC '+val;
      }else if(mode==='AC'){
        var vo=c.ac_offset||'0';
        var va=c.ac_amplitude||'1';
        var freq=c.ac_frequency||'1k';
        var td=c.ac_tdelay||'0';
        var theta=c.ac_theta||'0';
        var phi=c.ac_phi||'0';
        line=dev+' '+net1+' '+net2+' SIN('+vo+' '+va+' '+freq+' '+td+' '+theta+' '+phi+')';
      }else if(mode==='PULSE'){
        var v1=c.pulse_vinit||'0';
        var v2=c.pulse_von||'1';
        var td=c.pulse_tdelay||'0';
        var tr=c.pulse_trise||'1e-6';
        var tf=c.pulse_tfall||'1e-6';
        var pw=c.pulse_ton||'1e-3';
        var per=c.pulse_tperiod||'1e-3';
        var np=c.pulse_ncycles||'1';
        line=dev+' '+net1+' '+net2+' PULSE('+v1+' '+v2+' '+td+' '+tr+' '+tf+' '+pw+' '+per+' '+np+')';
      }else if(mode==='BEHAV'){
        var eq=c.beh_eq||'0';
        line=dev+' '+net1+' '+net2+' cur = \''+eq+'\'';
      }
      lines.push(line);
      continue;
    }
    if(c.type==='gnd')continue;
    if(c.type==='sw'){
      var ref=refMap[c.id];
      var model=c.model||'defaultswitch';
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line=ref+' '+nets[0]+' '+nets[1]+' '+nets[3]+' '+nets[2]+' '+model;
      lines.push(line);
      continue;
    }
    if(c.type==='npn'||c.type==='pnp'){
      var ref=refMap[c.id];
      var model=c.value||(c.type==='npn'?'npn_default':'pnp_default');
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line=ref+' '+nets[1]+' '+nets[0]+' '+nets[2]+' '+model;
      lines.push(line);
      continue;
    }
    if(c.type==='nmos'||c.type==='pmos'){
      var ref=refMap[c.id];
      var model=c.value||(c.type==='nmos'?'mos_n_default':'mos_p_default');
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line=ref+' '+nets[1]+' '+nets[0]+' '+nets[2]+' '+model;
      lines.push(line);
      continue;
    }
    if(c.type==='zener'){
      var ref=refMap[c.id];
      // Each Z-diode gets its own .model card carrying its breakdown voltage,
      // unless the user pinned an explicit model name.
      var model=c.model||('zm_'+ref.toLowerCase());
      if(!c.model)zenerModels.push(zenerModelCard(model,c));
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        nets.push(getNetNameWithTempNames(c.x+tp.x,c.y+tp.y));
      }
      lines.push(ref+' '+nets[0]+' '+nets[1]+' '+model);   // D<ref> anode cathode model
      continue;
    }
    if(c.type==='scr'){
      var ref=refMap[c.id];
      var subname=c.model||('scr_'+ref.toLowerCase());
      if(!c.model)scrSubs.push(scrSubckt(subname,c));
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        nets.push(getNetNameWithTempNames(c.x+tp.x,c.y+tp.y));
      }
      // pins are A, K, G — the subcircuit port order is A G K
      lines.push(ref+' '+nets[0]+' '+nets[2]+' '+nets[1]+' '+subname);
      continue;
    }
    if(c.type==='pwmgen'){
      var ref=refMap[c.id];
      // One subcircuit per instance with the parameters inlined: that keeps the
      // deck free of parameter expansion and lets us drop the dead-time delay
      // lines entirely when no dead time is configured.
      var subname='pwmgen_'+ref.toLowerCase();
      pwmSubs.push(pwmGenSubckt(subname,c));
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        nets.push(getNetNameWithTempNames(c.x+tp.x,c.y+tp.y));
      }
      // pin order matches the subcircuit ports: IN OUTH COMH OUTL COML
      lines.push(ref+' '+nets.join(' ')+' '+subname);
      continue;
    }
    if(c.type==='diode'||c.type==='led'){
      var ref=refMap[c.id];
      var model=c.value||'defaultdiode';
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line=ref+' '+nets[0]+' '+nets[1]+' '+model;
      lines.push(line);
      continue;
    }
    if(c.type.indexOf('custom_')===0){
      var ref=refMap[c.id];
      var subname=def._name||def.lbl||c.type;
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line=ref+' '+nets.join(' ')+' '+subname;
      lines.push(line);
      continue;
    }
    if(passive.indexOf(c.type)<0)continue;
    var ref=refMap[c.id];
    var nets=[];
    for(var pi=0;pi<def.pins.length;pi++){
      var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
      var px=c.x+tp.x,py=c.y+tp.y;
      var netName=getNetNameWithTempNames(px,py);
      nets.push(netName);
    }
    var val=c.value||def.val;
    var line=ref+' '+nets[0]+' '+nets[1]+' '+val;
    lines.push(line);
  }

  if(zenerModels.length){
    lines.push('');
    lines.push('* Z-diode models');
    for(var zi=0;zi<zenerModels.length;zi++)lines.push(zenerModels[zi]);
  }
  for(var si2=0;si2<scrSubs.length;si2++){
    lines.push('');
    for(var sl=0;sl<scrSubs[si2].length;sl++)lines.push(scrSubs[si2][sl]);
  }
  for(var pi2=0;pi2<pwmSubs.length;pi2++){
    lines.push('');
    for(var pl=0;pl<pwmSubs[pi2].length;pl++)lines.push(pwmSubs[pi2][pl]);
  }

  var processedSubcircuits={};
  for(var ci=0;ci<S.components.length;ci++){
    var c=S.components[ci];
    if(c.type.indexOf('custom_')!==0)continue;
    if(processedSubcircuits[c.type])continue;
    processedSubcircuits[c.type]=true;
    var def=CD[c.type];
    var subname=def._name||def.lbl||c.type;
    var pinList=def.pins.map(function(p){return p.n;}).join(' ');
    lines.push('');
    lines.push('* Subcircuit: '+subname);
    lines.push('.subckt '+subname+' '+pinList);
    lines.push('* (subcircuit definition not implemented - user must provide)');
    lines.push('.ends '+subname);
  }

  return lines.join('\n');
}