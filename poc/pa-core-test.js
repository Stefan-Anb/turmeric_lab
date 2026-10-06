// Validation of js/power-analyzer-core.js against the reference cases of
// PLAN-LEISTUNGSANALYSATOR.md (chapter 3.10). Synthetic signals only, no
// ngspice. Run with:  node poc/pa-core-test.js
var PA=require('../js/power-analyzer-core.js');

var fails=0,checks=0;
function near(name,got,exp,tol){
  checks++;
  var ok=isFinite(got)&&Math.abs(got-exp)<=tol;
  if(!ok)fails++;
  console.log((ok?'  ok   ':'  FAIL ')+name+': '+(typeof got==='number'?got.toPrecision(6):got)+' (erwartet '+exp+' ±'+tol+')');
}
function eq(name,got,exp){
  checks++;
  var ok=got===exp;
  if(!ok)fails++;
  console.log((ok?'  ok   ':'  FAIL ')+name+': '+got+(ok?'':' (erwartet '+exp+')'));
}

var F=50,FS=100e3,T=0.2;
function rec(fnU,fnI){
  var n=Math.round(T*FS)+1,r=PA.makeRecord(0,1/FS,n);
  for(var e=0;e<4;e++){
    if(!fnU[e])continue;
    r.u[e]=new Float64Array(n);r.i[e]=new Float64Array(n);
    for(var k=0;k<n;k++){var t=k/FS;r.u[e][k]=fnU[e](t);r.i[e][k]=fnI[e](t);}
  }
  return r;
}
function run(cfg,r){
  var ins=new PA.Instrument(cfg);
  ins.run(r);
  return ins.history[ins.history.length-1];
}
var w=2*Math.PI*F,A=230*Math.SQRT2;
function sin(amp,ph){return function(t){return amp*Math.sin(w*t+ph);};}

console.log('1) Sinus 230 V an 52,9 Ohm');
var R=52.9;
var h=run({wiring:'1P2W',elements:[{u:{id:'a'},i:{id:'b'}}],avg:{mode:'off'}},rec([sin(A,0)],[sin(A/R,0)]));
var v=h.values;
near('Urms',v['Urms:1'],230,1e-3);
near('P',v['P:1'],230*230/R,0.01);
near('λ',v['lambda:1'],1,1e-6);
near('CfU',v['CfU:1'],Math.SQRT2,1e-4);
near('FfU',v['FfU:1'],Math.PI/(2*Math.SQRT2),1e-4);
near('Umn',v['Umn:1'],230,0.01);
near('fU',v['fU:1'],50,1e-3);
near('fSync',v['fSync:S'],50,1e-6);

console.log('2) RL-Last, ωL = R (Strom eilt 45° nach)');
h=run({wiring:'1P2W',elements:[{u:{id:'a'},i:{id:'b'}}],avg:{mode:'off'}},rec([sin(A,0)],[sin(A/(R*Math.SQRT2),-Math.PI/4)]));
v=h.values;
near('φ',v['phi:1'],45,1e-3);
near('Q = P',v['Q:1']-v['P:1'],0,1e-6*v['P:1']);
near('φ(1)',v['phi1:1'],45,1e-3);

console.log('3) RC-Last (Strom eilt 45° vor)');
h=run({wiring:'1P2W',elements:[{u:{id:'a'},i:{id:'b'}}],avg:{mode:'off'}},rec([sin(A,0)],[sin(A/(R*Math.SQRT2),Math.PI/4)]));
v=h.values;
near('φ',v['phi:1'],-45,1e-3);
checks++;if(!(v['Q:1']<0)){fails++;console.log('  FAIL Q negativ');}else console.log('  ok   Q negativ: '+v['Q:1'].toPrecision(6));
h=run({wiring:'1P2W',elements:[{u:{id:'a'},i:{id:'b'}}],avg:{mode:'off'},lambdaSign:true},rec([sin(A,0)],[sin(A/(R*Math.SQRT2),Math.PI/4)]));
near('λ mit Vorzeichen (Hioki)',h.values['lambda:1'],-Math.SQRT1_2,1e-6);

console.log('4) Verzerrter Strom (Grundschwingung + 3. Harmonische 50 %)');
h=run({wiring:'1P2W',elements:[{u:{id:'a'},i:{id:'b'}}],avg:{mode:'off'}},
  rec([sin(A,0)],[function(t){return 10*Math.sin(w*t)+5*Math.sin(3*w*t);}]));
