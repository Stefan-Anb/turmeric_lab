// ═══════════════════════════════════════════════════
// SCHEMATIC CORE — Data model and pure logic (no DOM)
// ═══════════════════════════════════════════════════
const GRID=20;

// Global schematic state (shared with UI)
let S={
  mode:'select', placeType:null,
  components:[], wires:[], junctions:[],
  selected:[], nextId:1, waypoints:[],
  wire:{drawing:false,startPt:null,startConn:null,waypoints:[],startDir:null,forceOpen:null},
  drag:{active:false,target:null,sm:null,sp:null,moved:false},
  buffer:null,
  pasteMode:{active:false,compMap:{},juncMap:{},wireIds:[],ghostCompEls:[],ghostJuncEls:[],ghostWireEls:[],origX:0,origY:0}
};

function newId(){
  return 'e' + (S.nextId++);
}

function snap(v){
  return Math.round(v/GRID) * GRID;
}

function snp(x,y){
  return { x: snap(x), y: snap(y) };
}

function ptEq(a,b){
  return a.x===b.x && a.y===b.y;
}

function xfPin(px,py,rot,mir){
  if(mir)px=-px;
  var r=(rot||0)*Math.PI/180,c=Math.round(Math.cos(r)),s=Math.round(Math.sin(r));
  return{x:px*c-py*s,y:px*s+py*c};
}
function compPinPos(comp,pi){
  var def=CD[comp.type],pin=def.pins[pi];
  var tp=xfPin(pin.x,pin.y,comp.rot||0,comp.mirror||false);
  return{x:comp.x+tp.x,y:comp.y+tp.y};
}

function pts2path(pts){if(!pts||pts.length<2)return'';return pts.map((p,i)=>`${i===0?'M':'L'}${p.x},${p.y}`).join(' ');} 
function ortho(p1,p2){
  if(p1.x===p2.x||p1.y===p2.y)return[p1,p2];
  return[p1,{x:p2.x,y:p1.y},p2];
}
function simplifyPath(pts){
  if(pts.length<=2) return pts.slice();
  var r=[pts[0]];
  for(var i=1;i<pts.length-1;i++){
    var prev=r[r.length-1], cur=pts[i], next=pts[i+1];
    if(prev.x===cur.x && prev.y===cur.y) continue;
    if((prev.y===cur.y && cur.y===next.y) || (prev.x===cur.x && cur.x===next.x)) continue;
    r.push(cur);
  }
  var last=pts[pts.length-1];
  if(!(r.length===1 && r[0].x===last.x && r[0].y===last.y)) r.push(last);
  return r;
}

function buildWirePath(waypoints,endPt){
  const start = S.wire.startPt;
  if(!waypoints.length){
    if(S.wire.startDir && start && !(start.x===endPt.x||start.y===endPt.y)){
      if(S.wire.startDir==='v') return [start,{x:start.x,y:endPt.y},endPt];
      return [start,{x:endPt.x,y:start.y},endPt];
    }
    return ortho(start,endPt);
  }
  let pts=[];let prev=S.wire.startPt;
  for(const wp of waypoints){const seg=ortho(prev,wp);if(pts.length)seg.shift();pts.push(...seg);prev=wp;}
  const last=ortho(prev,endPt);if(pts.length)last.shift();pts.push(...last);return pts;
}

