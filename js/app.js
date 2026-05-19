// ═══════════════════════════════════════════════════
// SCHEMATIC FORGE  v2  —  Application Logic
// ═══════════════════════════════════════════════════
/* GRID and schematic core moved to js/schematic.js */
const svg=document.getElementById('schematic-svg');
const lyrW=document.getElementById('lyr-wires');
const lyrC=document.getElementById('lyr-comps');
const lyrJ=document.getElementById('lyr-junc');
const lyrO=document.getElementById('lyr-overlay');

// Undo/Redo history
let undoStack=[]; let redoStack=[]; const HISTORY_MAX=200; let isRestoring=false;

function snapshotState(){
  // View (pan/zoom) is intentionally excluded — it is not part of the schematic data.
  return JSON.stringify({components:S.components,wires:S.wires,junctions:S.junctions,nextId:S.nextId,selected:S.selected});
}

function pushState(){
  if(isRestoring) return;
  try{
    const snap=snapshotState();
    undoStack.push(snap);
    if(undoStack.length>HISTORY_MAX) undoStack.shift();
    // clear redo on new action
    redoStack=[];
  }catch(e){console.warn('pushState failed',e);}
}

function applySnapshot(snap){
  isRestoring=true;
  try{
    const state=JSON.parse(snap);
    S.components=state.components||[];
    S.wires=state.wires||[];
    S.junctions=state.junctions||[];
    S.nextId=state.nextId||1;
    S.selected=state.selected||[];
    // View is NOT restored from history — pan/zoom is independent of undo/redo.
    cancelWire();renderAll();renderProps();
  }catch(e){console.warn('applySnapshot failed',e);} finally{ isRestoring=false; }
}

function undo(){
  // Need at least 2 entries: one to discard (= current state) and one to restore.
  if(undoStack.length < 2) return;
  try{
    const cur=undoStack.pop(); // current state (post-last-action)
    redoStack.push(cur);
    applySnapshot(undoStack[undoStack.length-1]); // restore previous state
  }catch(e){console.warn('undo failed',e);}
}

function redo(){
  if(!redoStack.length) return;
  try{
    const next=redoStack.pop();
    undoStack.push(next);
    applySnapshot(next);
  }catch(e){console.warn('redo failed',e);}
}

function clearHistory(){ undoStack=[];redoStack=[]; }

// Selection-rectangle drag state
let selDrag={active:false,sx:0,sy:0};
let selRectEl=null;

function rectNorm(sx,sy,ex,ey){
  const left=Math.min(sx,ex),right=Math.max(sx,ex),top=Math.min(sy,ey),bottom=Math.max(sy,ey);
  return {left,right,top,bottom,width:right-left,height:bottom-top};
}

function rectContainsRect(outer,inner){
  return inner.left>=outer.left && inner.right<=outer.right && inner.top>=outer.top && inner.bottom<=outer.bottom;
}

function rectIntersects(a,b){
  return !(b.left> a.right || b.right < a.left || b.top > a.bottom || b.bottom < a.top);
}

function updateSelRect(e){
  const pt=svgPt(e); const ep=snp(pt.x,pt.y);
  if(!selRectEl) return;
  const r=rectNorm(selDrag.sx,selDrag.sy,ep.x,ep.y);
  selRectEl.setAttribute('x',r.left); selRectEl.setAttribute('y',r.top);
  selRectEl.setAttribute('width',r.width); selRectEl.setAttribute('height',r.height);
}

function finishSelection(sx,sy,ex,ey){
  const r=rectNorm(sx,sy,ex,ey);
  // If the drag was essentially a click, clear selection
  if(Math.abs(r.width)<GRID && Math.abs(r.height)<GRID){ clearSel(); renderAll(); renderProps(); return; }
  const leftToRight = ex>sx;
  const newSel=[];
  // Components: use hitW/hitH (respecting rotation)
  for(const c of S.components){
    const def=CD[c.type]; const rot=c.rot||0; const isVert=(rot===90||rot===270);
    const hw=(isVert?def.hitH:def.hitW)/2, hh=(isVert?def.hitW:def.hitH)/2;
    const cb={left:c.x-hw,right:c.x+hw,top:c.y-hh,bottom:c.y+hh};
    if(leftToRight){ if(rectContainsRect(r,cb)) newSel.push({type:'comp',id:c.id}); }
    else { if(rectIntersects(r,cb)) newSel.push({type:'comp',id:c.id}); }
  }
  // Wires: use bounding box of points
  for(const w of S.wires){
    if(!w.points||!w.points.length) continue;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of w.points){ if(p.x<minX)minX=p.x;if(p.y<minY)minY=p.y;if(p.x>maxX)maxX=p.x;if(p.y>maxY)maxY=p.y; }
    const wb={left:minX,right:maxX,top:minY,bottom:maxY};
    if(leftToRight){ if(rectContainsRect(r,wb)) newSel.push({type:'wire',id:w.id}); }
    else { if(rectIntersects(r,wb)) newSel.push({type:'wire',id:w.id}); }
  }
  // Junctions: points inside selection
  for(const j of S.junctions){
    if(j.x>=r.left && j.x<=r.right && j.y>=r.top && j.y<=r.bottom){
      newSel.push({type:'junction',id:j.id});
    }
  }
  S.selected=newSel;
  renderAll(); renderProps();
}

/* S, helpers and IDs moved to js/schematic.js */
function svgPt(e){var p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());}
/* pin transform helpers moved to js/schematic.js (xfPin, compPinPos) */

// ═══ VIEW (PAN + ZOOM) ═══
var view={x:0,y:0,zoom:1};
var panState={active:false,sx:0,sy:0,vx:0,vy:0,moved:false};
function applyView(){
  var r=svg.getBoundingClientRect();
  var w=r.width/view.zoom,h=r.height/view.zoom;
  svg.setAttribute('viewBox',view.x+' '+view.y+' '+w+' '+h);
  var bg=document.getElementById('grid-bg');
  if(bg){bg.setAttribute('x',view.x);bg.setAttribute('y',view.y);bg.setAttribute('width',w);bg.setAttribute('height',h);}
}

/* Path helpers moved to js/schematic.js (pts2path, ortho, simplifyPath, buildWirePath) */

/* Finder functions moved to js/schematic.js (findPin, findWireEnd, findWireSeg, nearSeg, juncAt, wireEndsAt) */

// ═══ RENDER ═══
function renderAll(){renderComps();renderWires();renderJuncs();updateStatus();}

function renderComps(){
  lyrC.innerHTML='';
  for(const comp of S.components){
    const def=CD[comp.type];
    var rot=comp.rot||0,mir=comp.mirror||false;
    const g=el('g',{
      transform:`translate(${comp.x},${comp.y})`,
      class:'component-group',
      'data-id':comp.id,'data-type':comp.type,
      'data-label':comp.label||'','data-value':comp.value||''
    });
    var drawG=g;
    if(rot||mir){
      var xf='';if(rot)xf+='rotate('+rot+')';if(mir)xf+=(xf?' ':'')+'scale(-1,1)';
      drawG=el('g',{transform:xf});g.appendChild(drawG);
    }
    def.draw(drawG,comp);
    if(rot||mir){
      var txts=Array.from(drawG.querySelectorAll('text'));
      for(var ti=0;ti<txts.length;ti++){
        var txt=txts[ti],tx=parseFloat(txt.getAttribute('x'))||0,ty=parseFloat(txt.getAttribute('y'))||0;
        var tp2=xfPin(tx,ty,rot,mir);txt.setAttribute('x',tp2.x);txt.setAttribute('y',tp2.y);
        drawG.removeChild(txt);g.appendChild(txt);
      }
    }
    var isVert=(rot===90||rot===270);
    var hrW=isVert?def.hitH:def.hitW,hrH=isVert?def.hitW:def.hitH;
    R(g,-hrW/2,-hrH/2,hrW,hrH,'hit-rect');
    for(let i=0;i<def.pins.length;i++){
      const pin=def.pins[i];
      var tp=xfPin(pin.x,pin.y,rot,mir);
      const r=CE(g,tp.x,tp.y,9,'pin-ring');
      r.setAttribute('data-pin-idx',i);
      r.style.opacity='0';r.style.cursor='crosshair';r.style.pointerEvents='all';
      r.addEventListener('mouseenter',function(){ if(S.mode==='select')this.style.opacity='1'; });
      r.addEventListener('mouseleave',function(){ this.style.opacity='0'; });
      r.addEventListener('mousedown',(function(comp,tpx,tpy,i){return function(ev){
        ev.stopPropagation(); ev.preventDefault();
        var absX=comp.x+tpx,absY=comp.y+tpy;
        if(S.mode==='probe'){
          var def=CD[comp.type];
          var pin=def.pins[i];
          console.log('PROBE PIN: Component='+comp.type+' ('+(comp.label||comp.id)+'), Pin='+pin.n);
          hint('Probed: '+comp.type+'.'+pin.n);
        } else if(S.wire.drawing){handleWireClick({x:absX,y:absY});}
        else{startWireFromPin(absX,absY,{type:'pin',compId:comp.id,pinIdx:i});}
      };})(comp,tp.x,tp.y,i));
    }
    if(S.selected.some(function(s){return s.type==='comp'&&s.id===comp.id;}))g.classList.add('selected');
    g.addEventListener('mousedown',(function(id){return function(e){onCompDown(e,id);};})(comp.id));
    lyrC.appendChild(g);
  }
}

function renderWires(){
  lyrW.innerHTML='';
  for(const w of S.wires){
    const grp=el('g',{
      class:'wire-group','data-id':w.id,
      'data-from':w.from?JSON.stringify(w.from):'',
      'data-to':w.to?JSON.stringify(w.to):''
    });
    const hit=el('path',{d:pts2path(w.points),class:'wire-hit'});
    const vis=el('path',{d:pts2path(w.points),class:'wire-vis'});
    grp.appendChild(hit);grp.appendChild(vis);

    // Add open-end hover rings for wire endpoints not at a pin/junction
    var f=w.points[0],l=w.points[w.points.length-1];
    var endpoints=[f,l];
    for(var ei=0;ei<endpoints.length;ei++){
      var ep=endpoints[ei];
      if(!findPin(ep.x,ep.y,2)){
        var ring=CE(grp,ep.x,ep.y,9,'pin-ring');
        ring.style.opacity='0';ring.style.cursor='crosshair';ring.style.pointerEvents='all';
        ring.addEventListener('mouseenter',function(){ if(S.mode==='select')this.style.opacity='1'; });
        ring.addEventListener('mouseleave',function(){ this.style.opacity='0'; });
        ring.addEventListener('mousedown',(function(epx,epy){return function(ev){
          ev.stopPropagation();ev.preventDefault();
          if(S.wire.drawing){handleWireClick({x:epx,y:epy});}
          else{startWireFromPin(epx,epy,null);}
        };})(ep.x,ep.y));
      }
    }

    // Net name label
    if(w.showLabel&&w.net&&w.points.length>=2){
      var mi=Math.floor((w.points.length-1)/2);
      var lp1=w.points[mi],lp2=w.points[mi+1];
      var lx=(lp1.x+lp2.x)/2,ly=(lp1.y+lp2.y)/2;
      var isVert=(lp1.x===lp2.x);
      var netLbl=el('text',{x:lx,y:isVert?ly:ly-5,class:'wire-net-lbl','text-anchor':'middle'});
      if(isVert)netLbl.setAttribute('transform','rotate(-90,'+lx+','+ly+')');
      netLbl.textContent=w.net;
      grp.appendChild(netLbl);
    }
    if(S.selected.some(function(s){return s.type==='wire'&&s.id===w.id;}))grp.classList.add('selected');
    grp.addEventListener('mousedown',(function(id){return function(e){onWireDown(e,id);};})(w.id));
    lyrW.appendChild(grp);
  }
}

function renderJuncs(){
  lyrJ.innerHTML='';
  for(const j of S.junctions){
    const grp=el('g',{'data-id':j.id,'data-wires':JSON.stringify(j.wires)});
    CE(grp,j.x,j.y,12,'junction-hit');
    const vis=CE(grp,j.x,j.y,5,'junction-vis');
    if(S.selected.some(function(s){return s.type==='junction'&&s.id===j.id;}))vis.classList.add('sel');
    grp.addEventListener('mousedown',(function(id){return function(e){onJuncDown(e,id);};})(j.id));
    lyrJ.appendChild(grp);
  }
}

function updateStatus(){
  document.getElementById('sb-comps').textContent=S.components.length;
  document.getElementById('sb-wires').textContent=S.wires.length;
}