v=h.values;
near('THD I',v['THDI:1'],50,1e-3);
near('Irms',v['Irms:1'],Math.sqrt(50+12.5),1e-6);
near('P (nur Grundschwingung trägt)',v['P:1'],230*10/Math.SQRT2,1e-3);
checks++;if(!(v['D:1']>0&&v['lambda:1']<v['cosphi1:1'])){fails++;console.log('  FAIL D>0, λ<cosφ1');}
else console.log('  ok   D = '+v['D:1'].toPrecision(5)+' var, λ = '+v['lambda:1'].toFixed(4)+' < cos φ(1) = '+v['cosphi1:1'].toFixed(4));

console.log('5) Symmetrische Drehstromlast 3P4W, φ = 30°');
var ph=[0,-2*Math.PI/3,2*Math.PI/3],I=10,phi=Math.PI/6;
var r3=rec(ph.map(function(p){return sin(A,p);}),ph.map(function(p){return sin(I*Math.SQRT2,p-phi);}));
var cfg3=function(wr,sq){
  return {wiring:wr,sq:sq||'TYPE1',avg:{mode:'off'},elements:[{u:{id:1},i:{id:2}},{u:{id:1},i:{id:2}},{u:{id:1},i:{id:2}}]};
};
h=run(cfg3('3P4W'),r3);v=h.values;
var Pref=3*230*I*Math.cos(phi);
near('PΣ',v['P:S'],Pref,0.01);
near('SΣ',v['S:S'],3*230*I,0.01);
near('φΣ',v['phi:S'],30,1e-3);
near('U12',v['U12:S'],230*Math.sqrt(3),1e-3);
near('Unsymmetrie U',v['uU2:S'],0,1e-6);
near('IN',v['IX:S'],0,1e-6);
eq('Drehfeld',v['rot:S'],'clockwise (L1-L2-L3)');
h=run(cfg3('3P4W','IEEE1459'),r3);
near('Se (IEEE 1459) = 3UI bei Symmetrie',h.values['S:S'],3*230*I,0.01);

console.log('6) Dieselbe Last in 3P3W (Aron) und 3V3A');
// line voltages from the phase voltages of case 5
function lv(a,b){return function(t){return A*Math.sin(w*t+ph[a])-A*Math.sin(w*t+ph[b]);};}
function ic(k){return sin(I*Math.SQRT2,ph[k]-phi);}
h=run({wiring:'3P3W',avg:{mode:'off'},elements:[{u:{id:1},i:{id:1}},{u:{id:1},i:{id:1}}]},rec([lv(0,2),lv(1,2)],[ic(0),ic(1)]));
v=h.values;
near('PΣ (Aron)',v['P:S'],Pref,0.01);
near('SΣ = √3/2 (S1+S2)',v['S:S'],3*230*I,0.01);
near('φΣ',v['phi:S'],30,1e-3);
near('I3 berechnet',v['IX:S'],I,1e-6);
near('U1N virtueller Sternpunkt',v['UY1:S'],230,1e-3);
checks++;if(Math.abs(v['P:1']-v['P:2'])<1){fails++;console.log('  FAIL P1 ≠ P2 erwartet');}else console.log('  ok   P1 = '+v['P:1'].toFixed(1)+' W, P2 = '+v['P:2'].toFixed(1)+' W (verschieden bei φ ≠ 0)');
h=run({wiring:'3V3A',avg:{mode:'off'},elements:[{u:{id:1},i:{id:1}},{u:{id:1},i:{id:1}},{u:{id:1},i:{id:1}}]},rec([lv(0,2),lv(1,2),lv(0,1)],[ic(0),ic(1),ic(2)]));
v=h.values;
near('PΣ 3V3A',v['P:S'],Pref,0.01);
near('SΣ = √3/3 (S1+S2+S3)',v['S:S'],3*230*I,0.01);

