// ═══════════════════════════════════════════════════
// POWER ANALYZER PA-4: MEASUREMENT CORE
//
// Pure math + instrument state of a 4-element power analyzer (three-phase
// group 1..3 plus an independent element 4). No DOM and no TurmericLab
// globals: this file runs unchanged in a page, a Worker or Node, so the same
// core can later sit behind a hardware data source. Theory, formulas and the
// manufacturer references (Yokogawa WT series, Hioki PW3390, IEEE 1459) are
// collected in PLAN-LEISTUNGSANALYSATOR.md.
//
// Data flow:
//   record (uniformly sampled u/i per element, see makeRecord)
//     -> Instrument.run() / append()+flush()
//     -> measurement intervals (synchronised to whole periods of the sync
//        source, or fixed update windows)
//     -> raw primitives per interval (rms, dc, mean, peaks, P, S, Q,
//        fundamental phasors, virtual line/phase quantities)
//     -> averaging (exponential / moving, Yokogawa style)
//     -> derived display values incl. Σ functions  -> instrument.history[]
//
// Result naming contract (also what a hardware source would deliver):
// values['<quantity>:<col>'], col = '1'..'4' for the elements, 'S' for Σ.
// The quantity keys are listed in PA.QUANTITIES.
// ═══════════════════════════════════════════════════
(function(root){
'use strict';

var PA=root.PowerAnalyzer=root.PowerAnalyzer||{};
PA.version='1.0';

var NEL=4;
var MN_CAL=Math.PI/(2*Math.SQRT2);   // rectified mean -> rms of a sine (≈1.1107)
var DEG=180/Math.PI;
var SQ3=Math.sqrt(3);

// ─── Wiring systems ───
// group: element indices (0-based) forming the Σ group. Element mapping for
// the three-wire systems follows Hioki 3P3W2M (Aron pair on elements 1 and
// 2), see plan chapter 3.5.1:
//   3P3W: e1 = u13/i1, e2 = u23/i2, (e3 computed: u12, i3 = -(i1+i2))
//   3V3A: e1 = u13/i1, e2 = u23/i2, e3 = u12/i3
//   3P4W: e1..e3 = u1N..u3N / i1..i3
var WIRINGS={
  '1P2W':{label:'1P2W · 4× single-phase',group:[]},
  '3P4W':{label:'3P4W · star with N',group:[0,1,2],wires:4},
  '3P3W':{label:'3P3W · Aron (2 wattmeters)',group:[0,1],wires:3},
  '3V3A':{label:'3V3A · 3 voltages, 3 currents',group:[0,1,2],wires:3}
};
PA.WIRINGS=WIRINGS;

// What each element's inputs mean in a wiring system (UI help text).
PA.elementRole=function(wiring,e){
  var r={
    '1P2W':['u, i','u, i','u, i','u, i'],
    '3P4W':['u1N (L1-N), i1','u2N (L2-N), i2','u3N (L3-N), i3','u, i (independent)'],
    '3P3W':['u13 (L1-L3), i1','u23 (L2-L3), i2','unused (computed: u12, i3)','u, i (independent)'],
    '3V3A':['u13 (L1-L3), i1','u23 (L2-L3), i2','u12 (L1-L2), i3','u, i (independent)']
  }[wiring]||[];
  return r[e]||'u, i';
};

// Is element e (0-based) a measured input in this wiring? (3P3W leaves e3 out.)
PA.elementUsed=function(wiring,e){return !(wiring==='3P3W'&&e===2);};

// ─── Quantity catalogue ───
// [group, key, label, unit, level, cols]
//   level: 1 basic, 2 extended, 3 all
//   cols : 'E' element columns only, 'ES' elements + Σ, 'S' Σ column only,
//          'M' instantaneous (cursor) values, element columns + Σ
var QDEF=[
  ['U','Urms','Urms','V',1,'ES'],['U','Umn','Umn','V',2,'E'],['U','Udc','Udc','V',1,'E'],
  ['U','Urmn','Urmn','V',3,'E'],['U','Uac','Uac','V',2,'E'],['U','Upkp','U+pk','V',2,'E'],
  ['U','Upkm','U−pk','V',2,'E'],['U','CfU','CfU','',2,'E'],['U','FfU','FfU','',3,'E'],
  ['U','fU','fU','Hz',1,'E'],['U','Urf','Urf (ripple)','%',3,'E'],
  ['I','Irms','Irms','A',1,'ES'],['I','Imn','Imn','A',2,'E'],['I','Idc','Idc','A',1,'E'],
  ['I','Irmn','Irmn','A',3,'E'],['I','Iac','Iac','A',2,'E'],['I','Ipkp','I+pk','A',2,'E'],
  ['I','Ipkm','I−pk','A',2,'E'],['I','CfI','CfI','',2,'E'],['I','FfI','FfI','',3,'E'],
  ['I','fI','fI','Hz',2,'E'],['I','Irf','Irf (ripple)','%',3,'E'],
  ['P','P','P','W',1,'ES'],['P','S','S','VA',1,'ES'],['P','Q','Q','var',1,'ES'],
  ['P','lambda','λ','',1,'ES'],['P','phi','φ','°',1,'ES'],
  ['P','Ppkp','P+pk','W',3,'E'],['P','Ppkm','P−pk','W',3,'E'],
  ['F','U1','U(1)','V',2,'E'],['F','I1','I(1)','A',2,'E'],['F','phi1','φ(1)','°',2,'E'],
  ['F','P1','P(1)','W',2,'ES'],['F','Q1','Q(1)','var',2,'ES'],['F','S1','S(1)','VA',3,'E'],
  ['F','cosphi1','cos φ(1)','',2,'E'],['F','THDU','THD U','%',2,'E'],['F','THDI','THD I','%',2,'E'],
  ['F','D','D (distortion)','var',3,'E'],
  ['3','fSync','f (Sync)','Hz',1,'S'],
  ['3','U12','U12','V',1,'S'],['3','U23','U23','V',1,'S'],['3','U31','U31','V',1,'S'],
  ['3','UY1','U1N','V',2,'S'],['3','UY2','U2N','V',2,'S'],['3','UY3','U3N','V',2,'S'],
  ['3','IX','I3 / IN (computed)','A',2,'S'],
  ['3','Ue','Ue (IEEE 1459)','V',2,'S'],['3','Ie','Ie (IEEE 1459)','A',2,'S'],['3','Se','Se (IEEE 1459)','VA',2,'S'],
  ['3','Upos','U+ (positive seq.)','V',2,'S'],['3','Uneg','U− (negative seq.)','V',2,'S'],['3','U0','U0 (zero seq.)','V',3,'S'],
  ['3','uU2','Unbalance U','%',1,'S'],['3','uI2','Unbalance I','%',2,'S'],['3','UunbIEC','Unbalance U (IEC)','%',3,'S'],
  ['3','rot','Phase sequence','',1,'S'],
  ['E','eta','η','%',1,'S'],['E','Pv','Pv (loss)','W',1,'S'],
  ['W','ITime','Integration time','s',1,'S'],
  ['W','WP','WP','Wh',1,'ES'],['W','WPp','WP+','Wh',2,'ES'],['W','WPn','WP−','Wh',2,'ES'],
  ['W','q','q','Ah',2,'E'],['W','qp','q+','Ah',3,'E'],['W','qn','q−','Ah',3,'E'],
  ['M','u','u(t)','V',1,'E'],['M','i','i(t)','A',1,'E'],['M','p','p(t)','W',1,'ES']
];
PA.QUANTITIES=QDEF.map(function(q){return {group:q[0],key:q[1],label:q[2],unit:q[3],level:q[4],cols:q[5]};});
PA.GROUPS=[
  {id:'M',label:'Waveform (instantaneous)'},{id:'U',label:'Voltage'},{id:'I',label:'Current'},
  {id:'P',label:'Power'},{id:'F',label:'Fundamental'},{id:'3',label:'Three-phase'},{id:'E',label:'Efficiency'},
  {id:'W',label:'Integration (energy)'}
];
PA.quantity=function(key){
  for(var i=0;i<PA.QUANTITIES.length;i++)if(PA.QUANTITIES[i].key===key)return PA.QUANTITIES[i];
  return null;
};

// ─── Configuration ───
function defaultElement(){
  return {u:null,i:null,uScale:1,iScale:1,iInvert:false,uRange:'auto',iRange:'auto'};
}
PA.defaultConfig=function(){
  return {
    wiring:'1P2W',
    // u/i: opaque source references {id,label}, resolved by the data source
    elements:[defaultElement(),defaultElement(),defaultElement(),defaultElement()],
    // src: 'U1'..'U4' | 'I1'..'I4' | 'fixed' | 'none'
    sync:{src:'U1',coupling:'ac',hyst:0.05,filter:false,filterHz:1000,freq:50},
    // mode 'auto': every `periods` whole periods; 'time': fixed update window
    update:{mode:'auto',periods:1,time:0.1},
    // rmsQuad: average rms values as squares (physically exact) instead of
    // linearly like the instruments do
    avg:{mode:'exp',K:8,m:16,rmsQuad:false},
    sq:'TYPE1',         // TYPE1 | TYPE2 | TYPE3 | IEEE1459 (Σ formula for S and Q)
    sBase:'rms',        // S = Urms·Irms ('rms') or Umn·Irms ('mn')
    lambdaSign:false,   // λ with lead/lag sign (Hioki style)
    crest:3,            // crest factor of the ranges (peak ≤ crest·range)
    eta:'off',          // 'off' | 'G/4' (η = PΣ/P4, inverter) | '4/G' (η = P4/PΣ, rectifier)
    tStart:0,           // evaluation starts here (skip start-up transients)
    fs:'auto',          // sampling rate the data source should deliver
    // harmonics: PLL resampling of every synchronised interval, DFT up to `order`
    harm:{enabled:true,order:50},
    // energy integration from `start` (null = tStart) to each display update
    integ:{start:null},
    // "realistic" input stage: first-order bandwidth limit, ADC quantisation
    // over ±crest·range, gaussian noise (rms in LSB), clipping above full scale
    adc:{enabled:false,bits:16,bw:0,noise:0}
  };
};
function mergeInto(dst,src){
  if(!src||typeof src!=='object')return dst;
  for(var k in src){
    if(!Object.prototype.hasOwnProperty.call(src,k))continue;
    var v=src[k];
    if(Array.isArray(v)&&Array.isArray(dst[k])){
      for(var j=0;j<v.length&&j<dst[k].length;j++){
        if(v[j]&&typeof v[j]==='object'&&dst[k][j]&&typeof dst[k][j]==='object')mergeInto(dst[k][j],v[j]);
        else dst[k][j]=v[j];
      }
    }else if(v&&typeof v==='object'&&!Array.isArray(v)&&dst[k]&&typeof dst[k]==='object'&&!('id' in v&&'label' in v)){
      mergeInto(dst[k],v);
    }else dst[k]=v;
  }
  return dst;
}
// Fill a (possibly partial / older) config with defaults. Returns a new object.
PA.normalizeConfig=function(cfg){
  var d=PA.defaultConfig();
  mergeInto(d,JSON.parse(JSON.stringify(cfg||{})));
  if(!WIRINGS[d.wiring])d.wiring='1P2W';
  return d;
};

// ─── Ranges (1-2-5 series) ───
var RANGE_STEPS=[1,2,5];
function rangeList(lo,hi){
  var out=[];
  for(var dec=Math.floor(Math.log10(lo));dec<=Math.ceil(Math.log10(hi));dec++)
    for(var s=0;s<RANGE_STEPS.length;s++){
      var r=RANGE_STEPS[s]*Math.pow(10,dec);
      if(r>=lo*0.999&&r<=hi*1.001)out.push(+r.toPrecision(3));
    }
  return out;
}
PA.U_RANGES=rangeList(0.001,10000);
PA.I_RANGES=rangeList(0.0001,10000);

// ─── Record helpers ───
// A record is uniformly sampled: sample n is at t0 + n·dt.
//   {t0, dt, n, u:[Float64Array|null ×4], i:[Float64Array|null ×4]}
PA.makeRecord=function(t0,dt,n){
  return {t0:t0,dt:dt,n:n,u:[null,null,null,null],i:[null,null,null,null]};
};

// Linear resampling of a non-uniform (t ascending) series onto t0 + k·dt.
// ngspice interpolates linearly between its own time points as well, so this
// introduces no error beyond what the simulator already assumes.
PA.resampleLinear=function(t,y,t0,dt,n,out){
  out=out||new Float64Array(n);
  var m=t.length;
  if(m===0){out.fill(NaN);return out;}
  if(m===1){out.fill(y[0]);return out;}
  var j=0;
  for(var k=0;k<n;k++){
    var tk=t0+k*dt;
    while(j<m-2&&t[j+1]<tk)j++;
    var ta=t[j],tb=t[j+1];
    var f=tb>ta?(tk-ta)/(tb-ta):0;
    if(f<0)f=0;else if(f>1)f=1;
    out[k]=y[j]+(y[j+1]-y[j])*f;
  }
  return out;
};

// ─── Complex helpers (phasors as {re,im}, rms scaled) ───
function cx(re,im){return {re:re,im:im};}
function cadd(a,b){return cx(a.re+b.re,a.im+b.im);}
function csub(a,b){return cx(a.re-b.re,a.im-b.im);}
function cscale(a,k){return cx(a.re*k,a.im*k);}
function cmul(a,b){return cx(a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re);}
function cabs(a){return Math.sqrt(a.re*a.re+a.im*a.im);}
function carg(a){return Math.atan2(a.im,a.re);}
function cok(a){return a&&isFinite(a.re)&&isFinite(a.im);}
var A120=cx(-0.5,SQ3/2), A240=cx(-0.5,-SQ3/2);
function wrapDeg(d){d=((d+180)%360+360)%360-180;return d===-180?180:d;}
PA.complex={add:cadd,sub:csub,scale:cscale,mul:cmul,abs:cabs,arg:carg};

// ∫_a^b of the hat function centred on n (width ±1): the weight of sample n
// in the integral of the linear interpolant over [a,b] (index units).
function hatW(n,a,b){
  var w=0,lo,hi,p,q;
  lo=Math.max(a,n-1);hi=Math.min(b,n);
  if(hi>lo){p=lo-n+1;q=hi-n+1;w+=(q*q-p*p)/2;}
  lo=Math.max(a,n);hi=Math.min(b,n+1);
  if(hi>lo){p=1-(lo-n);q=1-(hi-n);w+=(p*p-q*q)/2;}
  return w;
}

// Interval geometry: sample weights for [ta,tb] plus the fundamental's
// cos/sin tables when `periods` whole periods fit into the interval.
function intervalFrame(rec,ta,tb,periods){
  var fa=(ta-rec.t0)/rec.dt,fb=(tb-rec.t0)/rec.dt;
  if(fa<0)fa=0;
  if(fb>rec.n-1)fb=rec.n-1;
  if(!(fb>fa))return null;
  var n0=Math.max(0,Math.floor(fa)),n1=Math.min(rec.n-1,Math.ceil(fb));
  var len=n1-n0+1;
  var w=new Float64Array(len),W=0;
  for(var k=0;k<len;k++){
    var n=n0+k;
    var wk=(n-1>=fa&&n+1<=fb)?1:hatW(n,fa,fb);
    w[k]=wk;W+=wk;
  }
  var cs=null,sn=null;
  if(periods>0){
    cs=new Float64Array(len);sn=new Float64Array(len);
    var om=2*Math.PI*periods/(fb-fa);
    for(var k2=0;k2<len;k2++){
      var th=om*(n0+k2-fa);
      cs[k2]=Math.cos(th);sn[k2]=Math.sin(th);
    }
  }
  return {fa:fa,fb:fb,n0:n0,len:len,w:w,W:W,cs:cs,sn:sn,
    kp0:Math.max(0,Math.ceil(fa)-n0),kp1:Math.min(len-1,Math.floor(fb)-n0),
    ta:rec.t0+fa*rec.dt,tb:rec.t0+fb*rec.dt,periods:periods};
}

// rms, dc, rectified mean, peaks and the fundamental (rms phasor) of x.
function sigStats(x,fr){
  var s1=0,s2=0,sa=0,c=0,s=0,w=fr.w,n0=fr.n0,len=fr.len,cs=fr.cs,sn=fr.sn;
  for(var k=0;k<len;k++){
    var v=x[n0+k],wk=w[k];
    if(wk===0)continue;
    var wv=wk*v;
    s1+=wv;s2+=wv*v;sa+=wk*(v<0?-v:v);
    if(cs){c+=wv*cs[k];s+=wv*sn[k];}
  }
  var mx=-Infinity,mn=Infinity;
  for(var k2=fr.kp0;k2<=fr.kp1;k2++){var vv=x[n0+k2];if(vv>mx)mx=vv;if(vv<mn)mn=vv;}
  var W=fr.W;
  var ph=cs?cx(2*c/W/Math.SQRT2,-2*s/W/Math.SQRT2):null;
  return {rms:Math.sqrt(Math.max(0,s2/W)),dc:s1/W,rmn:sa/W,max:mx,min:mn,ph:ph};
}
function pairStats(u,i,fr){
  var sp=0,w=fr.w,n0=fr.n0,len=fr.len;
  for(var k=0;k<len;k++){var wk=w[k];if(wk!==0)sp+=wk*u[n0+k]*i[n0+k];}
  var mx=-Infinity,mn=Infinity;
  for(var k2=fr.kp0;k2<=fr.kp1;k2++){var p=u[n0+k2]*i[n0+k2];if(p>mx)mx=p;if(p<mn)mn=p;}
  return {p:sp/fr.W,max:mx,min:mn};
}

// Frequency of x: rising zero crossings (around the interval mean, with
// hysteresis) -> (count-1) / (last-first). The gate reaches two interval
// lengths back and half a length ahead, so even a single-period interval
// (whose own ends sit exactly on crossings, the last one possibly at the
// very end of the record) sees at least two crossings.
function freqOf(x,fr,dc,amp,hyst,rec){
  var h=hyst*amp;
  if(!(h>0))return NaN;
  var state=0,cand=NaN,first=NaN,last=NaN,cnt=0,prev=NaN;
  var g0=Math.max(0,fr.n0-2*fr.len),g1=Math.min(x.length-1,fr.n0+fr.len-1+(fr.len>>1));
  for(var n=g0;n<=g1;n++){
    var v=x[n]-dc;
    if(v<-h){state=-1;cand=NaN;}
    else if(state===-1){
      if(prev<=0&&v>0)cand=(n-1)+(-prev)/(v-prev);
      if(v>h){
        var tc=isFinite(cand)?cand:n;
        if(!cnt)first=tc;
        last=tc;cnt++;state=1;cand=NaN;
      }
    }
    prev=v;
  }
  if(cnt<2||!(last>first))return NaN;
  return (cnt-1)/((last-first)*rec.dt);
}

// ─── Prepared signals: scaled element inputs + virtual three-phase signals ───
function prepare(rec,cfg){
  var n=rec.n,p={t0:rec.t0,dt:rec.dt,n:n,u:[],i:[],ll:null,uy:null,ix:null,ixKind:null};
  for(var e=0;e<NEL;e++){
    var el=cfg.elements[e]||{};
    var used=PA.elementUsed(cfg.wiring,e);
    var su=(+el.uScale||1),si=(+el.iScale||1)*(el.iInvert?-1:1);
    p.u[e]=(used&&rec.u[e])?scaleArr(rec.u[e],su):null;
    p.i[e]=(used&&rec.i[e])?scaleArr(rec.i[e],si):null;
  }
  if(cfg.adc&&cfg.adc.enabled){
    var crest=+cfg.crest||3;
    p.adc={u:[],i:[],lsbU:[],lsbI:[]};
    for(e=0;e<NEL;e++){
      var ea=cfg.elements[e]||{};
      if(p.u[e]){var au=adcStage(p.u[e],rec.dt,cfg.adc,ea.uRange,PA.U_RANGES,crest,101+e);p.u[e]=au.x;p.adc.u[e]=au.range;p.adc.lsbU[e]=au.lsb;}
      if(p.i[e]){var ai=adcStage(p.i[e],rec.dt,cfg.adc,ea.iRange,PA.I_RANGES,crest,201+e);p.i[e]=ai.x;p.adc.i[e]=ai.range;p.adc.lsbI[e]=ai.lsb;}
    }
  }
  var u=p.u,i=p.i,w=cfg.wiring,k;
  // Line voltages u12, u23, u31 as sample arrays, per wiring system.
  if(w==='3P4W'&&u[0]&&u[1]&&u[2]){
    p.ll=[diffArr(u[0],u[1]),diffArr(u[1],u[2]),diffArr(u[2],u[0])];
  }else if(w==='3P3W'&&u[0]&&u[1]){
    p.ll=[diffArr(u[0],u[1]),u[1],scaleArr(u[0],-1)];
  }else if(w==='3V3A'&&u[0]&&u[1]&&u[2]){
    p.ll=[u[2],u[1],scaleArr(u[0],-1)];
  }
  // Virtual star point for three-wire systems (Hioki 3P3W3M, per sample):
  // u1N = (u12 − u31)/3, u2N = (u23 − u12)/3, u3N = (u31 − u23)/3
  if(p.ll&&(w==='3P3W'||w==='3V3A')){
    p.uy=[new Float64Array(n),new Float64Array(n),new Float64Array(n)];
    for(k=0;k<n;k++){
      var a=p.ll[0][k],b=p.ll[1][k],c=p.ll[2][k];
      p.uy[0][k]=(a-c)/3;p.uy[1][k]=(b-a)/3;p.uy[2][k]=(c-b)/3;
    }
  }
  // Computed current: i3 = −(i1+i2) (3P3W) or iN = −(i1+i2+i3) (3P4W).
  if(w==='3P3W'&&i[0]&&i[1]){
    p.ix=new Float64Array(n);p.ixKind='I3';
    for(k=0;k<n;k++)p.ix[k]=-(i[0][k]+i[1][k]);
  }else if(w==='3P4W'&&i[0]&&i[1]&&i[2]){
    p.ix=new Float64Array(n);p.ixKind='IN';
    for(k=0;k<n;k++)p.ix[k]=-(i[0][k]+i[1][k]+i[2][k]);
  }
  return p;
}
// Realistic input stage of one channel: analog bandwidth (first-order
// low-pass), additive gaussian noise, clipping at the full scale ±crest·range
// and quantisation to `bits` over that full scale. With an auto range, the
// range follows the whole record (what the auto ranging settles to).
function adcStage(x,dt,adc,rangeSet,list,crest,seed){
  var n=x.length,y=new Float64Array(n),k;
  if(+adc.bw>0){
    var al=1-Math.exp(-2*Math.PI*adc.bw*dt),st=x[0];
    for(k=0;k<n;k++){st+=al*(x[k]-st);y[k]=st;}
  }else y.set(x);
  var r=+rangeSet;
  if(!(r>0)){
    var s2=0,pk=0,cnt=0;
    for(k=0;k<n;k++){var v0=y[k];if(!isFinite(v0))continue;s2+=v0*v0;cnt++;var a=Math.abs(v0);if(a>pk)pk=a;}
    r=fitRange(list,cnt?Math.sqrt(s2/cnt):0,pk,crest);
  }
  var fsc=crest*r,bits=Math.max(4,Math.min(24,(+adc.bits|0)||16));
  var lsb=2*fsc/Math.pow(2,bits);
  var rnd=prng(seed),sig=(+adc.noise||0)*lsb;
  for(k=0;k<n;k++){
    var v=y[k];
    if(sig>0)v+=sig*gauss(rnd);
    if(v>fsc)v=fsc;else if(v<-fsc)v=-fsc;
    y[k]=Math.round(v/lsb)*lsb;
  }
  return {x:y,range:r,lsb:lsb};
}
// Deterministic noise (mulberry32 + Box-Muller): the same record gives the
// same samples on every evaluation, in the page and in a worker alike.
function prng(seed){
  var a=seed>>>0;
  return function(){
    a=(a+0x6D2B79F5)>>>0;
    var t=Math.imul(a^(a>>>15),1|a);
    t=(t+Math.imul(t^(t>>>7),61|t))^t;
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}
function gauss(rnd){
  var u1=rnd()||1e-12,u2=rnd();
  return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
}
function scaleArr(a,s){
  if(s===1)return a;
  var o=new Float64Array(a.length);
  for(var k=0;k<a.length;k++)o[k]=a[k]*s;
  return o;
}
function diffArr(a,b){
  var o=new Float64Array(a.length);
  for(var k=0;k<a.length;k++)o[k]=a[k]-b[k];
  return o;
}

// ─── Harmonics (PLL sampling) ───
// The interval holds `periods` whole periods. It is resampled to Np points
// per period (linear interpolation, like a PLL-locked sampler), then a DFT
// is evaluated at the harmonic bins k·periods for k = 0..order. Np is a
// power of two ≥ 4·(order+1), so the highest order stays well below Nyquist.
var TRIG={};
function trigTable(Np){
  if(!TRIG[Np]){
    var c=new Float64Array(Np),sn=new Float64Array(Np);
    for(var k=0;k<Np;k++){c[k]=Math.cos(2*Math.PI*k/Np);sn[k]=Math.sin(2*Math.PI*k/Np);}
    TRIG[Np]={c:c,s:sn};
  }
  return TRIG[Np];
}
function harmNp(order){var np=64;while(np<4*(order+1))np*=2;return np;}
PA.HARM_MAX=100;
// rms phasors re/im per order (index 0 = DC value), rotated by rotAng·k so
// that the reference fundamental sits on 0° (makes them averageable).
function harmonicsOf(x,fr,order,rotAng){
  var M=fr.periods,Np=harmNp(order),L=M*Np,tb=trigTable(Np);
  var re=new Float64Array(order+1),im=new Float64Array(order+1);
  var buf=new Float64Array(L),span=fr.fb-fr.fa,last=x.length-1,n;
  for(n=0;n<L;n++){
    var f=fr.fa+span*n/L,i0=Math.floor(f),a=f-i0;
    if(i0>=last){i0=last-1;a=1;}
    buf[n]=x[i0]+(x[i0+1]-x[i0])*a;
  }
  for(var k=0;k<=order;k++){
    var c=0,s=0,idx=0;
    for(n=0;n<L;n++){
      var v=buf[n];
      c+=v*tb.c[idx];s+=v*tb.s[idx];
      idx+=k;while(idx>=Np)idx-=Np;
    }
    if(k===0){re[0]=c/L;im[0]=0;continue;}
    var hr=2*c/L/Math.SQRT2,hi=-2*s/L/Math.SQRT2;
    if(rotAng){
      var ca=Math.cos(k*rotAng),sa=Math.sin(k*rotAng);
      re[k]=hr*ca-hi*sa;im[k]=hr*sa+hi*ca;
    }else{re[k]=hr;im[k]=hi;}
  }
  return {re:re,im:im};
}

// ─── Raw measurement of one interval ───
// Returns a flat primitive map (keys like 'Urms0', 'P2', 'U1re0'). Phasors
// are rotated so the reference phasor (sync source, else U of element 1) lies
// on 0°, which makes them averageable across intervals.
function measureRaw(p,cfg,fr){
  var r={},e,hyst=cfg.sync.hyst||0.05;
  var ref=null;
  var st=[];
  for(e=0;e<NEL;e++){
    var u=p.u[e],i=p.i[e],su=null,si=null;
    if(u){
      su=sigStats(u,fr);
      r['Urms'+e]=su.rms;r['Udc'+e]=su.dc;r['Urmn'+e]=su.rmn;r['Umn'+e]=su.rmn*MN_CAL;
      r['Uac'+e]=Math.sqrt(Math.max(0,su.rms*su.rms-su.dc*su.dc));
      r['Upkp'+e]=su.max;r['Upkm'+e]=su.min;
      r['fU'+e]=freqOf(u,fr,su.dc,Math.max(su.max-su.dc,su.dc-su.min),hyst,p);
    }
    if(i){
      si=sigStats(i,fr);
      r['Irms'+e]=si.rms;r['Idc'+e]=si.dc;r['Irmn'+e]=si.rmn;r['Imn'+e]=si.rmn*MN_CAL;
      r['Iac'+e]=Math.sqrt(Math.max(0,si.rms*si.rms-si.dc*si.dc));
      r['Ipkp'+e]=si.max;r['Ipkm'+e]=si.min;
      r['fI'+e]=freqOf(i,fr,si.dc,Math.max(si.max-si.dc,si.dc-si.min),hyst,p);
    }
    st[e]={u:su,i:si};
  }
  // phase reference
  var sync=cfg.sync.src||'';
  var sm=/^([UI])([1-4])$/.exec(sync);
  if(sm){
    var se=+sm[2]-1,ss=st[se]&&st[se][sm[1]==='U'?'u':'i'];
    if(ss&&ss.ph&&cabs(ss.ph)>0)ref=ss.ph;
  }
  if(!ref)for(e=0;e<NEL;e++){if(st[e].u&&st[e].u.ph&&cabs(st[e].u.ph)>0){ref=st[e].u.ph;break;}}
  var rot=ref?cx(Math.cos(-carg(ref)),Math.sin(-carg(ref))):null;
  function putPh(key,ph){
    if(!ph||!rot){r[key+'re']=NaN;r[key+'im']=NaN;return;}
    var q=cmul(ph,rot);r[key+'re']=q.re;r[key+'im']=q.im;
  }
  for(e=0;e<NEL;e++){
    var a=st[e];
    if(a.u)putPh('U1',a.u.ph),renameLast(r,'U1',e);
    if(a.i)putPh('I1',a.i.ph),renameLast(r,'I1',e);
    if(a.u&&a.i){
      var ps=pairStats(p.u[e],p.i[e],fr);
      r['P'+e]=ps.p;r['Ppkp'+e]=ps.max;r['Ppkm'+e]=ps.min;
      var S=(cfg.sBase==='mn'?a.u.rmn*MN_CAL:a.u.rms)*a.i.rms;
      r['S'+e]=S;
      // lead/lag from the fundamental: φ1 = arg U1 − arg I1, > 0 = current lags
      var s=1;
      if(a.u.ph&&a.i.ph&&cabs(a.u.ph)>1e-12*Math.max(1,a.u.rms)&&cabs(a.i.ph)>1e-12*Math.max(1,a.i.rms)){
        var pq=cmul(a.u.ph,cx(a.i.ph.re,-a.i.ph.im));   // U1·conj(I1) = P1 + jQ1
        r['P1'+e]=pq.re;r['Q1'+e]=pq.im;
        s=pq.im<0?-1:1;
      }else{r['P1'+e]=NaN;r['Q1'+e]=NaN;}
      r['Q'+e]=s*Math.sqrt(Math.max(0,S*S-ps.p*ps.p));
    }
  }
  // harmonics of every element input (synchronised intervals only)
  if(cfg.harm&&cfg.harm.enabled&&fr.periods>0){
    var order=Math.max(1,Math.min(PA.HARM_MAX,Math.round(+cfg.harm.order||50)));
    var rotAng=ref?-carg(ref):0;
    var H={order:order,U:[],I:[]};
    for(e=0;e<NEL;e++){
      if(p.u[e])H.U[e]=harmonicsOf(p.u[e],fr,order,rotAng);
      if(p.i[e])H.I[e]=harmonicsOf(p.i[e],fr,order,rotAng);
    }
    r._h=H;
  }
  // virtual three-phase signals
  var k2;
  if(p.ll){
    for(k2=0;k2<3;k2++){
      var sl=sigStats(p.ll[k2],fr);
      r['ULL'+k2]=sl.rms;putPh('L',sl.ph);renameLast(r,'L',k2);
    }
  }
  if(p.uy){
    for(k2=0;k2<3;k2++){
      var sy=sigStats(p.uy[k2],fr);
      r['UYrms'+k2]=sy.rms;putPh('Y',sy.ph);renameLast(r,'Y',k2);
    }
  }
  if(p.ix){
    var sx=sigStats(p.ix,fr);
    r['IX']=sx.rms;putPh('X',sx.ph);renameLast(r,'X','');
  }
  r._ta=fr.ta;r._tb=fr.tb;r._periods=fr.periods;
  r._fsync=fr.periods>0?fr.periods/(fr.tb-fr.ta):NaN;
  return r;
}
// putPh writes key+'re'/'im'; append the element index after the fact.
function renameLast(r,key,idx){
  r[key+'re'+idx]=r[key+'re'];r[key+'im'+idx]=r[key+'im'];
  delete r[key+'re'];delete r[key+'im'];
}

// ─── Averaging (Yokogawa: U, I, P, S, Q, fundamentals, f; not the peaks) ───
// Harmonics (_h) are averaged exponentially only, as on the instruments;
// with a moving average they pass through unaveraged.
function isPeakKey(k){return /pk[pm]\d$/.test(k)||k.charAt(0)==='_';}
function isRmsKey(k){return /^(Urms|Irms|ULL|UYrms)\d$/.test(k)||k==='IX';}
function cloneH(H){
  function cp(list){return list.map(function(x){return x?{re:x.re.slice(),im:x.im.slice()}:x;});}
  return {order:H.order,U:cp(H.U),I:cp(H.I)};
}
function Averager(cfg){this.cfg=cfg||{mode:'off'};this.reset();}
Averager.prototype.reset=function(){this.D=null;this.buf=[];this.n=0;this.H=null;};
Averager.prototype.push=function(M0){
  var mode=this.cfg.mode,k,out={},quad=!!this.cfg.rmsQuad;
  // quadratic rms averaging: average the squares, take the root afterwards
  var M={};
  for(k in M0){
    if(k==='_h')continue;
    var m0=M0[k];
    M[k]=(quad&&isRmsKey(k)&&isFinite(m0))?m0*m0:m0;
  }
  this.n++;
  if(mode==='exp'){
    var K=Math.max(1,+this.cfg.K||1);
    if(!this.D){this.D={};for(k in M)this.D[k]=M[k];}
    else{
      for(k in M){
        var m=M[k],d=this.D[k];
        if(isPeakKey(k)||!isFinite(d))this.D[k]=m;
        else if(isFinite(m))this.D[k]=d+(m-d)/K;
      }
    }
    for(k in this.D)out[k]=this.D[k];
  }else if(mode==='lin'){
    var mlen=Math.max(1,+this.cfg.m||1);
    this.buf.push(M);
    if(this.buf.length>mlen)this.buf.shift();
    for(k in M){
      if(isPeakKey(k)){out[k]=M[k];continue;}
      var sum=0,c=0;
      for(var j=0;j<this.buf.length;j++){var v=this.buf[j][k];if(isFinite(v)){sum+=v;c++;}}
      out[k]=c?sum/c:NaN;
    }
  }else{
    for(k in M)out[k]=M[k];
  }
  if(quad)for(k in out)if(isRmsKey(k)&&isFinite(out[k]))out[k]=Math.sqrt(Math.max(0,out[k]));
  if(M0._h)out._h=this._harm(M0._h,mode);
  return out;
};
Averager.prototype._harm=function(H,mode){
  if(mode!=='exp')return H;
  if(!this.H||this.H.order!==H.order){this.H=cloneH(H);return cloneH(this.H);}
  var K=Math.max(1,+this.cfg.K||1),D=this.H;
  ['U','I'].forEach(function(t){
    for(var e=0;e<NEL;e++){
      var m=H[t][e],d=D[t][e];
      if(!m){D[t][e]=undefined;continue;}
      if(!d){D[t][e]={re:m.re.slice(),im:m.im.slice()};continue;}
      for(var k=0;k<m.re.length;k++){d.re[k]+=(m.re[k]-d.re[k])/K;d.im[k]+=(m.im[k]-d.im[k])/K;}
    }
  });
  return cloneH(D);
};
PA.Averager=Averager;

// ─── Derived display values ───
function nz(v){return isFinite(v)?v:NaN;}
function sgn(q){return q<0?-1:1;}
function phiDeg(P,S,s){
  if(!(S>0))return NaN;
  var l=Math.max(-1,Math.min(1,P/S));
  return s*Math.acos(l)*DEG;
}
function getPh(m,key,idx){
  var re=m[key+'re'+idx],im=m[key+'im'+idx];
  return (isFinite(re)&&isFinite(im))?cx(re,im):null;
}

function derive(m,cfg){
  var v={},e,c;
  var lsign=!!cfg.lambdaSign;
  for(e=0;e<NEL;e++){
    c=':'+(e+1);
    if(isFinite(m['Urms'+e])){
      var Ur=m['Urms'+e];
      v['Urms'+c]=Ur;v['Umn'+c]=m['Umn'+e];v['Udc'+c]=m['Udc'+e];v['Urmn'+c]=m['Urmn'+e];v['Uac'+c]=m['Uac'+e];
      v['Upkp'+c]=m['Upkp'+e];v['Upkm'+c]=m['Upkm'+e];
      v['CfU'+c]=Ur>0?Math.max(Math.abs(m['Upkp'+e]),Math.abs(m['Upkm'+e]))/Ur:NaN;
      v['FfU'+c]=m['Urmn'+e]>0?Ur/m['Urmn'+e]:NaN;
      v['fU'+c]=nz(m['fU'+e]);
      v['Urf'+c]=Math.abs(m['Udc'+e])>0?(m['Upkp'+e]-m['Upkm'+e])/(2*Math.abs(m['Udc'+e]))*100:NaN;
      var u1=getPh(m,'U1',e);
      v['U1'+c]=u1?cabs(u1):NaN;
      v['THDU'+c]=thd(m,'U',e,Ur,m['Udc'+e],u1);
    }
    if(isFinite(m['Irms'+e])){
      var Ir=m['Irms'+e];
      v['Irms'+c]=Ir;v['Imn'+c]=m['Imn'+e];v['Idc'+c]=m['Idc'+e];v['Irmn'+c]=m['Irmn'+e];v['Iac'+c]=m['Iac'+e];
      v['Ipkp'+c]=m['Ipkp'+e];v['Ipkm'+c]=m['Ipkm'+e];
      v['CfI'+c]=Ir>0?Math.max(Math.abs(m['Ipkp'+e]),Math.abs(m['Ipkm'+e]))/Ir:NaN;
      v['FfI'+c]=m['Irmn'+e]>0?Ir/m['Irmn'+e]:NaN;
      v['fI'+c]=nz(m['fI'+e]);
      v['Irf'+c]=Math.abs(m['Idc'+e])>0?(m['Ipkp'+e]-m['Ipkm'+e])/(2*Math.abs(m['Idc'+e]))*100:NaN;
      var i1=getPh(m,'I1',e);
      v['I1'+c]=i1?cabs(i1):NaN;
      v['THDI'+c]=thd(m,'I',e,Ir,m['Idc'+e],i1);
    }
    if(isFinite(m['P'+e])){
      var P=m['P'+e],S=m['S'+e],Q=m['Q'+e],s=sgn(Q);
      v['P'+c]=P;v['S'+c]=S;v['Q'+c]=Q;
      var lam=S>0?P/S:NaN;
      v['lambda'+c]=lsign?s*Math.abs(lam):lam;
      v['phi'+c]=phiDeg(P,S,s);
      v['Ppkp'+c]=m['Ppkp'+e];v['Ppkm'+c]=m['Ppkm'+e];
      var U1=getPh(m,'U1',e),I1=getPh(m,'I1',e);
      if(U1&&I1){
        v['phi1'+c]=wrapDeg((carg(U1)-carg(I1))*DEG);
        v['P1'+c]=m['P1'+e];v['Q1'+c]=m['Q1'+e];
        v['S1'+c]=cabs(U1)*cabs(I1);
        v['cosphi1'+c]=v['S1'+c]>0?m['P1'+e]/v['S1'+c]:NaN;
        v['D'+c]=Math.sqrt(Math.max(0,S*S-P*P-m['Q1'+e]*m['Q1'+e]));
      }
    }
  }
  deriveSigma(m,cfg,v);
  v['fSync:S']=nz(m._fsync);
  return v;
}

// THD (IEC, relative to the fundamental): from the harmonics 2..order when
// they were measured, otherwise broadband from rms, dc and fundamental.
function thd(m,t,e,rms,dc,ph1){
  var h=m._h&&m._h[t]&&m._h[t][e];
  if(h){
    var f2=h.re[1]*h.re[1]+h.im[1]*h.im[1],s=0;
    if(!(f2>0))return NaN;
    for(var k=2;k<h.re.length;k++)s+=h.re[k]*h.re[k]+h.im[k]*h.im[k];
    return Math.sqrt(s/f2)*100;
  }
  if(!ph1||!(cabs(ph1)>0))return NaN;
  return Math.sqrt(Math.max(0,rms*rms-dc*dc-cabs(ph1)*cabs(ph1)))/cabs(ph1)*100;
}

// Harmonic spectrum of one input for display: kind 'U' | 'I' | 'P',
// element index e. Returns {order, mag[], deg[], pct[], thd, signed} or null.
// U/I deg: φ(k) − k·φref(1), the time-invariant phase relative to the
// reference fundamental (sync source) in cosine convention.
// P: mag = P(k) (signed, power flow per order), deg = φ(k) between U(k), I(k).
PA.harmonics=function(prim,kind,e){
  var H=prim&&prim._h;
  if(!H)return null;
  var o=H.order,mag=new Float64Array(o+1),deg=new Float64Array(o+1),pct=new Float64Array(o+1),k,s;
  if(kind==='P'){
    var hu=H.U[e],hi=H.I[e];
    if(!hu||!hi)return null;
    mag[0]=hu.re[0]*hi.re[0];
    for(k=1;k<=o;k++){
      mag[k]=hu.re[k]*hi.re[k]+hu.im[k]*hi.im[k];
      var qk=hu.im[k]*hi.re[k]-hu.re[k]*hi.im[k];
      deg[k]=Math.atan2(qk,mag[k])*DEG;
    }
    for(k=0;k<=o;k++)pct[k]=mag[1]!==0?mag[k]/Math.abs(mag[1])*100:NaN;
    return {order:o,mag:mag,deg:deg,pct:pct,thd:NaN,signed:true};
  }
  var h=H[kind]&&H[kind][e];
  if(!h)return null;
  for(k=0;k<=o;k++){
    mag[k]=k===0?h.re[0]:Math.sqrt(h.re[k]*h.re[k]+h.im[k]*h.im[k]);
    deg[k]=k===0?0:Math.atan2(h.im[k],h.re[k])*DEG;
  }
  for(k=0;k<=o;k++)pct[k]=mag[1]>0?Math.abs(mag[k])/mag[1]*100:NaN;
  s=0;for(k=2;k<=o;k++)s+=mag[k]*mag[k];
  return {order:o,mag:mag,deg:deg,pct:pct,thd:mag[1]>0?Math.sqrt(s)/mag[1]*100:NaN,signed:false};
};

function deriveSigma(m,cfg,v){
  var w=cfg.wiring,G=(WIRINGS[w]||{}).group||[];
  var e,j,lsign=!!cfg.lambdaSign;
  // efficiency works in 1P2W as well (input side = sum of elements 1..3)
  var Pg=NaN,complete=G.length>0;
  for(j=0;j<G.length;j++)if(!isFinite(m['P'+G[j]]))complete=false;
  if(G.length){
    if(complete){
      Pg=0;for(j=0;j<G.length;j++)Pg+=m['P'+G[j]];
      var Ssum=0,Qaron=0,Uavg=0,Iavg=0;
      for(j=0;j<G.length;j++){Ssum+=m['S'+G[j]];Uavg+=m['Urms'+G[j]];Iavg+=m['Irms'+G[j]];}
      Uavg/=G.length;Iavg/=G.length;
      var fac=1;
      if(w==='3P3W')fac=SQ3/2;
      else if(w==='3V3A'){
        fac=SQ3/3;
        // 3V3A: Aron pair is e1+e2; S sums all three line quantities
        Pg=m['P0']+m['P1'];
      }
      var S1=fac*Ssum;
      var QG=(w==='3P4W')?(m['Q0']+m['Q1']+m['Q2']):(m['Q0']+m['Q1']);
      var sQ=sgn(QG),S,Q;
      var ie=ieee1459(m,w);
      switch(cfg.sq){
        case 'TYPE2':S=S1;Q=sQ*Math.sqrt(Math.max(0,S*S-Pg*Pg));break;
        case 'TYPE3':Q=QG;S=Math.sqrt(Pg*Pg+Q*Q);break;
        case 'IEEE1459':S=ie?ie.Se:NaN;Q=isFinite(S)?Math.sqrt(Math.max(0,S*S-Pg*Pg)):NaN;break;
        default:S=S1;Q=QG;
      }
      v['Urms:S']=Uavg;v['Irms:S']=Iavg;
      v['P:S']=Pg;v['S:S']=S;v['Q:S']=Q;
      var lam=S>0?Pg/S:NaN;
      v['lambda:S']=lsign?sQ*Math.abs(lam):lam;
      v['phi:S']=phiDeg(Pg,S,sQ);
      var P1s=0,Q1s=0,ok1=true;
      var GA=(w==='3P4W')?[0,1,2]:[0,1];
      for(j=0;j<GA.length;j++){
        if(!isFinite(m['P1'+GA[j]])){ok1=false;break;}
        P1s+=m['P1'+GA[j]];Q1s+=m['Q1'+GA[j]];
      }
      if(ok1){v['P1:S']=P1s;v['Q1:S']=Q1s;}
      if(ie){v['Ue:S']=ie.Ue;v['Ie:S']=ie.Ie;v['Se:S']=ie.Se;}
    }
    threePhase(m,w,v);
  }
  // efficiency against element 4
  if(cfg.eta&&cfg.eta!=='off'&&isFinite(m['P3'])){
    var Pin,Pout,Pa=Pg;
    if(!isFinite(Pa)){
      Pa=0;var any=false;
      for(e=0;e<3;e++)if(isFinite(m['P'+e])){Pa+=m['P'+e];any=true;}
      if(!any)Pa=NaN;
    }
    if(isFinite(Pa)){
      if(cfg.eta==='G/4'){Pin=m['P3'];Pout=Pa;}else{Pin=Pa;Pout=m['P3'];}
      v['eta:S']=Pin!==0?Pout/Pin*100:NaN;
      v['Pv:S']=Pin-Pout;
    }
  }
}

// IEEE 1459 effective voltage / current / apparent power.
function ieee1459(m,w){
  var I=[],Ul=[m['ULL0'],m['ULL1'],m['ULL2']];
  if(!(isFinite(Ul[0])&&isFinite(Ul[1])&&isFinite(Ul[2])))return null;
  var ul2=Ul[0]*Ul[0]+Ul[1]*Ul[1]+Ul[2]*Ul[2];
  var Ie,Ue;
  if(w==='3P4W'){
    I=[m['Irms0'],m['Irms1'],m['Irms2'],m['IX']];
    if(!I.every(isFinite))return null;
    Ie=Math.sqrt((I[0]*I[0]+I[1]*I[1]+I[2]*I[2]+I[3]*I[3])/3);
    var up2=m['Urms0']*m['Urms0']+m['Urms1']*m['Urms1']+m['Urms2']*m['Urms2'];
    Ue=Math.sqrt((3*up2+ul2)/18);
  }else{
    I=[m['Irms0'],m['Irms1'],(w==='3P3W')?m['IX']:m['Irms2']];
    if(!I.every(isFinite))return null;
    Ie=Math.sqrt((I[0]*I[0]+I[1]*I[1]+I[2]*I[2])/3);
    Ue=Math.sqrt(ul2/9);
  }
  return {Ue:Ue,Ie:Ie,Se:3*Ue*Ie};
}

// Line/phase rms, symmetrical components, unbalance, phase sequence.
// Phase-voltage phasors: the element phasors (3P4W) or the virtual star
// point (three-wire). Line currents: element currents, i3 computed in 3P3W.
function threePhase(m,w,v){
  var k;
  if(isFinite(m['ULL0'])){v['U12:S']=m['ULL0'];v['U23:S']=m['ULL1'];v['U31:S']=m['ULL2'];}
  if(w==='3P4W'){for(k=0;k<3;k++)if(isFinite(m['Urms'+k]))v['UY'+(k+1)+':S']=m['Urms'+k];}
  else if(isFinite(m['UYrms0'])){for(k=0;k<3;k++)v['UY'+(k+1)+':S']=m['UYrms'+k];}
  if(isFinite(m['IX']))v['IX:S']=m['IX'];
  var ph=PA.phasors(m,w);
  if(!ph)return;
  var U=ph.U,I=ph.I;
  if(U[0]&&U[1]&&U[2]){
    var sc=fortescue(U);
    v['Upos:S']=cabs(sc.pos);v['Uneg:S']=cabs(sc.neg);v['U0:S']=cabs(sc.zero);
    v['uU2:S']=cabs(sc.pos)>0?cabs(sc.neg)/cabs(sc.pos)*100:NaN;
    var d=wrapDeg((carg(U[1])-carg(U[0]))*DEG);
    v['rot:S']=Math.abs(d+120)<30?'clockwise (L1-L2-L3)':(Math.abs(d-120)<30?'counter-cw (L1-L3-L2)':'undefined');
  }
  if(I[0]&&I[1]&&I[2]){
    var si=fortescue(I);
    v['uI2:S']=cabs(si.pos)>0?cabs(si.neg)/cabs(si.pos)*100:NaN;
  }
  // IEC 61000-4-30 / Hioki: unbalance from the fundamental line voltage magnitudes
  var L=ph.L;
  if(L[0]&&L[1]&&L[2]){
    var a=cabs(L[0]),b=cabs(L[1]),c=cabs(L[2]);
    var den=(a*a+b*b+c*c);
    if(den>0){
      var beta=(Math.pow(a,4)+Math.pow(b,4)+Math.pow(c,4))/(den*den);
      var rt=Math.sqrt(Math.max(0,3-6*beta));
      v['UunbIEC:S']=Math.sqrt(Math.max(0,(1-rt)/(1+rt)))*100;
    }
  }
}
function fortescue(X){
  return {
    zero:cscale(cadd(cadd(X[0],X[1]),X[2]),1/3),
    pos:cscale(cadd(cadd(X[0],cmul(A120,X[1])),cmul(A240,X[2])),1/3),
    neg:cscale(cadd(cadd(X[0],cmul(A240,X[1])),cmul(A120,X[2])),1/3)
  };
}

// Fundamental phasors of the three phases from an (averaged) primitive map.
// U: phase voltages, L: line voltages u12/u23/u31, I: line currents.
PA.phasors=function(m,w){
  var U=[null,null,null],L=[null,null,null],I=[null,null,null],k;
  for(k=0;k<3;k++)L[k]=getPh(m,'L',k);
  if(w==='3P4W'){for(k=0;k<3;k++){U[k]=getPh(m,'U1',k);I[k]=getPh(m,'I1',k);}}
  else if(w==='3P3W'){
    for(k=0;k<3;k++)U[k]=getPh(m,'Y',k);
    I[0]=getPh(m,'I1',0);I[1]=getPh(m,'I1',1);I[2]=getPh(m,'X','');
  }else if(w==='3V3A'){
    for(k=0;k<3;k++){U[k]=getPh(m,'Y',k);I[k]=getPh(m,'I1',k);}
  }else return null;
  return {U:U,L:L,I:I};
};

// ─── Range handling ───
function fitRange(list,rms,pk,crest){
  for(var k=0;k<list.length;k++)if(rms<=list[k]&&pk<=crest*list[k])return list[k];
  return list[list.length-1];
}
function rangeStep(state,list,mode,rms,pk,crest){
  if(!isFinite(rms))return {range:state,ovr:false};
  if(mode!=='auto'&&mode!=null&&mode!==''){
    var r=+mode;
    return {range:r,ovr:rms>1.1*r||pk>crest*r};
  }
  var cur=state;
  var over=!cur||rms>1.1*cur||pk>crest*cur;
  var under=cur&&rms<0.3*cur&&pk<0.3*crest*cur;
  if(over||under)cur=fitRange(list,rms,pk,crest);
  return {range:cur,ovr:rms>1.1*cur||pk>crest*cur};
}

// ─── Instrument ───
function Instrument(cfg){
  this.cfg=PA.normalizeConfig(cfg);
  this.reset();
}
Instrument.prototype.reset=function(){
  this.history=[];
  this.avg=new Averager(this.cfg.avg);
  this.rec=null;this.prep=null;
  this.cross=[];this.sch={state:0,cand:NaN,prev:NaN,scanned:0};
  this.ci=-1;this.winStart=NaN;
  this.uRange=[0,0,0,0];this.iRange=[0,0,0,0];
  this.syncLost=false;
  this.integ=null;
};
// Attach a record without evaluating it, e.g. when the history was computed
// in a worker: waveforms, cursor values and window evaluations still need
// the prepared samples here.
Instrument.prototype.attach=function(rec,history,extra){
  this.reset();
  this.rec=rec;
  this.prep=prepare(rec,this.cfg);
  if(history)this.history=history;
  if(extra&&extra.syncLost)this.syncLost=true;
  return this;
};
// Offline: evaluate a complete record in one go.
Instrument.prototype.run=function(rec){
  this.reset();
  this.append(rec);
  this.flush();
  return this.history;
};
// Streaming: feed further samples (same t0 grid, contiguous). A hardware or
// real-time source would call this per block; the simulation calls it once.
Instrument.prototype.append=function(block){
  if(!this.rec){
    this.rec={t0:block.t0,dt:block.dt,n:block.n,u:block.u.slice(),i:block.i.slice()};
  }else{
    var r=this.rec,n=r.n+block.n,e;
    for(e=0;e<NEL;e++){
      r.u[e]=concatArr(r.u[e],block.u[e],r.n,block.n);
      r.i[e]=concatArr(r.i[e],block.i[e],r.n,block.n);
    }
    r.n=n;
  }
  this.prep=prepare(this.rec,this.cfg);
  this._scanSync();
  this._process(false);
};
Instrument.prototype.flush=function(){this._process(true);};
function concatArr(a,b,na,nb){
  if(!a&&!b)return null;
  var o=new Float64Array(na+nb);
  if(a)o.set(a.subarray(0,na),0);else o.fill(NaN,0,na);
  if(b)o.set(b.subarray(0,nb),na);else o.fill(NaN,na);
  return o;
}

Instrument.prototype.syncSignal=function(){
  var m=/^([UI])([1-4])$/.exec(this.cfg.sync.src||'');
  if(!m||!this.prep)return null;
  return this.prep[m[1]==='U'?'u':'i'][+m[2]-1];
};

// Rising zero crossings of the sync signal (Schmitt trigger with hysteresis
// relative to the signal amplitude; 'ac' coupling removes the mean first).
Instrument.prototype._scanSync=function(){
  var p=this.prep,cfg=this.cfg,sc=this.cfg.sync;
  if(sc.src==='fixed'){
    var f=+sc.freq;
    this.cross=[];
    if(f>0){
      var tEnd=p.t0+(p.n-1)*p.dt,t=Math.max(p.t0,+cfg.tStart||0);
      for(var k=0;t+k/f<=tEnd;k++)this.cross.push(t+k/f);
    }
    return;
  }
  var x=this.syncSignal();
  if(!x){this.cross=[];return;}
  if(sc.filter&&+sc.filterHz>0){
    // two cascaded first-order low-passes, forward only (the constant delay
    // shifts every crossing equally, so period lengths stay exact)
    var y=new Float64Array(x.length),al=1-Math.exp(-2*Math.PI*sc.filterHz*p.dt),s1=x[0],s2=x[0];
    for(var n=0;n<x.length;n++){s1+=al*(x[n]-s1);s2+=al*(s1-s2);y[n]=s2;}
    x=y;
  }
  // level and hysteresis from the data seen so far (recomputed per append)
  var startN=Math.max(0,Math.ceil(((+cfg.tStart||0)-p.t0)/p.dt));
  var mean=0,cnt=0,i;
  if(sc.coupling==='ac'){for(i=startN;i<x.length;i++){mean+=x[i];cnt++;}mean=cnt?mean/cnt:0;}
  var amp=0;
  for(i=startN;i<x.length;i++){var a=Math.abs(x[i]-mean);if(a>amp)amp=a;}
  var h=(sc.hyst||0.05)*amp;
  var st=this.sch;
  // The trigger runs from the start of the record (crossings before tStart
  // are dropped later), so a crossing right at tStart is not lost. A record
  // that starts on a rising zero crossing (a simulation from t = 0) gets that
  // crossing by extrapolation: there is no "low" history before it.
  if(st.scanned===0&&x.length>1){
    var v0=x[0]-mean,v1=x[1]-mean;
    if(Math.abs(v0)<h&&v1>v0){st.state=-1;st.cand=Math.max(0,-v0/(v1-v0));st.prev=v0;st.scanned=1;}
  }
  for(var n2=st.scanned;n2<x.length;n2++){
    var v=x[n2]-mean;
    if(v<-h){st.state=-1;st.cand=NaN;}
    else if(st.state===-1){
      if(st.prev<=0&&v>0)st.cand=(n2-1)+(-st.prev)/(v-st.prev);
      if(v>h){
        var tc=p.t0+(isFinite(st.cand)?st.cand:n2)*p.dt;
        this.cross.push(tc);
        st.state=1;st.cand=NaN;
      }
    }
    st.prev2=st.prev;st.prev=v;
  }
  st.scanned=x.length;
  st.h=h;
};
// Final flush: a record that ends on a rising crossing (simulation stopped
// after whole periods) confirms that last crossing by extrapolation.
Instrument.prototype._endCrossing=function(){
  var st=this.sch,p=this.prep;
  if(st.endDone||this.cfg.sync.src==='fixed')return;
  st.endDone=true;
  if(st.state!==-1||!isFinite(st.prev)||!isFinite(st.prev2)||!(st.prev>st.prev2))return;
  if(st.prev<-st.h)return;
  var tc=(p.n-1)+(-st.prev)/(st.prev-st.prev2);
  if(isFinite(st.cand))tc=st.cand;
  if(tc>p.n-0.5)return;
  this.cross.push(p.t0+Math.min(tc,p.n-1)*p.dt);
};

// Turn crossings / windows into measurement intervals.
Instrument.prototype._process=function(final){
  var p=this.prep,cfg=this.cfg;
  if(!p||p.n<2)return;
  var tEnd=p.t0+(p.n-1)*p.dt;
  var t0=Math.max(p.t0,+cfg.tStart||0);
  var src=cfg.sync.src;
  var periods=Math.max(1,Math.round(+cfg.update.periods||1));
  var T=+cfg.update.time>0?+cfg.update.time:0.1;
  if(final)this._endCrossing();
  if(cfg.update.mode==='auto'&&src!=='none'){
    var c=this.cross;
    if(this.ci<0)this.ci=0;
    while(this.ci+periods<c.length){
      var ta=c[this.ci],tb=c[this.ci+periods];
      this.ci+=periods;
      if(ta<t0-1e-9*(tb-ta))continue;
      this._emit(ta,tb,periods,'ok');
    }
    // no sync at all: degrade to fixed windows once the record is complete
    if(final&&!this.history.length){this.syncLost=true;this._windows(t0,tEnd,Math.min(T,tEnd-t0),false);}
    return;
  }
  this._windows(t0,tEnd,T,src!=='none');
};
// Fixed update windows; inside each, measure over whole periods if possible.
Instrument.prototype._windows=function(t0,tEnd,T,useSync){
  if(!(T>0))return;
  if(!isFinite(this.winStart))this.winStart=t0;
  var c=this.cross;
  while(this.winStart+T<=tEnd+T*1e-9){
    var ws=this.winStart,we=ws+T;
    this.winStart=we;
    var ta=ws,tb=we,np=0,sync='none';
    if(useSync){
      var first=-1,last=-1;
      for(var k=0;k<c.length;k++){
        if(c[k]<ws)continue;
        if(c[k]>we)break;
        if(first<0)first=k;
        last=k;
      }
      if(first>=0&&last>first){ta=c[first];tb=c[last];np=last-first;sync='ok';}
    }
    this._emit(ta,Math.min(tb,tEnd),np,sync,ws,we);
  }
};
Instrument.prototype._emit=function(ta,tb,periods,sync,ws,we){
  var fr=intervalFrame(this.prep,ta,tb,periods);
  if(!fr)return;
  var raw=measureRaw(this.prep,this.cfg,fr);
  var flags={ovrU:[false,false,false,false],ovrI:[false,false,false,false],uRange:[],iRange:[]};
  var crest=+this.cfg.crest||3;
  for(var e=0;e<NEL;e++){
    var el=this.cfg.elements[e]||{};
    var ru=rangeStep(this.uRange[e],PA.U_RANGES,el.uRange,raw['Urms'+e],Math.max(Math.abs(raw['Upkp'+e]),Math.abs(raw['Upkm'+e])),crest);
    var ri=rangeStep(this.iRange[e],PA.I_RANGES,el.iRange,raw['Irms'+e],Math.max(Math.abs(raw['Ipkp'+e]),Math.abs(raw['Ipkm'+e])),crest);
    this.uRange[e]=ru.range;this.iRange[e]=ri.range;
    flags.uRange[e]=ru.range;flags.iRange[e]=ri.range;
    flags.ovrU[e]=ru.ovr;flags.ovrI[e]=ri.ovr;
  }
  var avg=this.avg.push(raw);
  delete raw._h;   // the (averaged) harmonics live in prim; halves the memory
  var t=isFinite(we)?Math.max(we,tb):tb;   // display update moment
  var values=derive(avg,this.cfg);
  this._integrate(values,t);
  this.history.push({
    t:t,ta:fr.ta,tb:fr.tb,periods:periods,sync:sync,
    raw:raw,prim:avg,values:values,flags:flags,avgN:this.avg.n
  });
};

// ─── Energy integration ───
// Runs continuously from the integration start to every display update (not
// averaged, not tied to the measurement intervals): WP = ∫p dt, WP+ / WP−
// for each power flow direction, q = ∫i dt (Ah) with q+ / q−.
Instrument.prototype._integStart=function(){
  var s=this.cfg.integ&&this.cfg.integ.start;
  var t=(s!=null&&s!==''&&isFinite(+s))?+s:(+this.cfg.tStart||0);
  return Math.max(this.prep.t0,t);
};
function newAcc(){var a=[];for(var e=0;e<NEL;e++)a.push({wp:0,wpp:0,wpn:0,q:0,qp:0,qn:0});return a;}
function accumulate(p,fr,acc){
  var dt=p.dt,w=fr.w,n0=fr.n0,len=fr.len;
  for(var e=0;e<NEL;e++){
    var u=p.u[e],i=p.i[e],A=acc[e];
    if(!i)continue;
    var q=0,qp=0,qn=0,wp=0,wpp=0,wpn=0;
    for(var k=0;k<len;k++){
      var wk=w[k];
      if(wk===0)continue;
      var iv=i[n0+k];
      q+=wk*iv;if(iv>0)qp+=wk*iv;else qn+=wk*iv;
      if(u){var pv=u[n0+k]*iv;wp+=wk*pv;if(pv>0)wpp+=wk*pv;else wpn+=wk*pv;}
    }
    A.q+=q*dt;A.qp+=qp*dt;A.qn+=qn*dt;
    if(u){A.wp+=wp*dt;A.wpp+=wpp*dt;A.wpn+=wpn*dt;}
  }
}
function writeInteg(v,acc,time,p,cfg){
  v['ITime:S']=time;
  var G=(cfg.wiring==='3P4W')?[0,1,2]:((cfg.wiring==='3P3W'||cfg.wiring==='3V3A')?[0,1]:[]);
  var sw=0,swp=0,swn=0,okG=G.length>0;
  for(var e=0;e<NEL;e++){
    var c=':'+(e+1),A=acc[e];
    if(p.i[e]){v['q'+c]=A.q/3600;v['qp'+c]=A.qp/3600;v['qn'+c]=A.qn/3600;}
    if(p.u[e]&&p.i[e]){v['WP'+c]=A.wp/3600;v['WPp'+c]=A.wpp/3600;v['WPn'+c]=A.wpn/3600;}
  }
  for(var j=0;j<G.length;j++){
    var g=G[j];
    if(!(p.u[g]&&p.i[g])){okG=false;break;}
    sw+=acc[g].wp;swp+=acc[g].wpp;swn+=acc[g].wpn;
  }
  if(okG){v['WP:S']=sw/3600;v['WPp:S']=swp/3600;v['WPn:S']=swn/3600;}
}
Instrument.prototype._integrate=function(v,t){
  var p=this.prep;
  if(!this.integ){var t0=this._integStart();this.integ={t0:t0,t:t0,acc:newAcc()};}
  var I=this.integ,tEnd=Math.min(t,p.t0+(p.n-1)*p.dt);
  if(tEnd>I.t){
    var fr=intervalFrame(p,I.t,tEnd,0);
    if(fr)accumulate(p,fr,I.acc);
    I.t=tEnd;
  }
  writeInteg(v,I.acc,Math.max(0,I.t-I.t0),p,this.cfg);
};

// Display state at time t: the last update completed at or before t.
Instrument.prototype.resultAt=function(t){
  var h=this.history,lo=0,hi=h.length-1,ans=-1;
  while(lo<=hi){var mid=(lo+hi)>>1;if(h[mid].t<=t){ans=mid;lo=mid+1;}else hi=mid-1;}
  return ans>=0?h[ans]:null;
};
Instrument.prototype.indexAt=function(t){
  var r=this.resultAt(t);
  return r?this.history.indexOf(r):-1;
};

// Instantaneous (scaled) values at time t.
Instrument.prototype.sampleAt=function(t){
  var p=this.prep;
  if(!p)return null;
  var f=(t-p.t0)/p.dt;
  if(f<0||f>p.n-1)return null;
  var n=Math.floor(f),a=f-n;
  if(n>=p.n-1){n=p.n-2;a=1;}
  function at(x){return x?x[n]+(x[n+1]-x[n])*a:NaN;}
  var v={},psum=0,anyP=false;
  for(var e=0;e<NEL;e++){
    var u=at(p.u[e]),i=at(p.i[e]);
    v['u:'+(e+1)]=u;v['i:'+(e+1)]=i;
    var pp=u*i;v['p:'+(e+1)]=pp;
    if(isFinite(pp)&&e<3){psum+=pp;anyP=true;}
  }
  if(anyP)v['p:S']=psum;
  return v;
};

// Ad-hoc evaluation over [ta,tb] without averaging (cursor window). The
// fundamental uses the whole number of periods of fHint that fits in.
Instrument.prototype.measureWindow=function(ta,tb,fHint){
  if(!this.prep)return null;
  var M=(fHint>0)?Math.round((tb-ta)*fHint):0;
  var fr=intervalFrame(this.prep,ta,tb,M>=1?M:0);
  if(!fr)return null;
  var raw=measureRaw(this.prep,this.cfg,fr);
  raw._fsync=M>=1?M/(fr.tb-fr.ta):NaN;
  var values=derive(raw,this.cfg);
  var acc=newAcc();
  accumulate(this.prep,intervalFrame(this.prep,fr.ta,fr.tb,0),acc);
  writeInteg(values,acc,fr.tb-fr.ta,this.prep,this.cfg);
  return {t:tb,ta:fr.ta,tb:fr.tb,periods:M,sync:'window',raw:raw,prim:raw,values:values,
    flags:{ovrU:[],ovrI:[],uRange:[],iRange:[]}};
};
PA.Instrument=Instrument;

// ─── Formatting (shared by any UI) ───
var PREFIX=[[1e12,'T'],[1e9,'G'],[1e6,'M'],[1e3,'k'],[1,''],[1e-3,'m'],[1e-6,'µ'],[1e-9,'n'],[1e-12,'p']];
// 5 significant digits with SI prefix, the way an instrument display shows it.
PA.fmt=function(v,unit,digits){
  if(typeof v==='string')return v;
  if(v==null||!isFinite(v))return '---';
  digits=digits||5;
  unit=unit||'';
  if(unit==='°')return v.toFixed(2)+' °';
  if(unit==='%'){
    var av=Math.abs(v);
    return (av>=1000?v.toFixed(0):av<0.001?'0.000':String(Number(v.toPrecision(Math.min(digits,4)))))+' %';
  }
  if(unit===''&&Math.abs(v)<1000)return v.toFixed(4);
  if(v===0)return '0.0000 '+unit;
  var a=Math.abs(v),k;
  for(k=0;k<PREFIX.length-1;k++)if(a>=PREFIX[k][0]*0.999995)break;
  var sc=v/PREFIX[k][0];
  var intDigits=Math.max(1,Math.floor(Math.log10(Math.abs(sc)))+1);
  var dec=Math.max(0,digits-intDigits);
  return sc.toFixed(dec)+' '+PREFIX[k][1]+unit;
};

if(typeof module!=='undefined'&&module.exports)module.exports=PA;
})(typeof window!=='undefined'?window:(typeof self!=='undefined'?self:globalThis));