// ═══ PROPERTIES PANEL ═══
function renderProps(){
  document.getElementById('custom-comp-section').style.display='none';
  document.getElementById('custom-comp-edit').style.display='none';
  document.getElementById('props-content').style.display='block';
  const pc=document.getElementById('props-content');
  if(!S.selected.length){pc.innerHTML='<div class="props-empty">Select a component<br>to edit its properties</div>';return;}
  if(S.selected.length>1){pc.innerHTML='<div class="props-empty">'+S.selected.length+' items selected</div>';return;}
  const s=S.selected[0];
  if(s.type==='wire'){
    const w=S.wires.find(function(w){return w.id===s.id;});
    if(!w){return;}
    var netIds=getNetWires(w.id);
    pc.innerHTML='<div class="props-badge">WIRE</div>'+
    '<div class="props-sect">Net</div>'+
    '<div class="prop-row"><div class="prop-lbl">Net Name</div>'+
    '<input class="prop-input" id="wire-net" type="text" value="'+esc(w.net||'')+'"/></div>'+
    '<div class="prop-row" style="flex-direction:row;align-items:center;gap:8px;padding:8px 12px">'+
    '<input type="checkbox" id="wire-show-lbl"'+(w.showLabel?' checked':'')+'>'+
    '<label for="wire-show-lbl" class="prop-lbl" style="margin:0">Show label on this segment</label></div>'+
    '<div class="props-sect">Info</div>'+
    '<div class="info-text">Segments in net: '+netIds.length+'<br>Points: '+w.points.length+'</div>';
    // Live apply: wire net name and showLabel
    const netI=document.getElementById('wire-net');
    if(netI){netI.addEventListener('input',function(){var newNet=netI.value.trim();if(newNet!==(w.net||''))propagateNetName(w.id,newNet);if(newNet){var ids=getNetWires(w.id);syncNetConnsFromNet(ids,newNet);}renderAll();});}
    const showCb=document.getElementById('wire-show-lbl');
    if(showCb){showCb.addEventListener('change',function(){w.showLabel=showCb.checked;renderAll();});}
    return;
  }
  if(s.type==='junction'){
    const j=S.junctions.find(function(j){return j.id===s.id;});
    if(!j)return;
    pc.innerHTML='<div class="props-badge">JUNCTION</div>'+
    '<div class="info-text">Pos: '+j.x+', '+j.y+'<br>Wires: '+j.wires.length+'</div>';
    return;
  }
  const comp=S.components.find(function(c){return c.id===s.id;});
  if(!comp)return;
  const def=CD[comp.type];
  let html='<div class="props-badge">'+comp.type.toUpperCase()+'</div><div class="props-sect">General</div>';
  const curMode = comp.mode || 'DC';
  for(const[key,pd]of Object.entries(def.props||{})){
    if(pd && pd.modes && !pd.modes.includes(curMode)) continue;
    const val=comp[key]||'';
    if(pd.type==='enum'&&Array.isArray(pd.options)){
      html+='<div class="prop-row"><div class="prop-lbl">'+pd.l+'</div><div style="padding:6px 12px;display:flex;gap:8px;align-items:center">';
      for(const opt of pd.options){
        const id='prop-'+key+'-'+opt.v;
        const chk=(String(val)===String(opt.v))?' checked':'';
        html+='<label style="display:flex;align-items:center;gap:6px"><input type="radio" name="prop-'+key+'" data-key="'+key+'" value="'+opt.v+'"'+chk+'> '+opt.l+'</label>';
      }
      html+='</div></div>';
    } else {
      html+='<div class="prop-row"><div class="prop-lbl">'+pd.l+'</div>'+
      '<input class="prop-input" data-key="'+key+'" type="text" value="'+esc(String(val))+'"/></div>';
    }
  }
  // properties apply immediately on change — no Apply button
  html+='<div class="props-sect">Pins</div>';
  for(var pidx=0;pidx<def.pins.length;pidx++){
    var pin=def.pins[pidx];
    var tpp=xfPin(pin.x,pin.y,comp.rot||0,comp.mirror||false);
    const ax=comp.x+tpp.x,ay=comp.y+tpp.y;
    const cnt=S.wires.filter(function(w){const f=w.points[0],l=w.points[w.points.length-1];return(f.x===ax&&f.y===ay)||(l.x===ax&&l.y===ay);}).length;
    html+='<div class="pin-row"><span class="pin-name">'+pin.n+'</span><span class="pin-net">'+(cnt?cnt+' wire(s)':'unconnected')+'</span></div>';
  }
  pc.innerHTML=html;
  // attach live listeners: text inputs
  pc.querySelectorAll('.prop-input').forEach(function(inp){
    var key=inp.getAttribute('data-key');
    inp.addEventListener('input',function(){
      comp[key]=inp.value;
      if(comp.type==='netconn')applyNetConnName(comp);
      renderAll();
      // Don't re-render the props panel on every keystroke (that steals focus).
      // Only re-render if this input explicitly requires it (none do here).
    });
  });
  // radio enums
  pc.querySelectorAll('input[type=radio][data-key]').forEach(function(r){
    var key=r.getAttribute('data-key');
    r.addEventListener('change',function(){
      if(r.checked){
        comp[key]=r.value;
        if(comp.type==='netconn')applyNetConnName(comp);
        renderAll();
        // If the radio toggles the component mode, re-render props to show mode-specific fields
        if(key==='mode')renderProps();
      }
    });
  });
}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}

// ═══ MODE ═══
function setMode(m){
  S.mode=m;
  if(m!=='place'){S.placeType=null;clearGhost();}
  if(m!=='wire'){cancelWire();}
  if(m!=='probe'){clearAllProbeHighlights();}
  document.querySelectorAll('.tb-btn').forEach(function(b){b.classList.remove('active');});
  var btn=document.getElementById('btn-'+m);
  if(btn)btn.classList.add('active');
  document.getElementById('mode-label').textContent=m.toUpperCase();
  svg.style.cursor=m==='wire'||m==='place'?'crosshair':(m==='probe'?'crosshair':'default');
  if(m!=='place')document.querySelectorAll('.comp-btn').forEach(function(b){b.classList.remove('selected');});
  hint(m==='wire'?'Click to start wire \u2014 click again or pin to finish':m==='place'?'Click to place':
    m==='probe'?'Click to probe net or pin \u2014 drag to probe two points':m==='select'?'Click to select \u00b7 drag to move \u00b7 hover pin to start wire':'Click to select \u00b7 drag to move \u00b7 hover pin to start wire');
}

function selectComp(type){
  placeRot=0;placeMirror=false;
  mergeCustomComponents();
  S.placeType=type;setMode('place');
  document.querySelectorAll('.comp-btn').forEach(function(b){b.classList.remove('selected');});
  if(event && event.currentTarget)event.currentTarget.classList.add('selected');
  showGhost(type);
}

// ═══ GHOST ═══
var ghostEl=null;var placeRot=0,placeMirror=false;
function showGhost(t){
  mergeCustomComponents();
  if(!CD[t]){
    console.error('Component not found in CD:',t,' Available:',Object.keys(CD).filter(k=>k.startsWith('custom')));
    return;
  }
  if(typeof CD[t].draw !== 'function'){
    console.error('Component draw is not a function:',t,CD[t]);
    return;
  }
  if(ghostEl && ghostEl.getAttribute('data-type')===t){
    var xf='';if(placeRot)xf+='rotate('+placeRot+')';if(placeMirror)xf+=(xf?' ':'')+'scale(-1,1)';
    var inner=ghostEl.querySelector('.ghost-inner');
    if(inner)inner.setAttribute('transform',xf||'');
    lyrO.appendChild(ghostEl);
    return;
  }
  clearGhost();
  ghostEl=el('g',{class:'ghost component-group',transform:'translate(-9999,-9999)'});
  ghostEl.setAttribute('data-type',t);
  var inner=el('g',{class:'ghost-inner'});
  var xf='';if(placeRot)xf+='rotate('+placeRot+')';if(placeMirror)xf+=(xf?' ':'')+'scale(-1,1)';
  if(xf)inner.setAttribute('transform',xf);
  CD[t].draw(inner,{label:CD[t].lbl,value:CD[t].val});
  ghostEl.appendChild(inner);
  lyrO.appendChild(ghostEl);
}
function clearGhost(){if(ghostEl){ghostEl.remove();ghostEl=null;}}
function moveGhost(x,y){if(ghostEl)ghostEl.setAttribute('transform','translate('+x+','+y+')');}

// ═══ WIRE PREVIEW ═══
var wpEls=[];var srEl=null;
function updateWPrev(ex,ey){
  for(var i=0;i<wpEls.length;i++)wpEls[i].remove();wpEls=[];
  if(srEl){srEl.remove();srEl=null;}
  if(!S.wire.drawing)return;
  // Build full tentative path using buildWirePath so startDir is respected
  var pts=buildWirePath(S.wire.waypoints,{x:ex,y:ey});
  var p=el('path',{d:pts2path(pts),class:'wire-preview'});
  p.style.opacity='1';p.style.strokeDasharray='none';lyrO.appendChild(p);wpEls.push(p);
  srEl=CE(lyrO,ex,ey,6,'snap-ring');
}
function clearWPrev(){for(var i=0;i<wpEls.length;i++)wpEls[i].remove();wpEls=[];if(srEl){srEl.remove();srEl=null;}}
// cancel wire and clear preferred start direction
function cancelWire(){S.wire.drawing=false;S.wire.startPt=null;S.wire.startConn=null;S.wire.waypoints=[];S.wire.startDir=null;S.wire.forceOpen=null;clearWPrev();}

// ═══ PIN RING ═══
var pinRingEl=null;
function showPinRing(x,y){clearPinRing();pinRingEl=CE(lyrO,x,y,9,'pin-ring');pinRingEl.style.opacity='1';}
function clearPinRing(){if(pinRingEl){pinRingEl.remove();pinRingEl=null;}}

// ═══ PROBE MODE ═══
var probeHighlightEl=null;
var probeState={active:false,startX:null,startY:null,startNetName:null,startIsPin:null,dragging:false};
var probeStartHighlightEl=null;
var probeDragLineEl=null;

function showProbeHighlight(x,y,isPin){
  clearProbeHighlight();
  probeHighlightEl=CE(lyrO,x,y,isPin?9:12,'probe-highlight'+(isPin?' pin':''));
  probeHighlightEl.style.opacity='1';
}

function showProbeStartHighlight(x,y,isPin){
  clearProbeStartHighlight();
  probeStartHighlightEl=CE(lyrO,x,y,isPin?9:12,'probe-highlight'+(isPin?' pin':''));
  probeStartHighlightEl.style.opacity='1';
}

function clearProbeHighlight(){
  if(probeHighlightEl){probeHighlightEl.remove();probeHighlightEl=null;}
}

function clearProbeStartHighlight(){
  if(probeStartHighlightEl){probeStartHighlightEl.remove();probeStartHighlightEl=null;}
}

function clearAllProbeHighlights(){
  clearProbeHighlight();
  clearProbeStartHighlight();
  if(probeDragLineEl){probeDragLineEl.remove();probeDragLineEl=null;}
}

function getNetNameAt(x,y){
  var near=findPin(x,y,18);
  if(near&&near.type==='pin'){
    var comp=S.components.find(function(c){return c.id===near.compId;});
    if(comp){
      var def=CD[comp.type];
      var pin=def.pins[near.pinIdx];
      return{comp:comp,pin:pin,compName:comp.type,pinName:pin.n};
    }
  }
  return getNetNameWithTempNames(x,y);
}

function handleProbeClick(pt){
  var near=findPin(pt.x,pt.y,18);
  if(near&&near.type==='pin'){
    var comp=S.components.find(function(c){return c.id===near.compId;});
    if(comp){
      var def=CD[comp.type];
      var pin=def.pins[near.pinIdx];
      console.log('PROBE PIN: Component='+comp.type+' ('+(comp.label||comp.id)+'), Pin='+pin.n);
      hint('Probed: '+comp.type+'.'+pin.n);
    }
    return;
  }
  var wseg=findWireSeg(pt.x,pt.y,10);
  if(wseg){
    var w=S.wires.find(function(wi){return wi.id===wseg.wireId;});
    if(w){
      var netIds=getNetWires(w.id);
      var netName=null;
      for(var i=0;i<netIds.length;i++){
        var nw=S.wires.find(function(nwi){return nwi.id===netIds[i];});
        if(nw&&nw.net){netName=nw.net;break;}
      }
      if(!netName){
        netName='N_'+Math.round(pt.x/GRID)+'_'+Math.round(pt.y/GRID);
      }
      console.log('PROBE NET: '+netName);
      hint('Probed net: '+netName);
      return;
    }
  }
  var j=juncAt(pt.x,pt.y);
  if(j){
    for(var i=0;i<j.wires.length;i++){
      var jw=S.wires.find(function(ww){return ww.id===j.wires[i];});
      if(jw&&jw.net){
        console.log('PROBE NET (junction): '+jw.net);
        hint('Probed net: '+jw.net);
        return;
      }
    }
    console.log('PROBE NET: (junction, unnamed)');
    hint('Probed junction (unnamed net)');
    return;
  }
}