console.log('7) Unsymmetrische Last 3P4W (I2 = 5 A, I3 = 15 A)');
var Is=[10,5,15];
h=run(cfg3('3P4W'),rec(ph.map(function(p){return sin(A,p);}),ph.map(function(p,k){return sin(Is[k]*Math.SQRT2,p);})));
v=h.values;
checks++;if(!(v['uI2:S']>0)){fails++;console.log('  FAIL i2>0');}else console.log('  ok   Unsymmetrie I = '+v['uI2:S'].toFixed(3)+' %');
var hI=run(cfg3('3P4W','IEEE1459'),rec(ph.map(function(p){return sin(A,p);}),ph.map(function(p,k){return sin(Is[k]*Math.SQRT2,p);})));
checks++;if(!(hI.values['S:S']>v['S:S'])){fails++;console.log('  FAIL Se > SΣ arithm.');}
else console.log('  ok   Se = '+hI.values['S:S'].toFixed(1)+' VA > SΣ = '+v['S:S'].toFixed(1)+' VA');

console.log('8) DC-Kanal 4 und Wirkungsgrad');
var r8=rec([sin(A,0),null,null,function(){return 400;}],[sin(A/R,0),null,null,function(){return 230*230/R*0.95/400;}]);
h=run({wiring:'1P2W',eta:'4/G',avg:{mode:'off'},sync:{src:'U1'},elements:[{u:{id:1},i:{id:1}},{},{},{u:{id:1},i:{id:1}}]},r8);
near('η = P4/PΣ',h.values['eta:S'],95,1e-3);
near('Udc Kanal 4',h.values['Udc:4'],400,1e-9);

console.log('9) Mittelung exponentiell K=8 bei Amplitudensprung');
var rj=rec([function(t){return (t<0.1?100:200)*Math.SQRT2*Math.sin(w*t);}],[sin(1,0)]);
var ins=new PA.Instrument({wiring:'1P2W',avg:{mode:'exp',K:8},elements:[{u:{id:1},i:{id:1}}]});
ins.run(rj);
var hs=ins.history;
var j=hs.findIndex(function(x){return x.ta>=0.1-1e-9;});
near('erster Wert nach Sprung = D+(M-D)/8',hs[j].values['Urms:1'],100+(200-100)/8,1e-3);
var nAfter=hs.length-j;
near('nach '+nAfter+' Intervallen: 200-100·(7/8)^N',hs[hs.length-1].values['Urms:1'],200-100*Math.pow(7/8,nAfter),1e-3);

console.log('10) Keine Sync (DC): feste Fenster');
var r10=rec([function(){return 12;}],[function(){return 2;}]);
h=run({wiring:'1P2W',avg:{mode:'off'},update:{mode:'auto',time:0.05},elements:[{u:{id:1},i:{id:1}}]},r10);
near('P DC',h.values['P:1'],24,1e-9);
eq('sync',h.sync,'none');

console.log('11) Harmonische: I = 10 A(1) + 5 A(3) + 2 A(5), U mit 3 % 3. Harmonischer');
var sq2=Math.SQRT2;
var r11=rec([function(t){return A*Math.sin(w*t)+0.03*A*Math.sin(3*w*t);}],
  [function(t){return sq2*(10*Math.sin(w*t)+5*Math.sin(3*w*t+0.5)+2*Math.sin(5*w*t));}]);
h=run({wiring:'1P2W',avg:{mode:'off'},harm:{enabled:true,order:50},elements:[{u:{id:1},i:{id:1}}]},r11);
var hi=PA.harmonics(h.prim,'I',0),hu=PA.harmonics(h.prim,'U',0),hp=PA.harmonics(h.prim,'P',0);
near('I(1)',hi.mag[1],10,1e-3);
near('I(3)',hi.mag[3],5,1e-3);
near('I(5)',hi.mag[5],2,1e-3);
near('I(7) leer',hi.mag[7],0,1e-3);
near('I(3) in %',hi.pct[3],50,1e-2);
near('THD I aus Harmonischen',h.values['THDI:1'],Math.sqrt(29)/10*100,1e-2);
// Konvention: φ(k) − k·φ(1) mit Kosinus-Bezug. Grundschwingung sin(ωt) liegt
// bei −90°, also gilt für sin(3ωt+0.5): (0.5 rad − 90°) − 3·(−90°) = 0.5 rad + 180°.
near('Phase I(3) = φ(3) − 3·φ(1)',hi.deg[3],0.5*180/Math.PI-180,0.05);
near('P(3) = U3·I3·cos(φ3)',hp.mag[3],0.03*230*5*Math.cos(0.5),0.01);
near('P = Σ P(k)',h.values['P:1'],230*10+0.03*230*5*Math.cos(0.5),0.05);