// ===== Finders (pure, no DOM access) =====
function findPin(x,y,dist=18,exComp=null){
  let best=null,bd=dist;
  for(const c of S.components){
    if(c.id===exComp)continue;
    var rot=c.rot||0,mir=c.mirror||false;
    for(let i=0;i<CD[c.type].pins.length;i++){
      var tp=xfPin(CD[c.type].pins[i].x,CD[c.type].pins[i].y,rot,mir);
      const px=c.x+tp.x,py=c.y+tp.y;
      const d=Math.hypot(x-px,y-py);
      if(d<bd){bd=d;best={type:'pin',compId:c.id,pinIdx:i,x:px,y:py};}
    }
  }
  for(const j of S.junctions){const d=Math.hypot(x-j.x,y-j.y);if(d<bd){bd=d;best={type:'junction',id:j.id,x:j.x,y:j.y};}}
  return best;
}
function findWireEnd(x,y,dist=16){
  let best=null,bd=dist;
  for(const w of S.wires){const f=w.points[0],l=w.points[w.points.length-1];for(const ep of [f,l]){const d=Math.hypot(x-ep.x,y-ep.y);if(d<bd){const atPin=findPin(ep.x,ep.y,2);if(!atPin){bd=d;best={type:'wire-end',wireId:w.id,x:ep.x,y:ep.y};}}}}return best;
}
function findWireSeg(x,y,tol=10){
  for(const w of S.wires)for(let i=0;i<w.points.length-1;i++){const a=w.points[i],b=w.points[i+1];if(nearSeg(x,y,a.x,a.y,b.x,b.y,tol))return{wireId:w.id,segIdx:i};}
  return null;
}
function nearSeg(px,py,ax,ay,bx,by,tol){const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;if(l2===0)return Math.hypot(px-ax,py-ay)<tol;const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));return Math.hypot(px-(ax+t*dx),py-(ay+t*dy))<tol;}
function juncAt(x,y){return S.junctions.find(j=>j.x===x&&j.y===y)||null;}
function wireEndsAt(w,x,y){if(!w.points.length)return false;const f=w.points[0],l=w.points[w.points.length-1];return(f.x===x&&f.y===y)||(l.x===x&&l.y===y);} 

// ===== Net cleanup helpers =====
function pointOnSeg(p,a,b){
  if(a.y===b.y&&p.y===a.y){var minX=Math.min(a.x,b.x),maxX=Math.max(a.x,b.x);return p.x>=minX&&p.x<=maxX;}
  if(a.x===b.x&&p.x===a.x){var minY=Math.min(a.y,b.y),maxY=Math.max(a.y,b.y);return p.y>=minY&&p.y<=maxY;}
  return false;
}
function pointOnSegStrict(p,a,b){if(ptEq(p,a)||ptEq(p,b))return false;return pointOnSeg(p,a,b);} 
function findPinAt(x,y){
  for(var ci=0;ci<S.components.length;ci++){var c=S.components[ci],def=CD[c.type],rot=c.rot||0,mir=c.mirror||false;for(var pi=0;pi<def.pins.length;pi++){var tp=xfPin(def.pins[pi].x,def.pins[pi].y,rot,mir);if(c.x+tp.x===x&&c.y+tp.y===y)return{type:'pin',compId:c.id,pinIdx:pi};}}return null;
}
function findAllConnectedWires(startWireId){
  var visited={};visited[startWireId]=true;var queue=[startWireId];
  while(queue.length){var wid=queue.shift();var w=S.wires.find(function(ww){return ww.id===wid;});if(!w)continue;var eps=[w.points[0],w.points[w.points.length-1]];for(var ei=0;ei<eps.length;ei++){var ep=eps[ei];var j=juncAt(ep.x,ep.y);if(j){for(var ji=0;ji<j.wires.length;ji++){if(!visited[j.wires[ji]]){visited[j.wires[ji]]=true;queue.push(j.wires[ji]);}}}for(var wi=0;wi<S.wires.length;wi++){var ow=S.wires[wi];if(!visited[ow.id]&&wireEndsAt(ow,ep.x,ep.y)){visited[ow.id]=true;queue.push(ow.id);}}for(var wi2=0;wi2<S.wires.length;wi2++){var ow2=S.wires[wi2];if(visited[ow2.id])continue;for(var si=0;si<ow2.points.length-1;si++){if(pointOnSeg(ep,ow2.points[si],ow2.points[si+1])){visited[ow2.id]=true;queue.push(ow2.id);break;}}}}for(var wi3=0;wi3<S.wires.length;wi3++){var ow3=S.wires[wi3];if(visited[ow3.id])continue;var oeps=[ow3.points[0],ow3.points[ow3.points.length-1]];for(var oei=0;oei<oeps.length;oei++){var oep=oeps[oei];for(var si2=0;si2<w.points.length-1;si2++){if(pointOnSeg(oep,w.points[si2],w.points[si2+1])){visited[ow3.id]=true;queue.push(ow3.id);break;}}if(visited[ow3.id])break;}}}
  return Object.keys(visited);
}