function startProbeDrag(e,pt){
  clearProbeStartHighlight();
  clearProbeHighlight();
  
  var near=findPin(pt.x,pt.y,18);
  var isPin=(near&&near.type==='pin');
  var netName=getNetNameAt(pt.x,pt.y);
  var hasNet=isPin||!!netName;
  
  if(!hasNet){
    return;
  }
  
  probeState.active=true;
  probeState.startX=pt.x;
  probeState.startY=pt.y;
  probeState.startNetName=netName;
  probeState.startIsPin=isPin;
  probeState.dragging=true;
  
  showProbeStartHighlight(pt.x,pt.y,isPin);
  
  probeDragLineEl=el('line',{x1:pt.x,y1:pt.y,x2:pt.x,y2:pt.y,class:'probe-drag-line'});
  lyrO.appendChild(probeDragLineEl);
}

function updateProbeDrag(pt){
  if(!probeDragLineEl)return;
  probeDragLineEl.setAttribute('x2',pt.x);
  probeDragLineEl.setAttribute('y2',pt.y);
}

function endProbeDrag(pt){
  if(!probeState.dragging)return;
  
  if(probeDragLineEl){probeDragLineEl.remove();probeDragLineEl=null;}
  clearProbeStartHighlight();
  clearProbeHighlight();
  
  var startNetName=probeState.startNetName;
  var startIsPin=probeState.startIsPin;
  var endNear=findPin(pt.x,pt.y,18);
  var endIsPin=(endNear&&endNear.type==='pin');
  var endNetName=getNetNameAt(pt.x,pt.y);
  
  if(startIsPin&&endIsPin){
    var startNear=findPin(probeState.startX,probeState.startY,18);
    var startComp=S.components.find(function(c){return c.id===startNear.compId;});
    var endComp=S.components.find(function(c){return c.id===endNear.compId;});
    if(startComp&&endComp){
      var startDef=CD[startComp.type];
      var endDef=CD[endComp.type];
      var startPin=startDef.pins[startNear.pinIdx];
      var endPin=endDef.pins[endNear.pinIdx];
      console.log('PROBE: '+startComp.type+'.'+startPin.n+' -> '+endComp.type+'.'+endPin.n);
      hint('Probed: '+startComp.type+'.'+startPin.n+' -> '+endComp.type+'.'+endPin.n);
    }
  } else if(startIsPin&&!endIsPin){
    var startNear=findPin(probeState.startX,probeState.startY,18);
    var startComp=S.components.find(function(c){return c.id===startNear.compId;});
    var startDef=CD[startComp.type];
    var startPin=startDef.pins[startNear.pinIdx];
    if(endNetName&&typeof endNetName==='object'&&endNetName.comp){
      console.log('PROBE: '+startComp.type+'.'+startPin.n+' -> '+endNetName.compName+'.'+endNetName.pinName);
      hint('Probed: '+startComp.type+'.'+startPin.n+' -> '+endNetName.compName+'.'+endNetName.pinName);
    } else {
      console.log('PROBE: '+startComp.type+'.'+startPin.n+' -> '+(endNetName||'NOTHING'));
      hint('Probed: '+startComp.type+'.'+startPin.n+' -> '+(endNetName||'NOTHING'));
    }
  } else if(!startIsPin&&endIsPin){
    var endComp=S.components.find(function(c){return c.id===endNear.compId;});
    var endDef=CD[endComp.type];
    var endPin=endDef.pins[endNear.pinIdx];
    if(startNetName&&typeof startNetName==='object'&&startNetName.comp){
      console.log('PROBE: '+startNetName.compName+'.'+startNetName.pinName+' -> '+endComp.type+'.'+endPin.n);
      hint('Probed: '+startNetName.compName+'.'+startNetName.pinName+' -> '+endComp.type+'.'+endPin.n);
    } else {
      console.log('PROBE: '+(startNetName||'NOTHING')+' -> '+endComp.type+'.'+endPin.n);
      hint('Probed: '+(startNetName||'NOTHING')+' -> '+endComp.type+'.'+endPin.n);
    }
  } else {
    console.log('PROBE: '+(startNetName||'NOTHING')+' -> '+(endNetName||'NOTHING'));
    hint('Probed: '+(startNetName||'NOTHING')+' -> '+(endNetName||'NOTHING'));
  }
  
  probeState.active=false;
  probeState.dragging=false;
}

// ═══ EVENTS ═══
svg.addEventListener('mousemove',function(e){
  if(panState.active){
    var dx=(e.clientX-panState.sx)/view.zoom,dy=(e.clientY-panState.sy)/view.zoom;
    view.x=panState.vx-dx;view.y=panState.vy-dy;
    if(Math.abs(e.clientX-panState.sx)>3||Math.abs(e.clientY-panState.sy)>3)panState.moved=true;
    applyView();return;
  }
  var pt=svgPt(e);var sp=snp(pt.x,pt.y);
  document.getElementById('sb-x').textContent=sp.x;
  document.getElementById('sb-y').textContent=sp.y;
  if(S.pasteMode.active){
    updatePasteGhosts(sp.x-S.pasteMode.origX,sp.y-S.pasteMode.origY);
    return;
  }
  if(S.mode==='place'){moveGhost(sp.x,sp.y);}
  else if(S.mode==='wire'){
    clearPinRing();
    var near=findPin(pt.x,pt.y);
    var we=!near?findWireEnd(pt.x,pt.y):null;
    var ep=near?{x:near.x,y:near.y}:we?{x:we.x,y:we.y}:sp;
    updateWPrev(ep.x,ep.y);
    if(near)showPinRing(near.x,near.y);
    else if(we)showPinRing(we.x,we.y);
  } else if(S.mode==='select'){
    if(selDrag.active){ updateSelRect(e); return; }
    if(S.drag.active){onDragMove(e);return;}
    clearPinRing();
    var near=findPin(pt.x,pt.y,16);
    if(near&&near.type==='pin'){showPinRing(near.x,near.y);}
    else{
      var we=findWireEnd(pt.x,pt.y);
      if(we)showPinRing(we.x,we.y);
    }
  } else if(S.mode==='probe'){
    if(probeState.dragging){
      updateProbeDrag(pt);
      var nearPin=findPin(pt.x,pt.y,18);
      if(nearPin&&nearPin.type==='pin'){
        showProbeHighlight(nearPin.x,nearPin.y,true);
      } else {
        var wseg=findWireSeg(pt.x,pt.y,10);
        var junc=juncAt(pt.x,pt.y);
        if(wseg||junc){
          showProbeHighlight(pt.x,pt.y,false);
        } else {
          clearProbeHighlight();
        }
      }
      return;
    }
    clearProbeHighlight();
    clearProbeStartHighlight();
    var nearPin=findPin(pt.x,pt.y,18);
    if(nearPin&&nearPin.type==='pin'){
      showProbeHighlight(nearPin.x,nearPin.y,true);
      svg.style.cursor='crosshair';
    } else {
      var wseg=findWireSeg(pt.x,pt.y,10);
      var junc=juncAt(pt.x,pt.y);
      if(wseg||junc){
        showProbeHighlight(pt.x,pt.y,false);
        svg.style.cursor='crosshair';
      } else {
        svg.style.cursor='default';
      }
    }
  }
});
svg.addEventListener('mousedown',function(e){
  if(e.button===2){
    e.preventDefault();
    panState.active=true;panState.sx=e.clientX;panState.sy=e.clientY;
    panState.vx=view.x;panState.vy=view.y;panState.moved=false;
    svg.style.cursor='grabbing';return;
  }
  if(e.target===svg||e.target.id==='grid-bg')onCanvasDown(e);
});
// Double-click while drawing: finish with an open endpoint (no automatic connect)
svg.addEventListener('dblclick',function(e){
  if(S.mode==='wire'&&S.wire.drawing){
    e.preventDefault();e.stopPropagation();
    var pt=svgPt(e);var sp=snp(pt.x,pt.y);
    // Force open endpoint for double-click finish
    S.wire.forceOpen=true;
    finishWire(sp,null);
  }
});
// Use window-level mouseup so releasing the mouse outside the SVG still
// completes any in-progress selection, drag, pan, or probe gesture.
window.addEventListener('mouseup',function(e){
  if(panState.active&&e.button===2){
    panState.active=false;
    svg.style.cursor=S.mode==='wire'||S.mode==='place'?'crosshair':(S.mode==='probe'?'crosshair':'default');
    if(!panState.moved){cancelWire();setMode('select');}
    return;
  }
  if(selDrag.active){
    var pt=svgPt(e);var ep=snp(pt.x,pt.y);
    finishSelection(selDrag.sx,selDrag.sy,ep.x,ep.y);
    if(selRectEl){selRectEl.remove();selRectEl=null;}selDrag.active=false;
    return;
  }
  if(S.drag.active)onDragEnd();
  if(S.mode==='probe'&&probeState.dragging){
    var pt=svgPt(e);
    endProbeDrag(pt);
  }
});
svg.addEventListener('mouseleave',function(){
  if(panState.active){panState.active=false;svg.style.cursor=S.mode==='wire'||S.mode==='place'?'crosshair':'default';}
  if(S.drag.active)onDragEnd();clearPinRing();
});
svg.addEventListener('contextmenu',function(e){
  e.preventDefault();
  if(S.pasteMode.active){cancelPaste();return;}
});
// Wheel zoom
svg.addEventListener('wheel',function(e){
  e.preventDefault();
  var pt=svgPt(e),r=svg.getBoundingClientRect();
  var factor=e.deltaY>0?0.9:1.1;
  var nz=Math.min(10,Math.max(0.1,view.zoom*factor));
  var sx=e.clientX-r.left,sy=e.clientY-r.top;
  view.x=pt.x-sx/nz;view.y=pt.y-sy/nz;
  view.zoom=nz;applyView();
},{passive:false});
window.addEventListener('resize',function(){applyView();});

function onCanvasDown(e){
  if(e.button!==0)return;
  var pt=snp(svgPt(e).x,svgPt(e).y);
  if(S.pasteMode.active){
    confirmPaste(pt.x-S.pasteMode.origX,pt.y-S.pasteMode.origY);
    return;
  }
  if(S.mode==='select'){
    var sp=snp(pt.x,pt.y);
    selDrag.active=true; selDrag.sx=sp.x; selDrag.sy=sp.y;
    selRectEl = el('rect',{x:sp.x,y:sp.y,width:0,height:0});
    selRectEl.setAttribute('fill','#00c8ff22'); selRectEl.setAttribute('stroke','#00c8ff'); selRectEl.setAttribute('stroke-width','1');
    lyrO.appendChild(selRectEl);
    return;
  }
  if(S.mode==='place'&&S.placeType){placeComp(S.placeType,snp(pt.x,pt.y));return;}
  if(S.mode==='wire'){handleWireClick(pt);return;}
  if(S.mode==='probe'){startProbeDrag(e,pt);return;}
}

