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

function generateNetlist(){
  tempNetNamesGen={};
  tempNetCounterGen=0;
  getTempNetName(S.wires.length>0?S.wires[0].id:null);
  var lines=[];
  var subcircuits=[];
  var passive=['resistor','capacitor','inductor'];
  var swModels=[];
  var counts={vcc:0,source:0};
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
      counts.vcc++;
      var ref='V'+counts.vcc;
      var tp=xfPin(def.pins[0].x,def.pins[0].y,c.rot||0,c.mirror||false);
      var px=c.x+tp.x,py=c.y+tp.y;
      var netName=getNetNameWithTempNames(px,py);
      var voltage=c.value||def.val||'5V';
      var line=ref+' '+netName+' 0 DC '+voltage;
      lines.push(line);
      continue;
    }
    if(c.type==='source'){
      counts.source++;
      var ref=c.label||'SRC'+counts.source;
      var mode=c.mode||'DC';
      var meas=c.meas||'V';
      var prefix=meas==='I'?'I':'V';
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
        line=prefix+ref+' '+net1+' '+net2+' DC '+val;
      }else if(mode==='AC'){
        var vo=c.ac_offset||'0';
        var va=c.ac_amplitude||'1';
        var freq=c.ac_frequency||'1k';
        var td=c.ac_tdelay||'0';
        var theta=c.ac_theta||'0';
        var phi=c.ac_phi||'0';
        line=prefix+ref+' '+net1+' '+net2+' SIN('+vo+' '+va+' '+freq+' '+td+' '+theta+' '+phi+')';
      }else if(mode==='PULSE'){
        var v1=c.pulse_vinit||'0';
        var v2=c.pulse_von||'1';
        var td=c.pulse_tdelay||'0';
        var tr=c.pulse_trise||'1e-6';
        var tf=c.pulse_tfall||'1e-6';
        var pw=c.pulse_ton||'1e-3';
        var per=c.pulse_tperiod||'1e-3';
        var np=c.pulse_ncycles||'1';
        line=prefix+ref+' '+net1+' '+net2+' PULSE('+v1+' '+v2+' '+td+' '+tr+' '+tf+' '+pw+' '+per+' '+np+')';
      }else if(mode==='BEHAV'){
        var eq=c.beh_eq||'0';
        var behPrefix=meas==='I'?'G':'E';
        line=behPrefix+ref+' '+net1+' '+net2+' cur = \''+eq+'\'';
      }
      lines.push(line);
      continue;
    }
    if(c.type==='gnd')continue;
    if(c.type==='sw'){
      var ref=c.label||'';
      var model=c.model||'defaultswitch';
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line='S'+ref+' '+nets[0]+' '+nets[1]+' '+nets[3]+' '+nets[2]+' '+model;
      lines.push(line);
      continue;
    }
    if(c.type==='npn'||c.type==='pnp'){
      var ref=c.label||'';
      var model=c.value||(c.type==='npn'?'npn_default':'pnp_default');
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line='Q'+ref+' '+nets[1]+' '+nets[0]+' '+nets[2]+' '+model;
      lines.push(line);
      continue;
    }
    if(c.type==='nmos'||c.type==='pmos'){
      var ref=c.label||'';
      var model=c.value||(c.type==='nmos'?'mos_n_default':'mos_p_default');
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line='M'+ref+' '+nets[1]+' '+nets[0]+' '+nets[2]+' '+model;
      lines.push(line);
      continue;
    }
    if(c.type==='diode'||c.type==='led'){
      var ref=c.label||'';
      var model=c.value||'defaultdiode';
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line='D'+ref+' '+nets[0]+' '+nets[1]+' '+model;
      lines.push(line);
      continue;
    }
    if(c.type.indexOf('custom_')===0){
      var ref=c.label||'';
      var subname=def._name||def.lbl||c.type;
      var nets=[];
      for(var pi=0;pi<def.pins.length;pi++){
        var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
        var px=c.x+tp.x,py=c.y+tp.y;
        var netName=getNetNameWithTempNames(px,py);
        nets.push(netName);
      }
      var line='X'+ref+' '+nets.join(' ')+' '+subname;
      lines.push(line);
      continue;
    }
    if(passive.indexOf(c.type)<0)continue;
    var ref=c.label||'';
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