function cleanupNet(startWireId,opts){
  opts=opts||{};
  if(!S.wires.find(function(w){return w.id===startWireId;}))return;
  var ptKey=function(p){return p.x+','+p.y;};
  var netWireIds=findAllConnectedWires(startWireId);
  if(!netWireIds.length)return;
  var netName=null;for(var i=0;i<netWireIds.length;i++){var w=S.wires.find(function(ww){return ww.id===netWireIds[i];});if(w&&w.net)netName=w.net;}
  var lines=[];for(var i2=0;i2<netWireIds.length;i2++){var w2=S.wires.find(function(ww){return ww.id===netWireIds[i2];});if(!w2)continue;for(var j=0;j<w2.points.length-1;j++){lines.push({p1:{x:w2.points[j].x,y:w2.points[j].y},p2:{x:w2.points[j+1].x,y:w2.points[j+1].y}});}}
  S.junctions=S.junctions.filter(function(j){return !j.wires.some(function(wid){return netWireIds.indexOf(wid)>=0;});});
  S.wires=S.wires.filter(function(w){return netWireIds.indexOf(w.id)<0;});
  S.selected=S.selected.filter(function(s){if(s.type==='wire')return!!S.wires.find(function(w){return w.id===s.id;});if(s.type==='junction')return!!S.junctions.find(function(j){return j.id===s.id;});return true;});
  if(!lines.length)return;
  lines=lines.filter(function(l){return!(l.p1.x===l.p2.x&&l.p1.y===l.p2.y);} );
  for(var i3=lines.length-1;i3>=0;i3--){for(var j3=0;j3<i3;j3++){if((ptEq(lines[i3].p1,lines[j3].p1)&&ptEq(lines[i3].p2,lines[j3].p2))||(ptEq(lines[i3].p1,lines[j3].p2)&&ptEq(lines[i3].p2,lines[j3].p1))){lines.splice(i3,1);break;}}}
  var didMerge=true;while(didMerge){didMerge=false;for(var i4=0;i4<lines.length&&!didMerge;i4++){for(var j4=i4+1;j4<lines.length&&!didMerge;j4++){var li=lines[i4],lj=lines[j4];var shared=null,otherI=null,otherJ=null; if(ptEq(li.p1,lj.p1)){shared=li.p1;otherI=li.p2;otherJ=lj.p2;} else if(ptEq(li.p1,lj.p2)){shared=li.p1;otherI=li.p2;otherJ=lj.p1;} else if(ptEq(li.p2,lj.p1)){shared=li.p2;otherI=li.p1;otherJ=lj.p2;} else if(ptEq(li.p2,lj.p2)){shared=li.p2;otherI=li.p1;otherJ=lj.p1;} if(!shared)continue; var iH=(li.p1.y===li.p2.y),iV=(li.p1.x===li.p2.x); var jH=(lj.p1.y===lj.p2.y),jV=(lj.p1.x===lj.p2.x); if(!((iH&&jH)||(iV&&jV)))continue; var blocked=false; for(var k=0;k<lines.length;k++){if(k===i4||k===j4)continue; if(ptEq(lines[k].p1,shared)||ptEq(lines[k].p2,shared)){blocked=true;break;}} if(blocked)continue; if(findPinAt(shared.x,shared.y))continue; lines[i4]={p1:{x:otherI.x,y:otherI.y},p2:{x:otherJ.x,y:otherJ.y}}; lines.splice(j4,1); didMerge=true;}}}
  var toRemove=[];for(var ii=0;ii<lines.length;ii++){for(var jj=0;jj<lines.length;jj++){if(ii===jj)continue; if(pointOnSeg(lines[ii].p1,lines[jj].p1,lines[jj].p2)&& pointOnSeg(lines[ii].p2,lines[jj].p1,lines[jj].p2)){toRemove.push(ii);break;}}}
  toRemove=toRemove.filter(function(v,i,a){return a.indexOf(v)===i;}).sort(function(a,b){return b-a;}); for(var ri=0;ri<toRemove.length;ri++)lines.splice(toRemove[ri],1);
  if(!lines.length)return;
  var juncPts=[];var changed=true;while(changed){changed=false;for(var i5=0;i5<lines.length&&!changed;i5++){var endpoints=[lines[i5].p1,lines[i5].p2];for(var ep=0;ep<2&&!changed;ep++){var pt=endpoints[ep];for(var j5=0;j5<lines.length;j5++){if(i5===j5)continue; if(pointOnSegStrict(pt,lines[j5].p1,lines[j5].p2)){var newLine={p1:{x:pt.x,y:pt.y},p2:{x:lines[j5].p2.x,y:lines[j5].p2.y}}; lines[j5].p2={x:pt.x,y:pt.y}; lines.push(newLine); if(!juncPts.find(function(jp){return jp.x===pt.x&&jp.y===pt.y;})) juncPts.push({x:pt.x,y:pt.y}); changed=true;break;}}}}}
  var ptCnt={};for(var i6=0;i6<lines.length;i6++){var k1=ptKey(lines[i6].p1),k2=ptKey(lines[i6].p2);ptCnt[k1]=(ptCnt[k1]||0)+1;ptCnt[k2]=(ptCnt[k2]||0)+1;}for(var k in ptCnt){if(ptCnt[k]>=3){var parts=k.split(',');var px=parseInt(parts[0]),py=parseInt(parts[1]); if(!juncPts.find(function(jp){return jp.x===px&&jp.y===py;})) juncPts.push({x:px,y:py});}}
  var adj={};for(var i7=0;i7<lines.length;i7++){var k1=ptKey(lines[i7].p1),k2=ptKey(lines[i7].p2); if(!adj[k1])adj[k1]=[]; if(!adj[k2])adj[k2]=[]; adj[k1].push(i7); adj[k2].push(i7);} var juncSet={}; for(var ji=0;ji<juncPts.length;ji++)juncSet[ptKey(juncPts[ji])]=true; var isBreak=function(pk){ if(juncSet[pk])return true; var deg=adj[pk]?adj[pk].length:0; if(deg!==2)return true; var parts=pk.split(','); if(findPinAt(parseInt(parts[0]),parseInt(parts[1])))return true; return false; };
  var used={}; var wirePaths=[]; for(var startIdx=0;startIdx<lines.length;startIdx++){ if(used[startIdx])continue; used[startIdx]=true; var chain=[startIdx]; var curPt=lines[startIdx].p1; while(!isBreak(ptKey(curPt))){ var neigh=adj[ptKey(curPt)]; var next=-1; for(var n=0;n<neigh.length;n++){if(!used[neigh[n]]){next=neigh[n];break;}} if(next<0)break; chain.unshift(next);used[next]=true; var nl=lines[next]; curPt=ptEq(curPt,nl.p1)?nl.p2:nl.p1; } curPt=lines[startIdx].p2; while(!isBreak(ptKey(curPt))){ var neigh2=adj[ptKey(curPt)]; var next2=-1; for(var n2=0;n2<neigh2.length;n2++){if(!used[neigh2[n2]]){next2=neigh2[n2];break;}} if(next2<0)break; chain.push(next2);used[next2]=true; var nl2=lines[next2]; curPt=ptEq(curPt,nl2.p1)?nl2.p2:nl2.p1; } if(!chain.length)continue; var pts=[]; if(chain.length===1){ pts=[{x:lines[chain[0]].p1.x,y:lines[chain[0]].p1.y},{x:lines[chain[0]].p2.x,y:lines[chain[0]].p2.y}]; } else { var fl=lines[chain[0]],sl=lines[chain[1]]; if(ptEq(fl.p2,sl.p1)||ptEq(fl.p2,sl.p2)){ pts.push({x:fl.p1.x,y:fl.p1.y});pts.push({x:fl.p2.x,y:fl.p2.y}); }else{ pts.push({x:fl.p2.x,y:fl.p2.y});pts.push({x:fl.p1.x,y:fl.p1.y}); } for(var k=1;k<chain.length;k++){ var ln=lines[chain[k]]; var last=pts[pts.length-1]; pts.push(ptEq(last,ln.p1)?{x:ln.p2.x,y:ln.p2.y}:{x:ln.p1.x,y:ln.p1.y}); } } wirePaths.push(pts); }
  var newJunc={}; for(var ji2=0;ji2<juncPts.length;ji2++){var jp=juncPts[ji2]; newJunc[ptKey(jp)]={id:newId(),x:jp.x,y:jp.y,wires:[]};}
  for(var i8=0;i8<wirePaths.length;i8++){var wpts=wirePaths[i8]; if(wpts.length<2)continue; var wid=newId(); var nw={id:wid,points:wpts,from:null,to:null}; if(netName)nw.net=netName; var fp=wpts[0],lp=wpts[wpts.length-1]; var skipFp=false,skipLp=false; if(opts&&opts.forceOpen&&Array.isArray(opts.forcedEndpoints)){for(var fi=0;fi<opts.forcedEndpoints.length;fi++){var fe=opts.forcedEndpoints[fi]; if(ptEq(fe,fp))skipFp=true; if(ptEq(fe,lp))skipLp=true;}} var fpPin = skipFp?null:findPinAt(fp.x,fp.y); var lpPin = skipLp?null:findPinAt(lp.x,lp.y); if(fpPin)nw.from=fpPin; if(lpPin)nw.to=lpPin; var fk=ptKey(fp),lk=ptKey(lp); if(newJunc[fk]){newJunc[fk].wires.push(wid);if(!nw.from)nw.from={type:'junction',id:newJunc[fk].id};} if(newJunc[lk]){newJunc[lk].wires.push(wid);if(!nw.to)nw.to={type:'junction',id:newJunc[lk].id};} S.wires.push(nw); }
  for(var k in newJunc){ if(newJunc[k].wires.length>0)S.junctions.push(newJunc[k]); }
}