function onCompDown(e,compId){
  if(e.button!==0)return;e.stopPropagation();
  if(S.mode==='wire'){handleWireClick(svgPt(e));return;}
  if(S.mode==='select'){
    if(!S.selected.some(function(s){return s.type==='comp'&&s.id===compId;})){clearSel();S.selected=[{type:'comp',id:compId}];renderAll();renderProps();}
    startDrag(e,{type:'comp',id:compId});
  }
}
function onWireDown(e,wid){
  if(e.button!==0)return;e.stopPropagation();
  if(S.mode==='probe'){
    var pt=svgPt(e);
    var near=findPin(pt.x,pt.y,18);
    var isPin=(near&&near.type==='pin');
    var netName=getNetNameAt(pt.x,pt.y);
    var hasNet=isPin||!!netName;
    
    if(!hasNet){
      return;
    }
    
    probeState.active=true;
    probeState.startX=pt.x;
    probeState.startY=pt.y;
    probeState.startNetName=netName;
    probeState.startIsPin=isPin;
    probeState.dragging=true;
    
    showProbeStartHighlight(pt.x,pt.y,isPin);
    
    probeDragLineEl=el('line',{x1:pt.x,y1:pt.y,x2:pt.x,y2:pt.y,class:'probe-drag-line'});
    lyrO.appendChild(probeDragLineEl);
    return;
  }
  if(S.mode==='wire'){handleWireClick(svgPt(e));return;}
  if(S.mode==='select'){
    // If this wire is part of a multi-selection, start group drag
    if(S.selected.length>1 && S.selected.some(function(s){return s.type==='wire'&&s.id===wid;})){
      startDrag(e,{type:'wire',id:wid});
      renderAll();renderProps();
    } else {
      clearSel();S.selected=[{type:'wire',id:wid}];
      startWireDrag(e,wid);
      renderAll();renderProps();
    }
  }
}
function onJuncDown(e,jid){
  if(e.button!==0)return;e.stopPropagation();
  if(S.mode==='probe'){
    var pt=svgPt(e);
    var near=findPin(pt.x,pt.y,18);
    var isPin=(near&&near.type==='pin');
    var netName=getNetNameAt(pt.x,pt.y);
    var hasNet=isPin||!!netName;
    
    if(!hasNet){
      return;
    }
    
    probeState.active=true;
    probeState.startX=pt.x;
    probeState.startY=pt.y;
    probeState.startNetName=netName;
    probeState.startIsPin=isPin;
    probeState.dragging=true;
    
    showProbeStartHighlight(pt.x,pt.y,isPin);
    
    probeDragLineEl=el('line',{x1:pt.x,y1:pt.y,x2:pt.x,y2:pt.y,class:'probe-drag-line'});
    lyrO.appendChild(probeDragLineEl);
    return;
  }
  if(S.mode==='wire'){handleWireClick(svgPt(e));return;}
  if(S.mode==='select'){
    if(S.selected.length>1 && S.selected.some(function(s){return s.type==='junction'&&s.id===jid;})){
      startDrag(e,{type:'junction',id:jid});
    } else {
      clearSel();S.selected=[{type:'junction',id:jid}];startDrag(e,{type:'junction',id:jid});
    }
    renderAll();renderProps();
  }
}

// Start wire from pin ring or open wire end
function startWireFromPin(absX,absY,conn){
  clearPinRing();
  // Switch to wire mode WITHOUT calling setMode (which would cancelWire)
  S.mode='wire';
  document.querySelectorAll('.tb-btn').forEach(function(b){b.classList.remove('active');});
  var btn=document.getElementById('btn-wire');if(btn)btn.classList.add('active');
  document.getElementById('mode-label').textContent='WIRE';
  svg.style.cursor='crosshair';
  // Set wire drawing state
  S.wire.drawing=true;
  S.wire.startPt={x:absX,y:absY};
  S.wire.startConn=conn;
  // determine preferred start axis (horizontal 'h' or vertical 'v') based on pin geometry
  if(conn&&conn.type==='pin'){
    var pdir=(function(c){
      try{
        var comp=S.components.find(function(cc){return cc.id===c.compId;});
        if(!comp)return null;
        var def=CD[comp.type];
        var pin=def.pins[c.pinIdx];
        var tp=xfPin(pin.x,pin.y,comp.rot||0,comp.mirror||false);
        return Math.abs(tp.x)>Math.abs(tp.y)?'h':'v';
      }catch(e){return null;}
    })(conn);
    S.wire.startDir=pdir;
  } else S.wire.startDir=null;
  S.wire.waypoints=[];
  hint('Click to place waypoint, click on pin/junction/wire to finish, Esc to cancel');
}

// ═══ WIRE LOGIC ═══
function handleWireClick(pt){
  var near=findPin(pt.x,pt.y);
  var we=!near?findWireEnd(pt.x,pt.y,16):null;
  var sp=near?{x:near.x,y:near.y}:we?{x:we.x,y:we.y}:snp(pt.x,pt.y);
  var wseg=(!near&&!we)?findWireSeg(pt.x,pt.y,10):null;
  var conn=near||we||(wseg?{type:'wire-seg',wireId:wseg.wireId,segIdx:wseg.segIdx,x:sp.x,y:sp.y}:null);

  var isTerminal=!!(near||we||wseg);

  if(!S.wire.drawing){
    S.wire.drawing=true;
    S.wire.startPt=sp;
    S.wire.startConn=conn;
    S.wire.waypoints=[];
    // determine preferred start axis (horizontal 'h' or vertical 'v') when starting from a pin
    if(conn&&conn.type==='pin'){
      var pdir=(function(c){
        try{
          var comp=S.components.find(function(cc){return cc.id===c.compId;});
          if(!comp) return null;
          var def=CD[comp.type];
          var pin=def.pins[c.pinIdx];
          var tp=xfPin(pin.x,pin.y,comp.rot||0,comp.mirror||false);
          return Math.abs(tp.x)>Math.abs(tp.y)?'h':'v';
        }catch(e){return null;}
      })(conn);
      S.wire.startDir=pdir;
    } else {
      S.wire.startDir=null;
    }
    hint('Click to place waypoint, click on pin/junction/wire to finish, Esc to cancel');
  } else {
    if(ptEq(sp,S.wire.startPt)&&S.wire.waypoints.length===0){cancelWire();return;}
    var lastWp=S.wire.waypoints.length?S.wire.waypoints[S.wire.waypoints.length-1]:S.wire.startPt;
    if(ptEq(sp,lastWp)&&!isTerminal)return;

    if(isTerminal){
      finishWire(sp,conn);
    } else {
      S.wire.waypoints.push(sp);
      hint('Click to add waypoint, click on pin/junction/wire to finish, Esc to cancel');
    }
  }
}

function finishWire(endPt,endConn){
  var pts=simplifyPath(buildWirePath(S.wire.waypoints,endPt));
  var wire={id:newId(),points:pts,from:null,to:null};
  S.wires.push(wire);
  // If caller set forceOpen on S.wire, pass the endpoints to cleanup to avoid auto-connecting pins
  var opts=null;
  if(S.wire.forceOpen){opts={forceOpen:true,forcedEndpoints:[{x:pts[0].x,y:pts[0].y},{x:pts[pts.length-1].x,y:pts[pts.length-1].y}]};}
  cleanupNet(wire.id,opts);
  // After cleanup, find a surviving wire at one of our endpoints to propagate net name
  var ep0=pts[0],ep1=pts[pts.length-1];
  var refW=S.wires.find(function(w){return wireEndsAt(w,ep0.x,ep0.y);})
       ||S.wires.find(function(w){return wireEndsAt(w,ep1.x,ep1.y);});
  if(refW&&refW.net){
    var nids=getNetWires(refW.id);
    syncNetConnsFromNet(nids,refW.net);
  }
  cancelWire();renderAll();
  pushState();
  saveSchematic();
}

/* Net cleanup and related helpers moved to js/schematic.js (cleanupNet, pointOnSeg, etc.) */

// ═══ PLACEMENT ═══
function placeComp(type,sp){
  var def=CD[type];
  var cnt=S.components.filter(function(c){return c.type===type;}).length;
  var lbl=type==='netconn'?'NET':def.lbl+(cnt+1);
  var comp={id:newId(),type:type,x:sp.x,y:sp.y,label:lbl,value:def.val,rot:placeRot,mirror:placeMirror,props:{}};
  // initialize enum defaults
  for(const[key,pd]of Object.entries(def.props||{})){
    if(pd.type==='enum'&&Array.isArray(pd.options)&&!comp[key]){comp[key]=pd.options[0].v;}
  }
  S.components.push(comp);
  // Render first so the user sees the placed component immediately
  renderAll();
  // Set sensible defaults for source component variants
  if(type==='source'){
    comp.mode = comp.mode || 'DC';
    comp.meas = comp.meas || 'V';
    comp.value = comp.value || '5';
    // AC defaults
    comp.ac_offset = comp.ac_offset || '0';
    comp.ac_amplitude = comp.ac_amplitude || '1';
    comp.ac_frequency = comp.ac_frequency || '1000';
    comp.ac_tdelay = comp.ac_tdelay || '0';
    comp.ac_theta = comp.ac_theta || '0';
    comp.ac_phi = comp.ac_phi || '0';
    comp.ac_ncycles = comp.ac_ncycles || '1';
    // Pulse defaults
    comp.pulse_vinit = comp.pulse_vinit || '0';
    comp.pulse_von = comp.pulse_von || '5';
    comp.pulse_tdelay = comp.pulse_tdelay || '0';
    comp.pulse_trise = comp.pulse_trise || '1e-6';
    comp.pulse_tfall = comp.pulse_tfall || '1e-6';
    comp.pulse_ton = comp.pulse_ton || '0.001';
    comp.pulse_tperiod = comp.pulse_tperiod || '0.002';
    comp.pulse_ncycles = comp.pulse_ncycles || '1';
    // Behavioural
    comp.beh_eq = comp.beh_eq || '';
  }
  if(type==='netconn')applyNetConnName(comp);
  // Now record history including any defaults applied
  renderAll();
  pushState();
  saveSchematic();
}

/* applyNetConnName moved to js/schematic.js */

// Reverse: update all Net Connectors whose pin touches a wire in the given net
function syncNetConnsFromNet(netWireIds,name){
  if(!name)return;
  for(var ci=0;ci<S.components.length;ci++){
    var comp=S.components[ci];
    if(comp.type!=='netconn')continue;
    var tp=xfPin(CD.netconn.pins[0].x,CD.netconn.pins[0].y,comp.rot||0,comp.mirror||false);
    var px=comp.x+tp.x,py=comp.y+tp.y;
    for(var wi=0;wi<netWireIds.length;wi++){
      var w=S.wires.find(function(ww){return ww.id===netWireIds[wi];});
      if(w&&wireEndsAt(w,px,py)){
        comp.label=name;
        // If this component is currently selected and its props panel is open,
        // update the label input in-place so the user sees the change without
        // re-rendering the entire properties panel (which would steal focus).
        try{
          if(S.selected.length===1&&S.selected[0].type==='comp'&&S.selected[0].id===comp.id){
            var pc=document.getElementById('props-content');
            if(pc){
              var inp=pc.querySelector('.prop-input[data-key="label"]');
              if(inp)inp.value=name;
            }
          }
        }catch(e){}
        break;
      }
    }
  }
}

// ═══ DRAG ═══
function startDrag(e,target){
  var pt=svgPt(e);var sp;
  // If multiple items are selected and the target is among them, start a group drag
  var selIdsComp=new Set(S.selected.filter(s=>s.type==='comp').map(s=>s.id));
  var selIdsJunc=new Set(S.selected.filter(s=>s.type==='junction').map(s=>s.id));
  var selIdsWire=new Set(S.selected.filter(s=>s.type==='wire').map(s=>s.id));
  if(target && ( (target.type==='comp' && selIdsComp.has(target.id) ) || (target.type==='junction' && selIdsJunc.has(target.id)) || (target.type==='wire' && selIdsWire.has(target.id)) ) && S.selected.length>1){
    // Build initial copies
    const groupInitial=[];
    const origWireSignatures=[];
    for(const s of S.selected){
      if(s.type==='comp'){const c=S.components.find(cc=>cc.id===s.id); if(c) groupInitial.push({type:'comp',id:c.id,x:c.x,y:c.y});}
      else if(s.type==='junction'){const j=S.junctions.find(jj=>jj.id===s.id); if(j) groupInitial.push({type:'junction',id:j.id,x:j.x,y:j.y});}
      else if(s.type==='wire'){const w=S.wires.find(ww=>ww.id===s.id); if(w){ groupInitial.push({type:'wire',id:w.id,points: w.points.map(p=>({x:p.x,y:p.y}))}); origWireSignatures.push({id:w.id,pts: JSON.stringify(w.points)});}}
    }
    S.drag={active:true,target:{type:'group'},sm:pt,groupInitial:groupInitial,origWireSignatures:origWireSignatures,moved:false,lastDx:0,lastDy:0};
    return;
  }
  if(target.type==='comp'){var c=S.components.find(function(c){return c.id===target.id;});sp={x:c.x,y:c.y};}
  else if(target.type==='junction'){var j=S.junctions.find(function(j){return j.id===target.id;});sp={x:j.x,y:j.y};}
  else return;
  S.drag={active:true,target:target,sm:pt,sp:sp,moved:false,lastNx:sp.x,lastNy:sp.y};
}

