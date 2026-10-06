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

// ═══ GROUND ALWAYS WINS ═══
// A net that carries a ground symbol IS node 0, no matter which label it also
// has. Without this rule a labelled-and-grounded wire ends up as its own node
// and floats in the simulation ("singular matrix").
function gndPinAt(x,y){
  for(var ci=0;ci<S.components.length;ci++){
    var c=S.components[ci];
    if(c.type!=='gnd')continue;
    var tp=xfPin(CD.gnd.pins[0].x,CD.gnd.pins[0].y,c.rot||0,c.mirror||false);
    if(c.x+tp.x===x&&c.y+tp.y===y)return true;
  }
  return false;
}
function netIdsTouchGnd(netIds){
  for(var i=0;i<netIds.length;i++){
    var w=S.wires.find(function(ww){return ww.id===netIds[i];});
    if(!w||!w.points||!w.points.length)continue;
    var eps=[w.points[0],w.points[w.points.length-1]];
    for(var e=0;e<eps.length;e++)if(gndPinAt(eps[e].x,eps[e].y))return true;
  }
  return false;
}
function wireIdAt(x,y){
  for(var wi=0;wi<S.wires.length;wi++){
    var w=S.wires[wi];
    if(!w.points||w.points.length<2)continue;
    var f=w.points[0],l=w.points[w.points.length-1];
    if((f.x===x&&f.y===y)||(l.x===x&&l.y===y))return w.id;
  }
  var j=juncAt(x,y);
  if(j&&j.wires.length)return j.wires[0];
  var seg=findWireSeg(x,y,10);
  if(seg)return seg.wireId;
  return null;
}
function netAtPointIsGnd(x,y){
  if(gndPinAt(x,y))return true;
  var wid=wireIdAt(x,y);
  if(!wid)return false;
  return netIdsTouchGnd(getNetWires(wid));
}

