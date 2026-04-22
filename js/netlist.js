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
    if(c.type==='gnd'||c.type==='vcc'||c.type==='netconn'){
      var tp=xfPin(CD[c.type].pins[0].x,CD[c.type].pins[0].y,c.rot||0,c.mirror||false);
      if(c.x+tp.x===x&&c.y+tp.y===y){
        return c.type==='gnd'?'0':(c.label||c.value);
      }
    }
  }
  var cnt=0;
  for(var wi=0;wi<S.wires.length;wi++){
    var w=S.wires[wi];
    if(!w.points||w.points.length<2)continue;
    var f=w.points[0],l=w.points[w.points.length-1];
    if((f.x===x&&f.y===y)||(l.x===x&&l.y===y))cnt++;
  }
  if(cnt>0)return'N_'+Math.round(x/GRID)+'_'+Math.round(y/GRID);
  return'0';
}

function generateNetlist(){
  var lines=[];
  var passive=['resistor','capacitor','inductor'];
  var counts={vcc:0,source:0};

  for(var ci=0;ci<S.components.length;ci++){
    var c=S.components[ci];
    var def=CD[c.type];
    if(c.type==='vcc'){
      counts.vcc++;
      var ref='V'+counts.vcc;
      var tp=xfPin(def.pins[0].x,def.pins[0].y,c.rot||0,c.mirror||false);
      var px=c.x+tp.x,py=c.y+tp.y;
      var netName=getNetName(px,py);
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
      var net1=getNetName(px1,py1);
      var net2=getNetName(px2,py2);
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
    if(passive.indexOf(c.type)<0)continue;
    var ref=c.label||'';
    var nets=[];
    for(var pi=0;pi<def.pins.length;pi++){
      var tp=xfPin(def.pins[pi].x,def.pins[pi].y,c.rot||0,c.mirror||false);
      var px=c.x+tp.x,py=c.y+tp.y;
      var netName=getNetName(px,py);
      nets.push(netName);
    }
    var val=c.value||def.val;
    var line=ref+' '+nets[0]+' '+nets[1]+' '+val;
    lines.push(line);
  }
  return lines.join('\n');
}