// ═══ WIRE SEGMENT DRAG ═══
function startWireDrag(e,wid){
  var pt=svgPt(e);
  var w=S.wires.find(function(w){return w.id===wid;});if(!w)return;
  var segIdx=-1;
  for(var i=0;i<w.points.length-1;i++){
    if(nearSeg(pt.x,pt.y,w.points[i].x,w.points[i].y,w.points[i+1].x,w.points[i+1].y,16)){segIdx=i;break;}
  }
  if(segIdx<0)return;
  var a=w.points[segIdx],b=w.points[segIdx+1];
  var isHoriz=(a.y===b.y);
  S.drag={active:true,target:{type:'wire-seg',wireId:wid,segIdx:segIdx,isHoriz:isHoriz},sm:pt,sp:{x:0,y:0},moved:false};
}

function onDragMove(e){
  var pt=svgPt(e);
  if(S.drag.target.type==='wire-seg'){onWireSegDragMove(e);return;}
  if(S.drag.target.type==='group'){
    // compute snapped delta from start mouse
    var dx=snap(pt.x-S.drag.sm.x), dy=snap(pt.y-S.drag.sm.y);
    if(dx===S.drag.lastDx && dy===S.drag.lastDy) return;
    S.drag.moved=true; S.drag.lastDx=dx; S.drag.lastDy=dy;
    // Build sets for detecting wires attached to moved components/junctions
    const movedCompIds=new Set(S.selected.filter(s=>s.type==='comp').map(s=>s.id));
    const movedJuncIds=new Set(S.selected.filter(s=>s.type==='junction').map(s=>s.id));
    // Apply positions
    for(const it of S.drag.groupInitial){
      if(it.type==='comp'){
        const c=S.components.find(cc=>cc.id===it.id); if(!c) continue;
        const nx=it.x+dx, ny=it.y+dy; moveComp(it.id,nx,ny);
      } else if(it.type==='junction'){
        const j=S.junctions.find(jj=>jj.id===it.id); if(!j) continue;
        const nx=it.x+dx, ny=it.y+dy; moveJunc(it.id,nx,ny);
      } else if(it.type==='wire'){
        const w=S.wires.find(ww=>ww.id===it.id); if(!w) continue;
        // Skip translating wires whose endpoints are attached to moved components/junctions
        const attachedFrom = w.from && ((w.from.type==='pin' && movedCompIds.has(w.from.compId)) || (w.from.type==='junction' && movedJuncIds.has(w.from.id)));
        const attachedTo = w.to && ((w.to.type==='pin' && movedCompIds.has(w.to.compId)) || (w.to.type==='junction' && movedJuncIds.has(w.to.id)));
        if(attachedFrom || attachedTo) continue;
        // translate all points
        w.points = it.points.map(p=>({x:p.x+dx,y:p.y+dy}));
      }
    }
    renderAll();
    return;
  }
  // Snap the absolute target position to avoid asymmetric rounding on delta
  var nx=snap(S.drag.sp.x+(pt.x-S.drag.sm.x));
  var ny=snap(S.drag.sp.y+(pt.y-S.drag.sm.y));
  if(nx===S.drag.lastNx&&ny===S.drag.lastNy)return;
  S.drag.lastNx=nx;S.drag.lastNy=ny;
  S.drag.moved=true;
  if(S.drag.target.type==='comp')moveComp(S.drag.target.id,nx,ny);
  else if(S.drag.target.type==='junction')moveJunc(S.drag.target.id,nx,ny);
  renderAll();
}

function onWireSegDragMove(e){
  var pt=svgPt(e);
  var t=S.drag.target;
  var w=S.wires.find(function(w){return w.id===t.wireId;});if(!w)return;
  var isFirst=(t.segIdx===0);
  var isLast=(t.segIdx+1===w.points.length-1);
  var fromPin=isFirst&&w.from&&w.from.type==='pin';
  var toPin=isLast&&w.to&&w.to.type==='pin';
  if(fromPin&&toPin)return; // single-segment pin-to-pin, can't drag
  if(t.isHoriz){
    var dy=snap(pt.y-S.drag.sm.y);
    if(dy===0)return;
    S.drag.moved=true;
    if(fromPin){
      // Keep p0 at pin; insert vertical stub + move segment
      var p0=w.points[t.segIdx];
      var p1new={x:w.points[t.segIdx+1].x,y:w.points[t.segIdx+1].y+dy};
      w.points.splice(t.segIdx+1,1,{x:p0.x,y:p0.y+dy},p1new);
      t.segIdx++;
    } else if(toPin){
      // Keep last pin fixed; insert elbow before it
      var pa=w.points[t.segIdx];
      var pb=w.points[t.segIdx+1]; // pin, stays
      w.points.splice(t.segIdx,1,{x:pa.x,y:pa.y+dy},{x:pb.x,y:pb.y+dy});
      // pb is now at t.segIdx+2
    } else {
      w.points[t.segIdx].y+=dy;
      w.points[t.segIdx+1].y+=dy;
    }
    S.drag.sm.y+=dy;
  } else {
    var dx=snap(pt.x-S.drag.sm.x);
    if(dx===0)return;
    S.drag.moved=true;
    if(fromPin){
      var p0=w.points[t.segIdx];
      var p1new={x:w.points[t.segIdx+1].x+dx,y:w.points[t.segIdx+1].y};
      w.points.splice(t.segIdx+1,1,{x:p0.x+dx,y:p0.y},p1new);
      t.segIdx++;
    } else if(toPin){
      var pa=w.points[t.segIdx];
      var pb=w.points[t.segIdx+1];
      w.points.splice(t.segIdx,1,{x:pa.x+dx,y:pa.y},{x:pb.x+dx,y:pb.y});
    } else {
      w.points[t.segIdx].x+=dx;
      w.points[t.segIdx+1].x+=dx;
    }
    S.drag.sm.x+=dx;
  }
  // Update junctions at wire endpoints (only for free endpoints)
  var wf=w.points[0],wl=w.points[w.points.length-1];
  if(isFirst&&!fromPin)updateConnectedEndpoint(w,'from',wf);
  if(isLast&&!toPin)updateConnectedEndpoint(w,'to',wl);
  renderAll();
}

function updateConnectedEndpoint(w,end,pt){
  var conn=(end==='from')?w.from:w.to;
  if(!conn)return;
  if(conn.type==='junction'){
    var j=S.junctions.find(function(jj){return jj.id===conn.id;});
    if(j){
      var ox=j.x,oy=j.y;
      j.x=pt.x;j.y=pt.y;
      for(var i=0;i<S.wires.length;i++){
        var ow=S.wires[i];
        if(ow.id===w.id)continue;
        if(!j.wires.includes(ow.id))continue;
        var of2=ow.points[0],ol=ow.points[ow.points.length-1];
        if(of2.x===ox&&of2.y===oy){
          // update only the start segment, preserve the rest of the waypoints
          if(ow.points.length>1){
            var rest=ow.points.slice(1);
            var newStart=ortho({x:pt.x,y:pt.y},rest[0]);
            ow.points=newStart.concat(rest.slice(1));
          } else {
            ow.points=ortho({x:pt.x,y:pt.y},ol);
          }
          ow.points=simplifyPath(ow.points);
        }
        else if(ol.x===ox&&ol.y===oy){
          // update only the end segment, preserve the preceding waypoints
          if(ow.points.length>1){
            var body=ow.points.slice(0,-1);
            var newEnd=ortho(body[body.length-1],{x:pt.x,y:pt.y});
            ow.points=body.concat(newEnd.slice(1));
          } else {
            ow.points=ortho(of2,{x:pt.x,y:pt.y});
          }
          ow.points=simplifyPath(ow.points);
        }
      }
    }
  }
}

function onDragEnd(){
  if(S.drag.moved&&S.drag.target){
    if(S.drag.target.type==='wire-seg'){
      var w=S.wires.find(function(ww){return ww.id===S.drag.target.wireId;});
      if(w)cleanupNet(w.id);
    } else if(S.drag.target.type==='comp'){
      var comp=S.components.find(function(c){return c.id===S.drag.target.id;});
      if(comp){
        var def=CD[comp.type];
        for(var pi=0;pi<def.pins.length;pi++){
          var pos=compPinPos(comp,pi);
          var w=S.wires.find(function(ww){return wireEndsAt(ww,pos.x,pos.y);});
          if(w)cleanupNet(w.id);
        }
      }
    } else if(S.drag.target.type==='junction'){
      var j=S.junctions.find(function(jj){return jj.id===S.drag.target.id;});
      if(j&&j.wires.length>0){
        var w=S.wires.find(function(ww){return ww.id===j.wires[0];});
        if(w)cleanupNet(w.id);
      }
    } else if(S.drag.target.type==='group'){
      // After a group move, cleanup nets for moved wires (unique)
      const selWireIds = S.selected.filter(s=>s.type==='wire').map(s=>s.id);
      const uniq = Array.from(new Set(selWireIds));
      for(const wid of uniq){ const ww=S.wires.find(w=>w.id===wid); if(ww) cleanupNet(ww.id); }
      // Clean up and re-draw junctions
      cleanJuncs();
      // Remap selected wire IDs in case cleanupNet removed/recreated wires (ids changed)
      if(S.drag.origWireSignatures && S.drag.origWireSignatures.length){
        for(const sig of S.drag.origWireSignatures){
          // try to find a wire with identical points
          const found=S.wires.find(w=>JSON.stringify(w.points)===sig.pts);
          if(found){
            // replace selection entry for old id -> new id
            for(let i=0;i<S.selected.length;i++){
              if(S.selected[i].type==='wire' && S.selected[i].id===sig.id) S.selected[i].id=found.id;
            }
          }
        }
      }
    }
    renderAll();
    pushState();
    saveSchematic();
  }
  S.drag.active=false;S.drag.target=null;
}

function moveComp(compId,nx,ny){
  var c=S.components.find(function(c){return c.id===compId;});if(!c)return;
  var dx=nx-c.x,dy=ny-c.y;c.x=nx;c.y=ny;
  var def=CD[c.type];var rot=c.rot||0,mir=c.mirror||false;
  for(var pi=0;pi<def.pins.length;pi++){
    var tp=xfPin(def.pins[pi].x,def.pins[pi].y,rot,mir);
    var pinX=nx+tp.x,pinY=ny+tp.y;
    var ox=pinX-dx,oy=pinY-dy;
    for(var wi=0;wi<S.wires.length;wi++){
      var w=S.wires[wi];
      if(w.from&&w.from.type==='pin'&&w.from.compId===compId&&w.from.pinIdx===pi)rerouteEnd(w,'from',pinX,pinY);
      if(w.to&&w.to.type==='pin'&&w.to.compId===compId&&w.to.pinIdx===pi)rerouteEnd(w,'to',pinX,pinY);
    }
    var j=juncAt(ox,oy);if(j){j.x=pinX;j.y=pinY;}
  }
}
/* rerouteEnd moved to js/schematic.js */
function moveJunc(jid,nx,ny){
  var j=S.junctions.find(function(jj){return jj.id===jid;});if(!j)return;
  var ox=j.x,oy=j.y;j.x=nx;j.y=ny;
  for(var i=0;i<S.wires.length;i++){
    var w=S.wires[i];
    if(!j.wires.includes(w.id))continue;
    var f=w.points[0],l=w.points[w.points.length-1];
    if(f.x===ox&&f.y===oy){
      if(w.points.length>1){
        var rest=w.points.slice(1);
        var newStart=ortho({x:nx,y:ny},rest[0]);
        w.points=newStart.concat(rest.slice(1));
      } else {
        w.points=ortho({x:nx,y:ny},l);
      }
      w.points=simplifyPath(w.points);
    }
    else if(l.x===ox&&l.y===oy){
      if(w.points.length>1){
        var body=w.points.slice(0,-1);
        var newEnd=ortho(body[body.length-1],{x:nx,y:ny});
        w.points=body.concat(newEnd.slice(1));
      } else {
        w.points=ortho(f,{x:nx,y:ny});
      }
      w.points=simplifyPath(w.points);
    }
  }
}