function getNetNameWithTempNames(x,y){
  if(netAtPointIsGnd(x,y))return '0';
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
      // Ground beats an explicit label — see netAtPointIsGnd() above.
      if(netIdsTouchGnd(netIds)){
        netName='0';
      }else{
        for(var ni=0;ni<netIds.length;ni++){
          var nw=S.wires.find(function(nwi){return nwi.id===netIds[ni];});
          if(nw&&nw.net){netName=nw.net;break;}
        }
      }
      if(!netName){
        netName='n'+String(tempNetCounterGen).padStart(3,'0');
        tempNetCounterGen++;
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
// Sanitized reference stem for a transformer instance's two internal coupled
// inductors (LxxxP/LxxxS) and coupling statement (KxxxT) — one place so
// generateNetlist, buildSaveVectors, buildSpiceRefMap and currentVectorsForPin
// never drift apart on the exact vector names (a transformer isn't a single
// SPICE device, so it doesn't fit the one-ref-per-component map below).
function transformerRef(c){
  return (c.label||'TR').replace(/[^A-Za-z0-9_]/g,'')||'TR';
}

function buildSpiceRefMap(){
  var map={},counts={vcc:0,source:0};
  var passive=['resistor','capacitor','inductor'];
  for(var i=0;i<S.components.length;i++){
    var c=S.components[i],t=c.type;
    if(t==='gnd')continue;
    if(t==='transformer'){map[c.id]=transformerRef(c);continue;}
    if(t==='vcc'){counts.vcc++;map[c.id]='V'+counts.vcc;continue;}
    if(t==='source'){
      counts.source++;
      var sref=c.label||'SRC'+counts.source;
      var meas=c.meas||'V';
      var mode=c.mode||'DC';
      var isLoad=(mode==='DC'&&meas==='I'&&!!c.load);
      var pre=isLoad?'B':((mode==='BEHAV')?(meas==='I'?'G':'E'):(meas==='I'?'I':'V'));
      map[c.id]=pre+sref;continue;
    }
    if(t==='sw'){map[c.id]='S'+(c.label||'');continue;}
    if(t==='npn'||t==='pnp'){map[c.id]='Q'+(c.label||'');continue;}
    if(t==='nmos'||t==='pmos'){map[c.id]='M'+(c.label||'');continue;}
    if(t==='diode'||t==='led'||t==='zener'){map[c.id]='D'+(c.label||'');continue;}
    if(t==='scr'||t==='pwmgen'||MC_SUBCKT[t]){map[c.id]='X'+(c.label||'');continue;}
    if(t.indexOf('custom_')===0){map[c.id]='X'+(c.label||'');continue;}
    if(passive.indexOf(t)>=0){map[c.id]=c.label||'';continue;}
  }
  return map;
}

// Candidate ngspice vector names for the current flowing INTO a given pin, plus
// the sign that converts the device vector into that terminal current.
// Device currents come from the generated `.save` list (@dev[i], @dev[ic], …);
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
  // Transformer: pins 0/1 are the primary inductor's own two terminals, 2/3
  // the secondary's — each is a plain two-terminal current, just off a
  // different one of the two internal L instances (dev overridden so the
  // display label reads e.g. "I(tr1p.P1)" instead of the shared bare ref).
  if(t==='transformer'){
    if(pinIdx===0||pinIdx===1)return{cands:['@l'+ref+'p[i]'],sign:pinIdx===0?1:-1,dev:ref+'p',pin:pinName};
    if(pinIdx===2||pinIdx===3)return{cands:['@l'+ref+'s[i]'],sign:pinIdx===2?1:-1,dev:ref+'s',pin:pinName};
    return null;
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

// Parses SPICE-style engineering-notation numbers ("1m", "4.7k", "0.001", …)
// into a plain JS number. Trailing unit letters (e.g. "1mOhm"/"1mΩ") are
// tolerated since only the recognised SI-prefix character right after the
// digits is consumed.
function parseEngNumber(str){
  var m=String(str||'').trim().match(/^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*(meg|[tgkmunpµ])?/i);
  if(!m)return NaN;
  var mult={t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,'µ':1e-6,n:1e-9,p:1e-12}[(m[2]||'').toLowerCase()]||1;
  return parseFloat(m[1])*mult;
}

// MOSFET: an approximate per-instance VDMOS card, sized from the Rds(on) the
// user enters in the properties panel. In the VDMOS channel's linear region
// (Vds→0) the resistance is 1/(KP·(Vgs−Vto)) with THETA-mobility degradation
// folded in — see the ngspice VDMOS model (based on MOS1). Solving that for KP
// against a fixed logic-level reference point (Vgs=5V, against the VTO=±4V /
// THETA=0.1 used everywhere else in this default model, i.e. a 1V overdrive)
// gives the KP that lands Rds(on) on target at that one operating point; RD/RS
// take a small (1%) slice each as a token series/parasitic split. This is a
// rough single-point fit ("grob"), not a real datasheet curve fit.
function mosModelCard(name,c,chan){
  var vto=(chan==='PCHAN')?-4.0:4.0;
  var theta=0.1;
  var vgsRef=5;
  var overdrive=vgsRef-Math.abs(vto);   // 1V with the fixed VTO above
  var target=parseEngNumber(c.rdson);
  if(!(target>0))target=1e-3;           // default: 1 mΩ
  var rd=Math.max(target*0.01,1e-5);
  var rs=rd;
  var rchan=Math.max(target-rd-rs,1e-6);
  var kp=(1+theta*overdrive)/(rchan*overdrive);
  return '.model '+name+' VDMOS ( '+chan+' VTO='+vto+' KP='+kp.toPrecision(6)+
    ' LAMBDA=0.02 RDS=1e7 RD='+rd.toExponential(3)+' RS='+rs.toExponential(3)+
    ' RG=2 IS=1e-12 N=1.2 BV=100 IBV=1e-3 CGS=1.5e-9 CGDMAX=0.8e-9 CGDMIN=0.08e-9 CJO=0.6e-9 THETA='+theta+' )';
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
  var range=c.pwm_range||'1';
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

// ═══ MOTOR CONTROL BLOCKS ═══
// All signals are plain node voltages in SI units (1 V = 1 A / 1 rad / 1 rad/s /
// 1 N·m …). Each block is one per-instance subcircuit with its parameters
// inlined, and its port order is exactly the pin order of the CD entry.

// Expression operand: a plain number if the text parses as one (so "5.839m"
// works inside a B-source), otherwise the raw text in parentheses (.param names,
// {expressions}).
function mcExpr(val,def){
  var t=String(val==null||String(val).trim()===''?def:val).trim();
  if(!/[{}]/.test(t)){
    var n=parseEngNumber(t);
    if(isFinite(n))return '('+String(+n.toPrecision(12))+')';
  }
  return '('+t+')';
}
// Element value (C card): keep SPICE notation as typed.
function mcVal(val,def){
  return String(val==null||String(val).trim()===''?def:val).trim();
}
var MC_SQRT3_2='0.8660254037844386';

// Induction motor, stationary alpha/beta frame, amplitude-invariant (Clarke 2/3),
// star connected with floating neutral. State variables are the stator and
// rotor flux linkages (4 integrators), plus speed and angle. An integrator is
// "B current source into a capacitor of 1 F" (v = integral of the current);
// each state node also gets a 1 G leak to ground for the DC operating point, and
// the derivatives are gated with (time>0) so the operating point is the plain
// rest state whatever the inverter outputs at t=0.
//   dpsi_s/dt = v_s - Rs i_s            dpsi_r/dt = -Rr i_r + j we psi_r
//   psi_s = Ls i_s + Lm i_r             psi_r = Lm i_s + Lr i_r
//   Te = 1.5 p (psi_sa i_sb - psi_sb i_sa)     J dw/dt = Te - TL - B w
function inductionMotorSubckt(name,c){
  var p=mcExpr(c.im_p,'2'),rs=mcExpr(c.im_rs,'1.405'),rr=mcExpr(c.im_rr,'1.395');
  var lls=mcExpr(c.im_lls,'5.839m'),llr=mcExpr(c.im_llr,'5.839m'),lm=mcExpr(c.im_lm,'172.2m');
  var bf=mcExpr(c.im_b,'1m'),jv=mcVal(c.im_j,'13.1m');
  var ls='('+lls+'+'+lm+')',lr='('+llr+'+'+lm+')';
  var d='('+ls+'*'+lr+'-'+lm+'*'+lm+')';
  var g='(time>0)';
  var s3=MC_SQRT3_2;
  return [
    '* Induction motor ('+name+'): stator/rotor flux state model',
    '.subckt '+name+' A B C TL TE W TH IA IB IC',
    'Rla A 0 1G','Rlb B 0 1G','Rlc C 0 1G','Rtl TL 0 1G','Rnn nn 0 1Meg',
    'Bvsa vsa 0 V = (2/3)*(v(A)-0.5*v(B)-0.5*v(C))',
    'Bvsb vsb 0 V = (v(B)-v(C))/sqrt(3)',
    'Bisa isa 0 V = ('+lr+'*v(psa)-'+lm+'*v(pra))/'+d,
    'Bisb isb 0 V = ('+lr+'*v(psb)-'+lm+'*v(prb))/'+d,
    'Bira ira 0 V = ('+ls+'*v(pra)-'+lm+'*v(psa))/'+d,
    'Birb irb 0 V = ('+ls+'*v(prb)-'+lm+'*v(psb))/'+d,
    'Bdpsa 0 psa I = '+g+' ? (v(vsa)-'+rs+'*v(isa)) : 0',
    'Bdpsb 0 psb I = '+g+' ? (v(vsb)-'+rs+'*v(isb)) : 0',
    'Bdpra 0 pra I = '+g+' ? (-'+rr+'*v(ira)-'+p+'*v(ww)*v(prb)) : 0',
    'Bdprb 0 prb I = '+g+' ? (-'+rr+'*v(irb)+'+p+'*v(ww)*v(pra)) : 0',
    'Cpsa psa 0 1','Cpsb psb 0 1','Cpra pra 0 1','Cprb prb 0 1',
    'Rpsa psa 0 1G','Rpsb psb 0 1G','Rpra pra 0 1G','Rprb prb 0 1G',
    'Btrq trq 0 V = 1.5*'+p+'*(v(psa)*v(isb)-v(psb)*v(isa))',
    'Bdww 0 ww I = '+g+' ? (v(trq)-v(TL)-'+bf+'*v(ww)) : 0',
    'Cww ww 0 '+jv,'Rww ww 0 1G',
    'Bdth 0 thm I = '+g+' ? v(ww) : 0',
    'Cthm thm 0 1','Rthm thm 0 1G',
    'Bia A nn I = v(isa)',
    'Bib B nn I = -0.5*v(isa)+'+s3+'*v(isb)',
    'Bic C nn I = -0.5*v(isa)-'+s3+'*v(isb)',
    'BoTE TE 0 V = v(trq)',
    'BoW W 0 V = v(ww)*9.549296585513720',
    'BoTH TH 0 V = v(thm)*57.29577951308232',
    'BoIA IA 0 V = v(isa)',
    'BoIB IB 0 V = -0.5*v(isa)+'+s3+'*v(isb)',
    'BoIC IC 0 V = -0.5*v(isa)-'+s3+'*v(isb)',
    '.ends '+name
  ];
}

// Clarke transform abc -> alpha/beta, amplitude invariant.
function clarkeSubckt(name,c){
  var two=(c.clk_two===true||c.clk_two==='true');
  return [
    '* Clarke transform ('+name+')',
    '.subckt '+name+' IA IB IC ALPHA BETA',
    'Rla IA 0 1G','Rlb IB 0 1G','Rlc IC 0 1G',
    two?'Bal ALPHA 0 V = v(IA)'
        :'Bal ALPHA 0 V = (2/3)*(v(IA)-0.5*v(IB)-0.5*v(IC))',
    two?'Bbe BETA 0 V = (v(IA)+2*v(IB))/sqrt(3)'
        :'Bbe BETA 0 V = (v(IB)-v(IC))/sqrt(3)',
    '.ends '+name
  ];
}

// Park transform; TH is the d-axis angle in rad.
function parkSubckt(name,c){
  var inv=(c.park_dir==='inv');
  return [
    '* Park transform, '+(inv?'dq -> alpha/beta':'alpha/beta -> dq')+' ('+name+')',
    '.subckt '+name+' IN1 IN2 TH OUT1 OUT2',
    'Rl1 IN1 0 1G','Rl2 IN2 0 1G','Rlt TH 0 1G',
    inv?'Bo1 OUT1 0 V = v(IN1)*cos(v(TH))-v(IN2)*sin(v(TH))'
        :'Bo1 OUT1 0 V = v(IN1)*cos(v(TH))+v(IN2)*sin(v(TH))',
    inv?'Bo2 OUT2 0 V = v(IN1)*sin(v(TH))+v(IN2)*cos(v(TH))'
        :'Bo2 OUT2 0 V = -v(IN1)*sin(v(TH))+v(IN2)*cos(v(TH))',
    '.ends '+name
  ];
}

// Space vector modulation as min/max (zero-sequence) injection, which gives
// exactly the SVPWM duty cycles: d_x = 0.5 + (v_x - (max+min)/2) / Vdc,
// clamped to 0..1. If the VDC pin carries more than 1 V it overrides the
// Vdc property (DC-link ripple/droop); left open it falls back to the property.
function svmSubckt(name,c){
  var vdc=mcExpr(c.svm_vdc,'400'),range=mcExpr(c.svm_range,'1');
  var s3=MC_SQRT3_2;
  function duty(x){return 'Bd'+x+' d'+x+' 0 V = 0.5+(v(p'+x+')-0.5*(v(mx)+v(mn)))/v(vd)';}
  function out(x,X){return 'Bo'+x+' OUT'+X+' 0 V = '+range+'*((v(d'+x+')<0)?0:((v(d'+x+')>1)?1:v(d'+x+')))';}
  return [
    '* Space vector modulation ('+name+')',
    '.subckt '+name+' VALPHA VBETA VDC OUTA OUTB OUTC',
    'Rl1 VALPHA 0 1G','Rl2 VBETA 0 1G','Rl3 VDC 0 1G',
    'Bvd vd 0 V = (v(VDC)>1) ? v(VDC) : '+vdc,
    'Bpa pa 0 V = v(VALPHA)',
    'Bpb pb 0 V = -0.5*v(VALPHA)+'+s3+'*v(VBETA)',
    'Bpc pc 0 V = -0.5*v(VALPHA)-'+s3+'*v(VBETA)',
    'Bmx mx 0 V = (v(pa)>v(pb)) ? ((v(pa)>v(pc))?v(pa):v(pc)) : ((v(pb)>v(pc))?v(pb):v(pc))',
    'Bmn mn 0 V = (v(pa)<v(pb)) ? ((v(pa)<v(pc))?v(pa):v(pc)) : ((v(pb)<v(pc))?v(pb):v(pc))',
    duty('a'),duty('b'),duty('c'),
    out('a','A'),out('b','B'),out('c','C'),
    '.ends '+name
  ];
}

// PI controller, out = clamp(Kp*e + xi), e = REF - FB, with xi' = Ki*e. Anti-windup
// by conditional integration: the integrator stops while the output is saturated
// and the error would push it further into the limit.
function piSubckt(name,c){
  var kp=mcExpr(c.pi_kp,'1'),ki=mcExpr(c.pi_ki,'100');
  var mn=mcExpr(c.pi_min,'-10'),mx=mcExpr(c.pi_max,'10');
  return [
    '* PI controller ('+name+')',
    '.subckt '+name+' REF FB OUT',
    'Rl1 REF 0 1G','Rl2 FB 0 1G',
    'Ber er 0 V = v(REF)-v(FB)',
    'Bu u 0 V = '+kp+'*v(er)+v(xi)',
    'Bdi 0 xi I = (time>0) ? ( ((v(u)>'+mx+' && v(er)>0) || (v(u)<'+mn+' && v(er)<0)) ? 0 : '+ki+'*v(er) ) : 0',
    'Cxi xi 0 1','Rxi xi 0 1G',
    'Bo OUT 0 V = (v(u)>'+mx+') ? '+mx+' : ((v(u)<'+mn+') ? '+mn+' : v(u))',
    '.ends '+name
  ];
}

// Integrator, out = K * integral(in) dt, starting at 0 (gated like the motor states).
function integratorSubckt(name,c){
  var k=mcExpr(c.int_k,'1');
  return [
    '* Integrator ('+name+')',
    '.subckt '+name+' IN OUT',
    'Rl IN 0 1G',
    'Bdi 0 xi I = (time>0) ? '+k+'*v(IN) : 0',
    'Cxi xi 0 1','Rxi xi 0 1G',
    'Bo OUT 0 V = v(xi)',
    '.ends '+name
  ];
}

// Free function block; in1..in3 in the expression become v(IN1)..v(IN3).
function mathBlockSubckt(name,c){
  var e=String(c.fn_expr==null||String(c.fn_expr).trim()===''?'0':c.fn_expr).trim();
  e=e.replace(/\bin([1-3])\b/gi,'v(IN$1)');
  return [
    '* Function block ('+name+')',
    '.subckt '+name+' IN1 IN2 IN3 OUT',
    'Rl1 IN1 0 1G','Rl2 IN2 0 1G','Rl3 IN3 0 1G',
    'Bo OUT 0 V = '+e,
    '.ends '+name
  ];
}

var MC_SUBCKT={indmotor:inductionMotorSubckt,clarke:clarkeSubckt,park:parkSubckt,svm:svmSubckt,
  pi:piSubckt,integrator:integratorSubckt,mathblk:mathBlockSubckt};

// ═══ MODEL SELECTION ═══
// Symbols carry a part number for documentation (2N2222, 1N4148, RED …), but a
// part number is not a SPICE model. Unless the user actually supplied a
// `.model`/`.subckt` card of that name in the directives box, the device falls
// back to the built-in default model, so a freshly placed part always simulates.
function userDefinedModels(){
  var names={};
  var el=document.getElementById('sim-directives');
  var txt=el?(el.value||''):'';
  var re=/^[\t ]*\.(model|subckt)[\t ]+([^\s(]+)/gim,m;
  while((m=re.exec(txt)))names[m[2].toLowerCase()]=true;
  return names;
}

function pickModel(part,fallback,userModels,notes,ref){
  var p=String(part||'').trim();
  // 'default' is the placeholder shown in newly placed components' Part field
  // (they don't model a specific real device) — treat it the same as blank,
  // silently, instead of logging a "no .model named 'default'" note.
  if(!p||p.toLowerCase()==='default')return fallback;
  if(userModels[p.toLowerCase()])return p;
  if(notes&&!notes.seen[p.toLowerCase()]){
    notes.seen[p.toLowerCase()]=true;
    notes.lines.push('* note: no .model/.subckt named "'+p+'" ('+ref+') — using '+fallback);
  }
  return fallback;
}

// ═══ SAVE LIST FOR DEVICE CURRENTS ═══
// `.options savecurrents` cannot be used: it blindly asks for every terminal of
// every device, including `@m1[ib]` on a VDMOS, which has no bulk terminal. The
// missing vector makes ngspice abort the whole raw output ("no writable vector
// found") and this WASM build then never returns at all. So the save list is
// built from the schematic instead — only terminals that actually exist.
// `all` covers the node voltages plus the branch currents of every voltage and
// behavioural source, including the ones inside our subcircuits.
function buildSaveVectors(){
  var refMap=buildSpiceRefMap();
  var out=[];
  for(var i=0;i<S.components.length;i++){
    var c=S.components[i],t=c.type,ref=refMap[c.id];
    if(!ref)continue;
    if(t==='resistor'||t==='capacitor'||t==='inductor'||t==='sw'){out.push('@'+ref+'[i]');continue;}
    if(t==='transformer'){var traf=ref.toLowerCase();out.push('@l'+traf+'p[i]','@l'+traf+'s[i]');continue;}
    if(t==='diode'||t==='led'||t==='zener'){out.push('@'+ref+'[id]');continue;}
    if(t==='npn'||t==='pnp'){out.push('@'+ref+'[ic]','@'+ref+'[ib]','@'+ref+'[ie]');continue;}
    // VDMOS is a three-terminal device here — no [ib]!
    if(t==='nmos'||t==='pmos'){out.push('@'+ref+'[id]','@'+ref+'[ig]','@'+ref+'[is]');continue;}
    if(t==='source'||t==='vcc'){
      var first=ref.charAt(0).toUpperCase();
      out.push((first==='I'||first==='G'||first==='B')?('@'+ref+'[i]'):('i('+ref+')'));
      continue;
    }
    // scr / pwmgen / custom subcircuits: their internal sources are covered by `all`
  }
  return out;
}

function buildSaveLine(){
  var v=buildSaveVectors();
  return '.save all'+(v.length?' '+v.join(' '):'');
}

function generateNetlist(){
  tempNetNamesGen={};
  tempNetCounterGen=0;
  getTempNetName(S.wires.length>0?S.wires[0].id:null);
  var refMap=buildSpiceRefMap();
  var userModels=userDefinedModels();
  var modelNotes={seen:{},lines:[]};
  var lines=[];
  var subcircuits=[];
  var passive=['resistor','capacitor','inductor'];
  var swModels=[];
  var zenerModels=[];   // per-instance .model cards for Z-diodes
  var pwmSubs=[];       // per-instance PWM generator subcircuits
  var scrSubs=[];       // per-instance thyristor subcircuits
  var mcSubs=[];        // per-instance motor-control block subcircuits
  var mosModels=[];     // per-instance .model cards for MOSFETs (sized from Rds(on))
  // Determine which component classes are actually present, so we only emit
  // the default .model card for classes that have at least one instance.
  var present={};
  for(var hi=0;hi<S.components.length;hi++)present[S.components[hi].type]=true;

  lines.push('* SPICE Netlist generated by TurmericLab');
  // .param components: pure directives, no net/device of their own (see the
  // `param` CD entry in js/components.js) — declared up front so any other
  // component's value field can reference "{name}" and have ngspice resolve
  // it. Duplicate names are emitted as-is; ngspice itself will error on that,
  // surfaced through the usual sim log like any other netlist mistake.
  for(var pi=0;pi<S.components.length;pi++){
    var pc=S.components[pi];
    if(pc.type!=='param')continue;
    var pname=(pc.label||'').trim();
    if(!pname)continue;
    lines.push('.param '+pname+'='+((pc.value!=null&&pc.value!=='')?pc.value:'0'));
  }
  if(present.param)lines.push('');
  if(present.sw)lines.push('.model defaultswitch sw vt=1 vh=0.2 ron=1u roff=1e+12');
  if(present.diode||present.led)lines.push('.model defaultdiode D');
  if(present.npn)lines.push('.model npn_default NPN ( IS=1e-14 BF=200 NF=1 VAF=100 IKF=0.3 ISE=1e-13 NE=1.5 BR=5 NR=1 VAR=20 IKR=0.1 ISC=1e-13 NC=2 RE=0.5 RC=0.5 RB=10 CJE=2e-12 VJE=0.75 MJE=0.33 CJC=1e-12 VJC=0.6 MJC=0.33 TF=0.5e-9 TR=50e-9 XTB=1.5 EG=1.11 XTI=3 KF=1e-15 AF=1 )');
  if(present.pnp)lines.push('.model pnp_default PNP ( IS=1e-14 BF=150 NF=1 VAF=80 IKF=0.2 ISE=1e-13 NE=1.5 BR=3 NR=1 VAR=15 IKR=0.08 ISC=1e-13 NC=2 RE=0.6 RC=0.6 RB=12 CJE=2.5e-12 VJE=0.75 MJE=0.33 CJC=1.2e-12 VJC=0.6 MJC=0.33 TF=0.6e-9 TR=60e-9 XTB=1.5 EG=1.11 XTI=3 KF=1e-15 AF=1 )');
  // NOTE: ngspice's VDMOS is a dedicated power-MOSFET level, NOT the generic
  // MOS1/2/3 model - it has its own parameter set. See mosModelCard() below
  // for how each nmos/pmos instance's own .model card is now built (from its
  // Rds(on) property) - there is no shared default card left to emit here.
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
    if(c.type==='transformer'){
      // Two coupled inductors, not a subcircuit: a primary L, a secondary L
      // whose value is derived as {Lprimary*u^2} (u = turns ratio, so it
      // keeps working symbolically if either value references a .param),
      // and a K statement carrying the coupling factor between them.
      var traf=transformerRef(c);
      var tNets=[];
      for(var ti=0;ti<def.pins.length;ti++){
        var ttp=xfPin(def.pins[ti].x,def.pins[ti].y,c.rot||0,c.mirror||false);
        tNets.push(getNetNameWithTempNames(c.x+ttp.x,c.y+ttp.y));
      }
      var lp=c.value||def.val||'1m';
      var uRatio=(c.u!=null&&c.u!=='')?c.u:'1';
      var kCoup=(c.k!=null&&c.k!=='')?c.k:'1';
      lines.push('L'+traf+'P '+tNets[0]+' '+tNets[1]+' '+lp);
      lines.push('L'+traf+'S '+tNets[2]+' '+tNets[3]+' {('+lp+')*('+uRatio+')*('+uRatio+')}');
      lines.push('K'+traf+' L'+traf+'P L'+traf+'S '+kCoup);
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
      // Small-signal AC excitation for a .ac analysis, independent of the
      // transient waveform selected via Mode above (the "AC mag [phase]"
      // spec sits between the DC value and the transient spec in SPICE).
      var acSpec='';
      if(mode!=='BEHAV'&&c.ac_mag!==undefined&&String(c.ac_mag).trim()!==''){
        var acPhase=String(c.ac_phase||'').trim();
        acSpec='AC '+c.ac_mag+(acPhase&&acPhase!=='0'?' '+acPhase:'');
      }
      var line='';
      if(mode==='DC'&&dev.charAt(0)==='B'){
        // Load mode: behavioural current source that only conducts while the +
        // node is above the - node (soft 50 mV knee for the solver's sake), so
        // it can't pull the node negative. Current flows + -> - like an I source.
        var lval=c.value||def.val||'1';
        line=dev+' '+net1+' '+net2+" I = '("+lval+")*min(max(v("+net1+","+net2+")/0.05,0),1)'";
      }else if(mode==='DC'){
        var val=c.value||def.val||'1';
        line=dev+' '+net1+' '+net2+' DC '+val+(acSpec?' '+acSpec:'');
      }else if(mode==='RAMP'){
        var r0=c.ramp_start||'0';
        var r1=c.ramp_end||'1';
        var rtd=c.ramp_tdelay||'0';
        var rdur=c.ramp_duration||'1m';
        // PWL times must strictly increase, so skip the hold point without a delay.
        var hasDelay=String(rtd).trim()!==''&&!/^[+-]?0*\.?0*(e[+-]?\d+)?$/i.test(String(rtd).trim());
        line=dev+' '+net1+' '+net2+(acSpec?' '+acSpec:'')+' PWL(0 '+r0+(hasDelay?' '+rtd+' '+r0:'')+' {('+rtd+')+('+rdur+')} '+r1+')';
      }else if(mode==='AC'){
        var vo=c.ac_offset||'0';
        var va=c.ac_amplitude||'1';
        var freq=c.ac_frequency||'1k';
        var td=c.ac_tdelay||'0';
        var theta=c.ac_theta||'0';
        var phi=c.ac_phi||'0';
        line=dev+' '+net1+' '+net2+(acSpec?' '+acSpec:'')+' SIN('+vo+' '+va+' '+freq+' '+td+' '+theta+' '+phi+')';
      }else if(mode==='PULSE'){
        var v1=c.pulse_vinit||'0';
        var v2=c.pulse_von||'1';
        var td=c.pulse_tdelay||'0';
        var tr=c.pulse_trise||'1e-6';
        var tf=c.pulse_tfall||'1e-6';
        var pw=c.pulse_ton||'1e-3';
        var per=c.pulse_tperiod||'1e-3';
        var np=c.pulse_ncycles||'1';
        line=dev+' '+net1+' '+net2+(acSpec?' '+acSpec:'')+' PULSE('+v1+' '+v2+' '+td+' '+tr+' '+tf+' '+pw+' '+per+' '+np+')';
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
      var model=pickModel(c.model,'defaultswitch',userModels,modelNotes,ref);
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
      var model=pickModel(c.value,c.type==='npn'?'npn_default':'pnp_default',userModels,modelNotes,ref);
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
      var chan=c.type==='nmos'?'NCHAN':'PCHAN';
      // A "Part" name that matches a user-supplied .model/.subckt (typed into
      // the directives box) still wins, same as before. Otherwise each
      // instance gets its own auto-sized model card from its Rds(on) field.
      var partName=String(c.value||'').trim();
      var model;
      if(partName&&userModels[partName.toLowerCase()]){
        model=partName;
      }else{
        model='mos_'+ref.toLowerCase();
        mosModels.push(mosModelCard(model,c,chan));
      }
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
    if(MC_SUBCKT[c.type]){
      var ref=refMap[c.id];
      var subname=c.type+'_'+ref.toLowerCase();
      mcSubs.push(MC_SUBCKT[c.type](subname,c));
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var nn=getNetNameWithTempNames(c.x+tp.x,c.y+tp.y);
        // an unwired pin resolves to the shared fallback "n000" — give it its own
        // node so two open outputs never end up shorted together
        if(nn==='n000')nn='nc_'+ref.toLowerCase()+'_'+def.pins[pi].n.toLowerCase();
        nets.push(nn);
      }
      lines.push(ref+' '+nets.join(' ')+' '+subname);
      continue;
    }
    if(c.type==='diode'||c.type==='led'){
      var ref=refMap[c.id];
      var model=pickModel(c.value,'defaultdiode',userModels,modelNotes,ref);
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
      var subname=customSubcktName(def)||c.type;
      // Port order normally follows def.pins (left column then right column),
      // which is purely cosmetic and freely reorderable in the editor. If a
      // model with a parsed ".subckt NAME p1 p2 ..." header is attached,
      // prefer ITS port order instead (looked up by pin name) so dragging
      // pins around for layout can never desync the positional X-line from
      // the actual subcircuit definition.
      var parsedModel=def._model?parseSubcktHeader(def._model):null;
      // Blank pin rows (deliberate visual gaps, see the pin editor) never
      // correspond to a subcircuit port, so compare against the NAMED pin
      // count only — otherwise a schematic-side spacer row would always
      // defeat this match and silently fall back to visual layout order.
      var namedPinCount=def.pins.filter(function(p){return (p.n||'').trim();}).length;
      var nets=null;
      if(parsedModel&&parsedModel.pins.length===namedPinCount){
        nets=[];
        for(var pn=0;pn<parsedModel.pins.length;pn++){
          var pinIdx=def.pins.findIndex(function(p){return (p.n||'').trim()===parsedModel.pins[pn];});
          if(pinIdx<0){nets=null;break;}
          var tpp=xfPin(def.pins[pinIdx].x,def.pins[pinIdx].y,c.rot||0,c.mirror||false);
          nets.push(getNetNameWithTempNames(c.x+tpp.x,c.y+tpp.y));
        }
      }
      if(!nets){
        nets=[];
        for(var pi=0;pi<def.pins.length;pi++){
          var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
          var px=c.x+tp.x,py=c.y+tp.y;
          nets.push(getNetNameWithTempNames(px,py));
        }
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

  if(modelNotes.lines.length){
    lines.push('');
    for(var mn=0;mn<modelNotes.lines.length;mn++)lines.push(modelNotes.lines[mn]);
  }
  if(zenerModels.length){
    lines.push('');
    lines.push('* Z-diode models');
    for(var zi=0;zi<zenerModels.length;zi++)lines.push(zenerModels[zi]);
  }
  if(mosModels.length){
    lines.push('');
    lines.push('* MOSFET models (auto-sized from Rds(on))');
    for(var mi2=0;mi2<mosModels.length;mi2++)lines.push(mosModels[mi2]);
  }
  for(var si2=0;si2<scrSubs.length;si2++){
    lines.push('');
    for(var sl=0;sl<scrSubs[si2].length;sl++)lines.push(scrSubs[si2][sl]);
  }
  for(var pi2=0;pi2<pwmSubs.length;pi2++){
    lines.push('');
    for(var pl=0;pl<pwmSubs[pi2].length;pl++)lines.push(pwmSubs[pi2][pl]);
  }

  for(var mi3=0;mi3<mcSubs.length;mi3++){
    lines.push('');
    for(var ml=0;ml<mcSubs[mi3].length;ml++)lines.push(mcSubs[mi3][ml]);
  }

  var processedSubcircuits={};
  for(var ci=0;ci<S.components.length;ci++){
    var c=S.components[ci];
    if(c.type.indexOf('custom_')!==0)continue;
    if(processedSubcircuits[c.type])continue;
    processedSubcircuits[c.type]=true;
    var def=CD[c.type];
    var subname=customSubcktName(def)||c.type;
    lines.push('');
    lines.push('* Subcircuit: '+subname);
    if(def._model&&def._model.trim()){
      lines.push(def._model.trim());
    } else {
      var pinList=def.pins.map(function(p){return p.n;}).join(' ');
      lines.push('.subckt '+subname+' '+pinList);
      lines.push('* (subcircuit definition not implemented - user must provide)');
      lines.push('.ends '+subname);
    }
  }

  return lines.join('\n');
}