// ===== Placement/net helpers =====
function applyNetConnName(comp){
  if(comp.type!=='netconn'||!comp.label)return;
  var tp=xfPin(CD.netconn.pins[0].x,CD.netconn.pins[0].y,comp.rot||0,comp.mirror||false);
  var px=comp.x+tp.x,py=comp.y+tp.y;
  for(var i=0;i<S.wires.length;i++){var w=S.wires[i]; if(wireEndsAt(w,px,py)){propagateNetName(w.id,comp.label); return;}}
}

function getNetWires(startId){
  var visited=[startId];var queue=[startId];while(queue.length){var wid=queue.shift();var w=S.wires.find(function(ww){return ww.id===wid;});if(!w)continue;var eps=[w.points[0],w.points[w.points.length-1]];for(var ei=0;ei<eps.length;ei++){var ep=eps[ei];var j=juncAt(ep.x,ep.y);if(j){for(var ji=0;ji<j.wires.length;ji++){if(visited.indexOf(j.wires[ji])<0){visited.push(j.wires[ji]);queue.push(j.wires[ji]);}}}for(var wi=0;wi<S.wires.length;wi++){var ow=S.wires[wi]; if(visited.indexOf(ow.id)<0&&wireEndsAt(ow,ep.x,ep.y)){visited.push(ow.id);queue.push(ow.id);} } }} return visited; }