// ═══ DELETE ═══
function clearSel(){S.selected=[];}
function deleteSelected(){
  for(var i=S.selected.length-1;i>=0;i--){
    var s=S.selected[i];
    if(s.type==='comp')removeComp(s.id);
    else if(s.type==='wire')removeWire(s.id);
    else if(s.type==='junction')removeJunc(s.id);
  }
  S.selected=[];renderAll();renderProps();
  pushState();
  saveSchematic();
}
function removeComp(cid){
  var toRm=S.wires.filter(function(w){return(w.from&&w.from.type==='pin'&&w.from.compId===cid)||(w.to&&w.to.type==='pin'&&w.to.compId===cid);}).map(function(w){return w.id;});
  for(var i=0;i<toRm.length;i++)removeWire(toRm[i]);
  S.components=S.components.filter(function(c){return c.id!==cid;});
  saveSchematic();
}

// ═══ COPY / PASTE ═══
function copyToBuffer(){
  if(S.selected.length===0)return;
  var comps=[],wires=[],juncs=[];
  var selectedIds={comp:{},wire:{},junction:{}};
  for(var i=0;i<S.selected.length;i++){
    var s=S.selected[i];
    selectedIds[s.type][s.id]=true;
  }
  for(var i=0;i<S.components.length;i++){
    var c=S.components[i];
    if(selectedIds.comp[c.id]){comps.push({id:c.id,type:c.type,x:c.x,y:c.y,label:c.label,value:c.value,rot:c.rot,mirror:c.mirror});}
  }
  for(var i=0;i<S.wires.length;i++){
    var w=S.wires[i];
    if(selectedIds.wire[w.id]){
      var newW={id:w.id,points:w.points.slice(),from:null,to:null};
      if(w.from){
        if(w.from.type==='pin'){
          var connCompId=w.from.compId;
          if(selectedIds.comp[connCompId]){
            newW.from={type:'pin',compId:w.from.compId,pinIdx:w.from.pinIdx};
          }
        }else if(w.from.type==='junction'){
          if(selectedIds.junction[w.from.id]){
            newW.from={type:'junction',id:w.from.id};
          }
        }
      }
      if(w.to){
        if(w.to.type==='pin'){
          var connCompId=w.to.compId;
          if(selectedIds.comp[connCompId]){
            newW.to={type:'pin',compId:w.to.compId,pinIdx:w.to.pinIdx};
          }
        }else if(w.to.type==='junction'){
          if(selectedIds.junction[w.to.id]){
            newW.to={type:'junction',id:w.to.id};
          }
        }
      }
      wires.push(newW);
    }
  }
  for(var i=0;i<S.junctions.length;i++){
    var j=S.junctions[i];
    if(selectedIds.junction[j.id]){juncs.push({id:j.id,x:j.x,y:j.y,wires:j.wires.slice()});}
  }
  S.buffer={comps:comps,wires:wires,junctions:juncs};
}

function cutSelected(){
  if(S.selected.length===0)return;
  copyToBuffer();
  deleteSelected();
}

function pasteFromBuffer(){
  if(!S.buffer)return;
  if(S.buffer.comps.length===0&&S.buffer.wires.length===0&&S.buffer.junctions.length===0)return;
  var minX=Infinity,minY=Infinity;
  for(var i=0;i<S.buffer.comps.length;i++){
    minX=Math.min(minX,S.buffer.comps[i].x);
    minY=Math.min(minY,S.buffer.comps[i].y);
  }
  for(var i=0;i<S.buffer.junctions.length;i++){
    minX=Math.min(minX,S.buffer.junctions[i].x);
    minY=Math.min(minY,S.buffer.junctions[i].y);
  }
  for(var i=0;i<S.buffer.wires.length;i++){
    for(var j=0;j<S.buffer.wires[i].points.length;j++){
      minX=Math.min(minX,S.buffer.wires[i].points[j].x);
      minY=Math.min(minY,S.buffer.wires[i].points[j].y);
    }
  }
  S.pasteMode.active=true;
  S.pasteMode.compMap={};
  S.pasteMode.juncMap={};
  S.pasteMode.wireIds=[];
  S.pasteMode.ghostCompEls=[];
  S.pasteMode.ghostJuncEls=[];
  S.pasteMode.ghostWireEls=[];
  S.pasteMode.origX=minX;
  S.pasteMode.origY=minY;
  for(var i=0;i<S.buffer.comps.length;i++){
    var oc=S.buffer.comps[i];
    var nc={id:newId(),type:oc.type,x:oc.x,y:oc.y,label:oc.label,value:oc.value,rot:oc.rot,mirror:oc.mirror};
    S.pasteMode.compMap[oc.id]=nc.id;
    var g=el('g',{class:'component-group ghost',transform:'translate('+nc.x+','+nc.y+')','data-id':nc.id});
    var inner=el('g',{class:''});
    var xf='';if(nc.rot)xf+='rotate('+nc.rot+')';if(nc.mirror)xf+=(xf?' ':'')+'scale(-1,1)';
    if(xf)inner.setAttribute('transform',xf);
    CD[nc.type].draw(inner,{label:nc.label,value:nc.value});
    g.appendChild(inner);
    lyrO.appendChild(g);
    S.pasteMode.ghostCompEls.push(g);
  }
  for(var i=0;i<S.buffer.junctions.length;i++){
    var oj=S.buffer.junctions[i];
    var nj={id:newId(),x:oj.x,y:oj.y,wires:[]};
    S.pasteMode.juncMap[oj.id]=nj.id;
    var jg=el('circle',{cx:nj.x,cy:nj.y,r:5,class:'junction-fill ghost','data-id':nj.id});
    lyrO.appendChild(jg);
    S.pasteMode.ghostJuncEls.push(jg);
  }
  for(var i=0;i<S.buffer.wires.length;i++){
    var ow=S.buffer.wires[i];
    var newPoints=[];
    for(var j=0;j<ow.points.length;j++){newPoints.push({x:ow.points[j].x,y:ow.points[j].y});}
    var newFrom=null,newTo=null;
    if(ow.from&&ow.from.compId&&S.pasteMode.compMap[ow.from.compId]){
      newFrom={type:'pin',compId:S.pasteMode.compMap[ow.from.compId],pinIdx:ow.from.pinIdx};
    }else if(ow.from&&ow.from.id&&S.pasteMode.juncMap[ow.from.id]){
      newFrom={type:'junction',id:S.pasteMode.juncMap[ow.from.id]};
    }
    if(ow.to&&ow.to.compId&&S.pasteMode.compMap[ow.to.compId]){
      newTo={type:'pin',compId:S.pasteMode.compMap[ow.to.compId],pinIdx:ow.to.pinIdx};
    }else if(ow.to&&ow.to.id&&S.pasteMode.juncMap[ow.to.id]){
      newTo={type:'junction',id:S.pasteMode.juncMap[ow.to.id]};
    }
    var nw={id:newId(),points:newPoints,from:newFrom,to:newTo};
    S.pasteMode.wireIds.push(nw.id);
    var pathD=pts2path(newPoints);
    var we=el('path',{d:pathD,class:'wire-hit ghost','data-id':nw.id});
    var wp=el('path',{d:pathD,class:'wire','data-id':nw.id});
    wp.setAttribute('stroke','#00c8ff');
    wp.setAttribute('stroke-width','2');
    lyrO.appendChild(we);
    lyrO.appendChild(wp);
    S.pasteMode.ghostWireEls.push({hit:we,vis:wp});
  }
  hint('Click to place \u00b7 right-click to cancel');
  svg.style.cursor='default';
}

function updatePasteGhosts(dx,dy){
  if(!S.pasteMode.active)return;
  var snapped=snp(S.pasteMode.origX+dx,S.pasteMode.origY+dy);
  var baseX=snapped.x;
  var baseY=snapped.y;
  var origX=S.pasteMode.origX;
  var origY=S.pasteMode.origY;
  for(var i=0;i<S.pasteMode.ghostCompEls.length;i++){
    var oc=S.buffer.comps[i];
    var nx=snp(oc.x+dx,oc.y+dy).x;
    var ny=snp(oc.x+dx,oc.y+dy).y;
    S.pasteMode.ghostCompEls[i].setAttribute('transform','translate('+nx+','+ny+')');
  }
  for(var i=0;i<S.pasteMode.ghostJuncEls.length;i++){
    var oj=S.buffer.junctions[i];
    var nx=snp(oj.x+dx,oj.y+dy).x;
    var ny=snp(oj.x+dx,oj.y+dy).y;
    S.pasteMode.ghostJuncEls[i].setAttribute('cx',nx);
    S.pasteMode.ghostJuncEls[i].setAttribute('cy',ny);
  }
  for(var i=0;i<S.buffer.wires.length;i++){
    var ow=S.buffer.wires[i];
    var newPoints=[];
    for(var j=0;j<ow.points.length;j++){
      var sp=snp(ow.points[j].x+dx,ow.points[j].y+dy);
      newPoints.push(sp);
    }
    var pathD=pts2path(newPoints);
    S.pasteMode.ghostWireEls[i].hit.setAttribute('d',pathD);
    S.pasteMode.ghostWireEls[i].vis.setAttribute('d',pathD);
  }
}

function cancelPaste(){
  if(!S.pasteMode.active)return;
  for(var i=0;i<S.pasteMode.ghostCompEls.length;i++)S.pasteMode.ghostCompEls[i].remove();
  for(var i=0;i<S.pasteMode.ghostJuncEls.length;i++)S.pasteMode.ghostJuncEls[i].remove();
  for(var i=0;i<S.pasteMode.ghostWireEls.length;i++){
    S.pasteMode.ghostWireEls[i].hit.remove();
    S.pasteMode.ghostWireEls[i].vis.remove();
  }
  S.pasteMode.active=false;
  S.pasteMode.compMap={};
  S.pasteMode.juncMap={};
  S.pasteMode.wireIds=[];
  S.pasteMode.ghostCompEls=[];
  S.pasteMode.ghostJuncEls=[];
  S.pasteMode.ghostWireEls=[];
  setMode('select');
}