console.log('12) Energie-Integration');
h=run({wiring:'1P2W',avg:{mode:'off'},update:{mode:'auto',time:0.05},elements:[{u:{id:1},i:{id:1}}]},r10);
near('WP DC 24 W · 0,2 s',h.values['WP:1'],24*0.2/3600,1e-12);
near('WP− = 0',h.values['WPn:1'],0,1e-15);
near('q 2 A · 0,2 s',h.values['q:1'],0.4/3600,1e-12);
near('Integrationszeit',h.values['ITime:S'],0.2,1e-9);
h=run({wiring:'1P2W',avg:{mode:'off'},elements:[{u:{id:'a'},i:{id:'b'}}]},rec([sin(A,0)],[sin(A/R,0)]));
near('WP Sinus 1000 W bis Intervallende',h.values['WP:1'],1000*h.values['ITime:S']/3600,1e-6);
near('q Sinus ≈ 0',h.values['q:1'],0,1e-9);

console.log('13) Quadratische RMS-Mittelung');
ins=new PA.Instrument({wiring:'1P2W',avg:{mode:'exp',K:8,rmsQuad:true},elements:[{u:{id:1},i:{id:1}}]});
ins.run(rj);hs=ins.history;
j=hs.findIndex(function(x){return x.ta>=0.1-1e-9;});
near('sqrt(100² + (200²-100²)/8)',hs[j].values['Urms:1'],Math.sqrt(100*100+(200*200-100*100)/8),1e-3);

console.log('14) Realistischer Eingang (ADC)');
ins=new PA.Instrument({wiring:'1P2W',avg:{mode:'off'},adc:{enabled:true,bits:8,bw:0,noise:0},elements:[{u:{id:'a'},i:{id:'b'}}]});
ins.run(rec([sin(A,0)],[sin(A/R,0)]));
var lsb=ins.prep.adc.lsbU[0],qok=true;
for(var k=0;k<ins.prep.n;k++){var qv=ins.prep.u[0][k]/lsb;if(Math.abs(qv-Math.round(qv))>1e-6){qok=false;break;}}
eq('Bereich (auto)',ins.prep.adc.u[0],500);
eq('Samples auf LSB-Raster (8 bit, '+lsb.toFixed(2)+' V)',qok,true);
near('Urms trotz 8 bit',ins.history.at(-1).values['Urms:1'],230,1.0);
ins=new PA.Instrument({wiring:'1P2W',avg:{mode:'off'},tStart:0.1,adc:{enabled:true,bits:24,bw:50,noise:0},elements:[{u:{id:'a'},i:{id:'b'}}]});
ins.run(rec([sin(A,0)],[sin(A/R,0)]));
near('Bandbreite 50 Hz: Urms = 230/√2',ins.history.at(-1).values['Urms:1'],230/Math.SQRT2,0.05);
ins=new PA.Instrument({wiring:'1P2W',avg:{mode:'off'},adc:{enabled:true,bits:16,bw:0,noise:2},elements:[{u:{id:'a'},i:{id:'b'}}]});
ins.run(rec([sin(A,0)],[sin(A/R,0)]));
var ins2=new PA.Instrument({wiring:'1P2W',avg:{mode:'off'},adc:{enabled:true,bits:16,bw:0,noise:2},elements:[{u:{id:'a'},i:{id:'b'}}]});
ins2.run(rec([sin(A,0)],[sin(A/R,0)]));
eq('Rauschen reproduzierbar',ins.history.at(-1).values['Urms:1'],ins2.history.at(-1).values['Urms:1']);

console.log('15) attach(): Historie aus einem Worker übernehmen');
var r15=rec([sin(A,0)],[sin(A/R,0)]),cfg15={wiring:'1P2W',avg:{mode:'off'},elements:[{u:{id:'a'},i:{id:'b'}}]};
var insW=new PA.Instrument(cfg15);insW.run(r15);
var hist=JSON.parse(JSON.stringify(insW.history.map(function(x){return {t:x.t,ta:x.ta,tb:x.tb,values:x.values};})));
var insM=new PA.Instrument(cfg15).attach(r15,hist,{});
near('resultAt nach attach',insM.resultAt(0.2).values['P:1'],1000,0.01);
near('sampleAt nach attach',insM.sampleAt(0.005)['u:1'],A,0.01);

console.log('\n'+(checks-fails)+'/'+checks+' Prüfungen bestanden');
if(typeof process!=='undefined')process.exit(fails?1:0);