function propagateNetName(startId,name){var ids=getNetWires(startId);for(var i=0;i<ids.length;i++){var w=S.wires.find(function(ww){return ww.id===ids[i];});if(w)w.net=name;}}

function rerouteEnd(w,end,nx,ny){
  if(w.points.length<2){w.points=ortho({x:nx,y:ny},{x:nx,y:ny});return;}
  if(end==='from'){var rest=w.points.slice(1);w.points=simplifyPath(ortho({x:nx,y:ny},rest[0]).concat(rest.slice(1)));}
  else {var body=w.points.slice(0,-1);w.points=simplifyPath(body.concat(ortho(body[body.length-1],{x:nx,y:ny}).slice(1)));}
}

function rewireComp(comp,def,oldRot,oldMir){
  for(var pi=0;pi<def.pins.length;pi++){
    var oldP=xfPin(def.pins[pi].x,def.pins[pi].y,oldRot,oldMir);
    var newP=xfPin(def.pins[pi].x,def.pins[pi].y,comp.rot||0,comp.mirror||false);
    var oldX=comp.x+oldP.x,oldY=comp.y+oldP.y;
    var newX=comp.x+newP.x,newY=comp.y+newP.y;
    if(oldX===newX&&oldY===newY)continue;
    for(var wi=0;wi<S.wires.length;wi++){
      var w=S.wires[wi];
      if(w.from&&w.from.type==='pin'&&w.from.compId===comp.id&&w.from.pinIdx===pi)rerouteEnd(w,'from',newX,newY);
      if(w.to&&w.to.type==='pin'&&w.to.compId===comp.id&&w.to.pinIdx===pi)rerouteEnd(w,'to',newX,newY);
    }
    var j=juncAt(oldX,oldY);if(j){j.x=newX;j.y=newY;}
  }
}