function confirmPaste(dx,dy){
  if(!S.pasteMode.active)return;
  for(var i=0;i<S.pasteMode.ghostCompEls.length;i++){
    var sp=snp(S.buffer.comps[i].x+dx,S.buffer.comps[i].y+dy);
    var nc={id:S.pasteMode.compMap[S.buffer.comps[i].id],type:S.buffer.comps[i].type,x:sp.x,y:sp.y,label:S.buffer.comps[i].label,value:S.buffer.comps[i].value,rot:S.buffer.comps[i].rot,mirror:S.buffer.comps[i].mirror};
    S.components.push(nc);
    S.pasteMode.ghostCompEls[i].remove();
  }
  for(var i=0;i<S.pasteMode.ghostJuncEls.length;i++){
    var sp=snp(S.buffer.junctions[i].x+dx,S.buffer.junctions[i].y+dy);
    var nj={id:S.pasteMode.juncMap[S.buffer.junctions[i].id],x:sp.x,y:sp.y,wires:[]};
    S.junctions.push(nj);
    S.pasteMode.ghostJuncEls[i].remove();
  }
  for(var i=0;i<S.buffer.wires.length;i++){
    var ow=S.buffer.wires[i];
    var newPoints=[];
    for(var j=0;j<ow.points.length;j++){var sp=snp(ow.points[j].x+dx,ow.points[j].y+dy);newPoints.push(sp);}
    var newFrom=null,newTo=null;
    if(ow.from&&ow.from.compId&&S.pasteMode.compMap[ow.from.compId]){
      newFrom={type:'pin',compId:S.pasteMode.compMap[ow.from.compId],pinIdx:ow.from.pinIdx};
    }else if(ow.from&&ow.from.id&&S.pasteMode.juncMap[ow.from.id]){
      newFrom={type:'junction',id:S.pasteMode.juncMap[ow.from.id]};
    }
    if(ow.to&&ow.to.compId&&S.pasteMode.compMap[ow.to.compId]){
      newTo={type:'pin',compId:S.pasteMode.compMap[ow.to.compId],pinIdx:ow.to.pinIdx};
    }else if(ow.to&&ow.to.id&&S.pasteMode.juncMap[ow.to.id]){
      newTo={type:'junction',id:S.pasteMode.juncMap[ow.to.id]};
    }
    var nw={id:S.pasteMode.wireIds[i],points:newPoints,from:newFrom,to:newTo};
    S.wires.push(nw);
    S.pasteMode.ghostWireEls[i].hit.remove();
    S.pasteMode.ghostWireEls[i].vis.remove();
    for(var k=0;k<S.junctions.length;k++){
      var j=S.junctions[k];
      if(nw.from&&nw.from.type==='junction'&&nw.from.id===j.id)j.wires.push(nw.id);
      if(nw.to&&nw.to.type==='junction'&&nw.to.id===j.id)j.wires.push(nw.id);
    }
  }
  cleanJuncs();
  S.selected=[];
  for(var key in S.pasteMode.compMap){
    S.selected.push({type:'comp',id:S.pasteMode.compMap[key]});
  }
  for(var key in S.pasteMode.juncMap){
    S.selected.push({type:'junction',id:S.pasteMode.juncMap[key]});
  }
  for(var i=0;i<S.pasteMode.wireIds.length;i++){
    S.selected.push({type:'wire',id:S.pasteMode.wireIds[i]});
  }
  S.pasteMode.active=false;
  S.pasteMode.compMap={};
  S.pasteMode.juncMap={};
  S.pasteMode.wireIds=[];
  S.pasteMode.ghostCompEls=[];
  S.pasteMode.ghostJuncEls=[];
  S.pasteMode.ghostWireEls=[];
  renderAll();renderProps();
  pushState();
  saveSchematic();
}
function removeWire(wid){
  if(!S.wires.find(function(w){return w.id===wid;}))return;
  for(var i=0;i<S.junctions.length;i++)S.junctions[i].wires=S.junctions[i].wires.filter(function(id){return id!==wid;});
  S.wires=S.wires.filter(function(w){return w.id!==wid;});
  cleanJuncs();
  saveSchematic();
}
function removeJunc(jid){
  var j=S.junctions.find(function(jj){return jj.id===jid;});if(!j)return;
  if(j.wires.length===2){
    var w1id=j.wires[0],w2id=j.wires[1];
    var w1=S.wires.find(function(w){return w.id===w1id;}),w2=S.wires.find(function(w){return w.id===w2id;});
    if(w1&&w2){
      var f1=w1.points[0],l1=w1.points[w1.points.length-1];
      var f2=w2.points[0];
      var merged,nf=w1.from,nt;
      if(ptEq(l1,{x:j.x,y:j.y})&&ptEq(f2,{x:j.x,y:j.y})){merged=w1.points.concat(w2.points.slice(1));nt=w2.to;}
      else if(ptEq(l1,{x:j.x,y:j.y})){merged=w1.points.concat(w2.points.slice().reverse().slice(1));nt=w2.from;}
      else if(ptEq(f1,{x:j.x,y:j.y})&&ptEq(f2,{x:j.x,y:j.y})){merged=w2.points.slice().reverse().concat(w1.points.slice(1));nf=w2.to;nt=w1.to;}
      else{merged=w2.points.slice().reverse().concat(w1.points.slice(1));nf=w2.from;nt=w1.to;}
      w1.points=merged;w1.from=nf;w1.to=nt;
      S.wires=S.wires.filter(function(w){return w.id!==w2id;});
    }
  } else {
    var wiresCopy=j.wires.slice();
    for(var i=0;i<wiresCopy.length;i++)removeWire(wiresCopy[i]);
  }
  S.junctions=S.junctions.filter(function(jj){return jj.id!==jid;});
  saveSchematic();
}
function cleanJuncs(){
  // Only remove junctions with 0 wires (no auto-merge of 2-wire junctions)
  S.junctions=S.junctions.filter(function(j){return j.wires.length>0;});
}
function clearAll(){
  S.components=[];S.wires=[];S.junctions=[];S.selected=[];S.nextId=1;
  view.x=0;view.y=0;view.zoom=1;
  customComponents={};
  cancelWire();applyView();renderAll();renderProps();
  renderCustomCompsList();
  saveSchematic();
}

// ═══ EXPORT ═══
function exportSVG(){
  var clone=svg.cloneNode(true);
  // remove interactive/overlay elements
  var overlay=clone.querySelector('#lyr-overlay');
  if(overlay)overlay.remove();
  clone.querySelectorAll('.wire-hit,.hit-rect,.junction-hit,.pin-ring,.ghost').forEach(function(e){e.remove();});
  // remove grid and defs so exported SVG is clean for printing
  var gb=clone.querySelector('#grid-bg'); if(gb) gb.remove();
  var defs=clone.querySelector('defs'); if(defs) defs.remove();
  // insert a white background rect for print
  var bgRect=document.createElementNS('http://www.w3.org/2000/svg','rect');
  bgRect.setAttribute('x','0');bgRect.setAttribute('y','0');bgRect.setAttribute('width','100%');bgRect.setAttribute('height','100%');bgRect.setAttribute('fill','#ffffff');
  clone.insertBefore(bgRect,clone.firstChild);
  // Insert print-oriented B/W styles with thicker strokes
  var st=document.createElementNS('http://www.w3.org/2000/svg','style');
  st.textContent='.wire-vis{stroke:#000;stroke-width:2.5;fill:none;stroke-linecap:square}.comp-body{stroke:#000;stroke-width:2;fill:#ffffff}.comp-pin{stroke:#000;stroke-width:2;fill:none}.comp-label{fill:#000;font-family:monospace;font-size:18px}.comp-value{fill:#000;font-family:monospace;font-size:16px}.pin-dot{fill:#000}.junction-vis{fill:#000;stroke:#000;stroke-width:1} text{fill:#000}';
  clone.insertBefore(st,bgRect.nextSibling);
  // Embed schematic state for round-trip import
  var desc=document.createElementNS('http://www.w3.org/2000/svg','desc');
  desc.setAttribute('id','schematic-data');
  var state={components:S.components,wires:S.wires,junctions:S.junctions,nextId:S.nextId};
  desc.textContent=JSON.stringify(state);
  clone.insertBefore(desc,st.nextSibling);
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([clone.outerHTML],{type:'image/svg+xml'}));
  a.download='schematic.svg';a.click();
}

// ═══ IMPORT ═══
function importSVG(){
  var inp=document.createElement('input');
  inp.type='file';inp.accept='.svg,image/svg+xml';
  inp.addEventListener('change',function(){
    var file=inp.files[0];if(!file)return;
    var reader=new FileReader();
    reader.onload=function(ev){
      var parser=new DOMParser();
      var doc=parser.parseFromString(ev.target.result,'image/svg+xml');
      var desc=doc.getElementById('schematic-data');
      if(!desc){
        alert('This SVG has no embedded schematic data.\nOnly SVGs exported from SchematicForge can be imported.');
        return;
      }
        try{
        var state=JSON.parse(desc.textContent);
        S.components=state.components||[];
        S.wires=state.wires||[];
        S.junctions=state.junctions||[];
        S.nextId=state.nextId||1;
        S.selected=[];
        // View is NOT restored from import — open with zoom-to-fit instead.
        cancelWire();renderAll();renderProps();
        zoomToFit();
        // reset history to the imported state
        clearHistory(); pushState();
        saveSchematic();
      } catch(err){
        alert('Failed to parse schematic data: '+err.message);
      }
    };
    reader.readAsText(file);
  });
  inp.click();
}

// ═══ ROTATE / MIRROR ═══
function rotateSelected(){
  for(var i=0;i<S.selected.length;i++){
    var s=S.selected[i];if(s.type!=='comp')continue;
    var comp=S.components.find(function(c){return c.id===s.id;});if(!comp)continue;
    var def=CD[comp.type],oldRot=comp.rot||0,oldMir=comp.mirror||false;
    comp.rot=(oldRot+90)%360;
    rewireComp(comp,def,oldRot,oldMir);
  }
  renderAll();renderProps();
  pushState();
  saveSchematic();
}
function mirrorSelected(){
  for(var i=0;i<S.selected.length;i++){
    var s=S.selected[i];if(s.type!=='comp')continue;
    var comp=S.components.find(function(c){return c.id===s.id;});if(!comp)continue;
    var def=CD[comp.type],oldRot=comp.rot||0,oldMir=comp.mirror||false;
    comp.mirror=!oldMir;
    rewireComp(comp,def,oldRot,oldMir);
  }
  renderAll();renderProps();
  pushState();
  saveSchematic();
}
/* rewireComp moved to js/schematic.js */

// ===== Persistent storage (autosave/load) =====
function saveSchematic(){
  try{
    // View (pan/zoom) is intentionally not saved — schematic always opens with zoom-to-fit.
    var state={components:S.components,wires:S.wires,junctions:S.junctions,nextId:S.nextId,customComponents:customComponents};
    localStorage.setItem('schematic_state',JSON.stringify(state));
  }catch(e){console.warn('Failed to save schematic',e);}
}

function loadSchematic(){
  try{
    var raw=localStorage.getItem('schematic_state');
    if(!raw) return;
    var state=JSON.parse(raw);
    S.components=state.components||[];
    S.wires=state.wires||[];
    S.junctions=state.junctions||[];
    S.nextId=state.nextId||1;
    S.selected=[];
    // View is NOT restored — the schematic will be zoom-to-fit after render.
    if(state.customComponents){
      customComponents=state.customComponents;
      mergeCustomComponents();
      renderCustomCompsList();
    }
    clearHistory(); pushState();
  }catch(e){console.warn('Failed to load schematic',e);}  
}

window.addEventListener('beforeunload',function(){saveSchematic();});

/* Net naming helpers moved to js/schematic.js (getNetWires, propagateNetName) */

// ═══ ZOOM TO FIT ═══
function zoomToFit(){
  if(!S.components.length&&!S.wires.length){
    view.x=0;view.y=0;view.zoom=1;applyView();return;
  }
  var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(var i=0;i<S.components.length;i++){
    var c=S.components[i],def=CD[c.type];
    var rot=c.rot||0,isVert=(rot===90||rot===270);
    var hw=(isVert?def.hitH:def.hitW)/2,hh=(isVert?def.hitW:def.hitH)/2;
    if(c.x-hw<minX)minX=c.x-hw;if(c.y-hh<minY)minY=c.y-hh;
    if(c.x+hw>maxX)maxX=c.x+hw;if(c.y+hh>maxY)maxY=c.y+hh;
  }
  for(var i=0;i<S.wires.length;i++){
    for(var j=0;j<S.wires[i].points.length;j++){
      var p=S.wires[i].points[j];
      if(p.x<minX)minX=p.x;if(p.y<minY)minY=p.y;
      if(p.x>maxX)maxX=p.x;if(p.y>maxY)maxY=p.y;
    }
  }
  var pad=80;minX-=pad;minY-=pad;maxX+=pad;maxY+=pad;
  var bw=maxX-minX,bh=maxY-minY;
  if(bw<=0||bh<=0){view.x=0;view.y=0;view.zoom=1;applyView();return;}
  var r=svg.getBoundingClientRect();
  view.zoom=Math.min(r.width/bw,r.height/bh,5);
  view.x=minX-(r.width/view.zoom-bw)/2;
  view.y=minY-(r.height/view.zoom-bh)/2;
  applyView();
}

// ═══ KEYBOARD ═══
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT')return;
  // Undo / Redo shortcuts
  if((e.ctrlKey||e.metaKey) && (e.key==='z' || e.key==='Z')){
    e.preventDefault(); if(e.shiftKey) redo(); else undo(); return;
  }
  if((e.ctrlKey||e.metaKey) && (e.key==='y' || (e.shiftKey && e.key==='Z'))){ e.preventDefault(); redo(); return; }
  // Copy / Cut / Paste shortcuts
  if((e.ctrlKey||e.metaKey) && (e.key==='c' || e.key==='C')){
    e.preventDefault(); copyToBuffer(); return; }
  if((e.ctrlKey||e.metaKey) && (e.key==='x' || e.key==='X')){
    e.preventDefault(); cutSelected(); return; }
  if((e.ctrlKey||e.metaKey) && (e.key==='v' || e.key==='V')){
    e.preventDefault(); pasteFromBuffer(); return; }
  if(e.key==='Escape'){if(S.pasteMode.active){cancelPaste();}else if(S.mode==='probe'){if(probeState.dragging){probeState.dragging=false;}clearAllProbeHighlights();probeState.active=false;setMode('select');}else{cancelWire();setMode('select');}}
  if(e.key==='v'||e.key==='V'){if(!S.pasteMode.active)setMode('select');}
  if(e.key==='w'||e.key==='W')setMode('wire');
  if(e.key==='p'||e.key==='P')setMode('probe');
  if(e.key==='Delete'||e.key==='Backspace')deleteSelected();
  if(e.key==='r'||e.key==='R'){
    if(S.mode==='place'){placeRot=(placeRot+90)%360;if(S.placeType)showGhost(S.placeType);}
    else if(S.mode==='select')rotateSelected();
  }
  if(e.key==='e'||e.key==='E'){
    if(S.mode==='place'){placeMirror=!placeMirror;if(S.placeType)showGhost(S.placeType);}
    else if(S.mode==='select')mirrorSelected();
  }
});
function hint(m){document.getElementById('sb-hint').textContent=m;}

function showCustomCompPanel(){
  editingCustomCompKey=null;
  document.getElementById('custom-comp-section').style.display='block';
  document.getElementById('custom-comp-edit').style.display='none';
  document.getElementById('props-content').style.display='none';
  ccLeftPins=[''];
  ccRightPins=[''];
  renderCustomPinInputs('left');
  renderCustomPinInputs('right');
  document.getElementById('cc-name').value='';
  document.getElementById('cc-prefix').value='U';
  document.getElementById('cc-desc').value='';
  document.getElementById('cc-model').value='';
}

function hideCustomCompPanel(){
  document.getElementById('custom-comp-section').style.display='none';
  document.getElementById('props-content').style.display='block';
}

function editCustomComp(key){
  var comp=customComponents[key];
  if(!comp)return;
  editingCustomCompKey=key;
  document.getElementById('cc-name').value=comp._name||comp.lbl||'';
  document.getElementById('cc-prefix').value=comp.lbl||'U';
  document.getElementById('cc-desc').value=comp._desc||'';
  document.getElementById('cc-model').value=comp._model||'';
  ccLeftPins=[];
  ccRightPins=[];
  if(comp.pins){
    var leftCount=0,rightCount=0;
    for(var i=0;i<comp.pins.length;i++){
      var pin=comp.pins[i];
      if(pin.x<0){
        while(ccLeftPins.length<=i)ccLeftPins.push('');
        ccLeftPins[i]=pin.n||'';
      }else{
        while(ccRightPins.length<=i)ccRightPins.push('');
        ccRightPins[i]=pin.n||'';
      }
    }
  }
  if(ccLeftPins.length===0)ccLeftPins=[''];
  if(ccRightPins.length===0)ccRightPins=[''];
  renderCustomPinInputs('left');
  renderCustomPinInputs('right');
  document.getElementById('props-content').style.display='none';
  document.getElementById('custom-comp-section').style.display='block';
  document.getElementById('custom-comp-edit').style.display='block';
  var btn=document.getElementById('cc-create-btn');
  if(btn){
    btn.textContent='Apply';
    btn.onclick=applyCustomComp;
  }
}

// ═══ CUSTOM COMPONENT FUNCTIONS ═══
var ccLeftPins=[];
var ccRightPins=[];
var editingCustomCompKey=null;

function renderCustomPinInputs(side){
  var container=document.getElementById('cc-'+side+'-pins');
  var pins=side==='left'?ccLeftPins:ccRightPins;
  var html='';
  for(var i=0;i<pins.length;i++){
    html+='<div class="cc-pin-row"><input type="text" placeholder="Signal name" value="'+esc(pins[i])+'" onchange="updateCustomPin(\''+side+'\','+i+',this.value)"/><button class="tb-btn cc-pin-remove" onclick="removeCustomPin(\''+side+'\','+i+')">x</button></div>';
  }
  container.innerHTML=html;
}

function updateCustomPin(side,idx,val){
  if(side==='left')ccLeftPins[idx]=val;
  else ccRightPins[idx]=val;
}

function addCustomPin(side){
  if(side==='left'){ccLeftPins.push('');renderCustomPinInputs('left');}
  else{ccRightPins.push('');renderCustomPinInputs('right');}
}

function removeCustomPin(side,idx){
  if(side==='left'){ccLeftPins.splice(idx,1);renderCustomPinInputs('left');}
  else{ccRightPins.splice(idx,1);renderCustomPinInputs('right');}
}

function newCustomComp(){
  var name='Custom';
  var prefix='U';
  var key='custom_'+name.toLowerCase();
  var cnt=1;
  while(customComponents[key+cnt])cnt++;
  var fullKey=key+cnt;
  var config={
    name:name+cnt,
    prefix:prefix,
    leftPins:[''],
    rightPins:[''],
    description:'',
    model:''
  };
  createCustomCompDef(fullKey,config);
  customComponents[fullKey]._name=name+cnt;
  mergeCustomComponents();
  renderCustomCompsList();
  saveSchematic();
  editCustomComp(fullKey);
}

function applyCustomComp(){
  var name=document.getElementById('cc-name').value.trim()||'Custom';
  var prefix=document.getElementById('cc-prefix').value.trim()||'U';
  var desc=document.getElementById('cc-desc').value.trim();
  var model=document.getElementById('cc-model').value.trim();
  var validLeft=ccLeftPins.filter(function(p){return p.trim();});
  var validRight=ccRightPins.filter(function(p){return p.trim();});
  if(validLeft.length===0&&validRight.length===0){
    alert('Please add at least one signal name on either side');
    return;
  }
  var existingKey=editingCustomCompKey;
  var newKey='custom_'+name.replace(/[^a-zA-Z0-9]/g,'_').toLowerCase();
  if(existingKey && newKey!==existingKey && customComponents[newKey]){
    alert('Component with name "'+name+'" already exists. Use a different name.');
    return;
  }
  if(existingKey && existingKey!==newKey){
    for(var i=0;i<S.components.length;i++){
      if(S.components[i].type===existingKey){
        S.components[i].type=newKey;
      }
    }
  }
  if(existingKey){
    delete customComponents[existingKey];
    delete CD[existingKey];
  }
  var config={
    name:name,
    prefix:prefix,
    leftPins:ccLeftPins,
    rightPins:ccRightPins,
    description:desc,
    model:model
  };
  var key=createCustomCompDef(newKey,config);
  mergeCustomComponents();
  renderCustomCompsList();
  renderAll();
  saveSchematic();
  editCustomComp(key);
}

function renderCustomCompsList(){
  var container=document.getElementById('custom-comps-list');
  var sidebar=document.getElementById('sidebar-custom-comps');
  if(container)container.innerHTML='';
  if(sidebar)sidebar.innerHTML='<div class="grp-lbl">Custom</div>';
  for(var key in customComponents){
    var def=customComponents[key];
    var row=document.createElement('div');
    row.style.display='flex';
    row.style.alignItems='center';
    row.style.gap='8px';
    row.style.padding='6px 12px';
    row.style.borderBottom='1px solid var(--border)';
    var delBtn=document.createElement('button');
    delBtn.className='tb-btn';
    delBtn.style.width='16px';
    delBtn.style.height='16px';
    delBtn.style.minWidth='16px';
    delBtn.style.padding='0';
    delBtn.style.flex='none';
    delBtn.style.display='flex';
    delBtn.style.alignItems='center';
    delBtn.style.justifyContent='center';
    delBtn.style.fontSize='9px';
    delBtn.title='Delete';
    delBtn.innerHTML='<span style="color:var(--text-mid)">✕</span>';
    delBtn.onclick=function(k,el){return function(){confirmDeleteCustomComp(k,el);};}(key,delBtn);
    var nameLbl=document.createElement('span');
    nameLbl.style.flex='1';
    nameLbl.style.fontSize='11px';
    nameLbl.style.color='var(--text-hi)';
    nameLbl.style.cursor='pointer';
    nameLbl.textContent=def._name||def.lbl;
    nameLbl.onclick=function(k){return function(){editCustomComp(k);};}(key);
    var chk=document.createElement('input');
    chk.type='checkbox';
    chk.value=key;
    chk.id='cc-chk-'+key;
    row.appendChild(delBtn);
    row.appendChild(nameLbl);
    row.appendChild(chk);
    if(container)container.appendChild(row);
    if(sidebar){
      var sbBtn=document.createElement('button');
      sbBtn.className='comp-btn';
      sbBtn.innerHTML='<svg class="comp-prev" viewBox="-10 -8 20 16"><rect x="-8" y="-6" width="16" height="12" stroke="#00c8ff" stroke-width="1.5" fill="none"/><line x1="-4" y1="-3" x2="4" y2="-3" stroke="#00c8ff" stroke-width="1"/><line x1="-4" y1="3" x2="4" y2="3" stroke="#00c8ff" stroke-width="1"/></svg>'+(def._name||def.lbl);
      sbBtn.onclick=function(k){return function(){selectComp(k);};}(key);
      sidebar.appendChild(sbBtn);
    }
  }
}

var pendingDelete=null;
function confirmDeleteCustomComp(key,btnEl){
  if(pendingDelete===key){
    delete customComponents[key];
    delete CD[key];
    pendingDelete=null;
    renderCustomCompsList();
    saveSchematic();
  }else{
    pendingDelete=key;
    btnEl.innerHTML='<span style="color:var(--wire-sel)">✔</span>';
    setTimeout(function(){if(pendingDelete===key){pendingDelete=null;renderCustomCompsList();}},3000);
  }
}

function toggleAllCustomComps(select){
  var container=document.getElementById('custom-comps-list');
  var chks=container.querySelectorAll('input[type=checkbox]');
  for(var i=0;i<chks.length;i++)chks[i].checked=select;
}

function exportSelectedCustomComps(){
  var container=document.getElementById('custom-comps-list');
  var chks=container.querySelectorAll('input[type=checkbox]:checked');
  var data=[];
  for(var i=0;i<chks.length;i++){
    var key=chks[i].value;
    if(customComponents[key]){
      data.push({key:key,definition:customComponents[key]});
    }
  }
  if(data.length===0){
    alert('No components selected');
    return;
  }
  var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='custom_components.json';
  a.click();
}

function importCustomComp(){
  document.getElementById('custom-import-file').click();
}

function handleCustomImport(event){
  var file=event.target.files[0];
  if(!file)return;
  var reader=new FileReader();
  reader.onload=function(e){
    try{
      var data=JSON.parse(e.target.result);
      var arr=Array.isArray(data)?data:[data];
      for(var i=0;i<arr.length;i++){
        var item=arr[i];
        if(item.key&&item.definition){
          customComponents[item.key]=item.definition;
          CD[item.key]=item.definition;
        }
      }
      renderCustomCompsList();
      saveSchematic();
    }catch(err){
      alert('Failed to import: '+err.message);
    }
  };
  reader.readAsText(file);
  event.target.value='';
}

function exportCustomComp(key){
  var def=customComponents[key];
  if(!def)return;
  var data={key:key,definition:def};
  var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=key+'.json';
  a.click();
}

function renderCustomCompExportList(){}

// ═══ INIT ═══
mergeCustomComponents();
loadSchematic();
renderAll();renderProps();
zoomToFit();
if(undoStack.length===0){ clearHistory(); pushState(); }
if(Object.keys(customComponents).length>0){renderCustomCompsList();}

// ═══ SIDEBAR RESIZERS ═══
function initResizer(sidebarId,resizerId,isLeft){
  var sidebar=document.getElementById(sidebarId);
  if(!sidebar) return;
  var resizer=document.createElement('div');
  resizer.id=resizerId;
  resizer.className='sidebar-resizer';
  sidebar.appendChild(resizer);
  var minWidth=parseInt(getComputedStyle(sidebar).minWidth)||180;
  var startX,startWidth;
  function onMouseDown(e){
    startX=e.clientX;
    startWidth=sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor='ew-resize';
    document.addEventListener('mousemove',onMouseMove);
    document.addEventListener('mouseup',onMouseUp);
    e.preventDefault();
  }
  function onMouseMove(e){
    var dx=e.clientX-startX;
    var newWidth=isLeft?startWidth-dx:startWidth+dx;
    if(newWidth>=minWidth) sidebar.style.width=newWidth+'px';
  }
  function onMouseUp(){
    resizer.classList.remove('dragging');
    document.body.style.cursor='';
    document.removeEventListener('mousemove',onMouseMove);
    document.removeEventListener('mouseup',onMouseUp);
  }
  resizer.addEventListener('mousedown',onMouseDown);
}
initResizer('sidebar','sidebar-resizer',false);
initResizer('propspanel','propspanel-resizer',true);

function showNetlist(){
  var netlist=generateNetlist();
  var modal=document.getElementById('netlist-modal');
  var textArea=document.getElementById('netlist-text');
  textArea.value=netlist;
  textArea.rows=Math.max(10,netlist.split('\n').length+2);
  modal.style.display='flex';
  modal.onclick=function(e){if(e.target===modal)closeNetlist();};
}

function closeNetlist(){
  document.getElementById('netlist-modal').style.display='none';
}

function copyNetlist(){
  var textArea=document.getElementById('netlist-text');
  textArea.select();
  document.execCommand('copy');
  hint('Netlist copied to clipboard');
}