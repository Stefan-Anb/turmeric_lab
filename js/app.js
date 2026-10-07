// ═══════════════════════════════════════════════════
// TURMERICLAB  v2  —  Application Logic
// ═══════════════════════════════════════════════════
/* GRID and schematic core moved to js/schematic.js */
const svg=document.getElementById('schematic-svg');
const lyrBlk=document.getElementById('lyr-blankets');
const lyrW=document.getElementById('lyr-wires');
const lyrC=document.getElementById('lyr-comps');
const lyrJ=document.getElementById('lyr-junc');
const lyrO=document.getElementById('lyr-overlay');

// Pure UI annotation types (never appear in the netlist, never rotate/mirror).
const UI_ANNOTATION_TYPES=['blanket','image','note','textlabel'];
// Types anchored at their TOP-LEFT corner (x,y) with explicit w/h, instead of
// the usual "anchored at center" convention every electrical component uses.
const TOPLEFT_BOX_TYPES=['blanket','image','note'];

// Bounding box (world coords) for a component, used by marquee selection and
// zoom-to-fit. Handles the top-left-anchored box types and the measured
// text-label bbox specially; falls back to the usual centered hitW/hitH box.
function compBBox(c){
  if(TOPLEFT_BOX_TYPES.includes(c.type)){
    var w=parseFloat(c.w)||(c.type==='image'?200:(c.type==='note'?220:400));
    var h=parseFloat(c.h)||(c.type==='image'?150:(c.type==='note'?160:300));
    return {left:c.x,right:c.x+w,top:c.y,bottom:c.y+h};
  }
  if(c.type==='textlabel'){
    var fs=parseFloat(c.fontSize)||16;
    var mx=c._mx!=null?c._mx:0, my=c._my!=null?c._my:-fs;
    var mw=c._mw!=null?c._mw:((c.label||'').length*fs*0.6), mh=c._mh!=null?c._mh:fs*1.3;
    return {left:c.x+mx,right:c.x+mx+mw,top:c.y+my,bottom:c.y+my+mh};
  }
  const def=CD[c.type]; const rot=c.rot||0; const isVert=(rot===90||rot===270);
  const hw=(isVert?def.hitH:def.hitW)/2, hh=(isVert?def.hitW:def.hitH)/2;
  return {left:c.x-hw,right:c.x+hw,top:c.y-hh,bottom:c.y+hh};
}

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
  // Components: use compBBox (respecting rotation / top-left-anchored types)
  for(const c of S.components){
    // Blanket is a pure background annotation: never selectable via marquee,
    // only via its title text (see onBlanketTitleDown).
    if(c.type==='blanket') continue;
    const cb=compBBox(c);
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
function renderAll(){renderBlankets();renderComps();renderWires();renderJuncs();updateStatus();}

// Appends a small circular resize handle (corner, free w+h resize) at local
// (hx,hy) inside g, wired to start a resize drag on mousedown. Only ever
// called for the currently-selected element (handles aren't rendered
// otherwise).
function addResizeHandle(g,hx,hy,cursor,target){
  var h=CE(g,hx,hy,6,'resize-handle');
  h.style.cursor=cursor;
  h.addEventListener('mousedown',function(e){ startResizeDrag(e,target); });
  return h;
}

// Appends a crop handle at the midpoint of one edge — deliberately shaped
// and colored differently from addResizeHandle's round corner dot (a small
// notched bracket, the same "trim this edge" affordance used by crop tools
// in image editors) so the two are never confused by touch/click.
// orientation 'h' = handle sits on a horizontal (top/bottom) edge, so the
// bracket opens vertically; 'v' = left/right edge, bracket opens horizontally.
function addCropHandle(g,hx,hy,orientation,cursor,target){
  var grp=el('g',{class:'crop-handle',transform:`translate(${hx},${hy})`});
  grp.style.cursor=cursor;
  if(orientation==='h'){
    R(grp,-9,-3,18,6,'crop-handle-bar');
    L(grp,-9,-6,-9,6,'crop-handle-tick');
    L(grp,9,-6,9,6,'crop-handle-tick');
  } else {
    R(grp,-3,-9,6,18,'crop-handle-bar');
    L(grp,-6,-9,6,-9,'crop-handle-tick');
    L(grp,-6,9,6,9,'crop-handle-tick');
  }
  // Invisible, larger hit area — the visible bracket is thin, the click
  // target shouldn't be.
  R(grp,-10,-10,20,20,'crop-handle-hit');
  g.appendChild(grp);
  grp.addEventListener('mousedown',function(e){ startResizeDrag(e,target); });
  return grp;
}

function renderComps(){
  lyrC.innerHTML='';
  for(const comp of S.components){
    if(comp.type==='blanket') continue; // rendered separately, always in the background
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
    var isSelected=S.selected.some(function(s){return s.type==='comp'&&s.id===comp.id;});
    if(TOPLEFT_BOX_TYPES.includes(comp.type)){
      var bw=parseFloat(comp.w)||(comp.type==='image'?200:220),bh=parseFloat(comp.h)||(comp.type==='image'?150:160);
      R(g,0,0,bw,bh,'hit-rect');
      if(isSelected&&comp.type==='image'){
        addResizeHandle(g,bw,bh,'nwse-resize',{type:'resize',id:comp.id});
        addCropHandle(g,bw/2,0,'h','ns-resize',{type:'crop',id:comp.id,edge:'top'});
        addCropHandle(g,bw/2,bh,'h','ns-resize',{type:'crop',id:comp.id,edge:'bottom'});
        addCropHandle(g,0,bh/2,'v','ew-resize',{type:'crop',id:comp.id,edge:'left'});
        addCropHandle(g,bw,bh/2,'v','ew-resize',{type:'crop',id:comp.id,edge:'right'});
      } else if(isSelected&&comp.type==='note'){
        addResizeHandle(g,bw,bh,'nwse-resize',{type:'resize',id:comp.id});
      }
    } else if(comp.type==='textlabel'){
      var txtEl=g.querySelector('.text-label');
      var bb={x:0,y:-16,width:(comp.label||'').length*9,height:20};
      try{ if(txtEl&&typeof txtEl.getBBox==='function') bb=txtEl.getBBox(); }catch(e){}
      comp._mx=bb.x;comp._my=bb.y;comp._mw=bb.width;comp._mh=bb.height;
      R(g,bb.x,bb.y,bb.width||1,bb.height||1,'hit-rect');
    } else {
      var isVert=(rot===90||rot===270);
      var hrW=isVert?def.hitH:def.hitW,hrH=isVert?def.hitW:def.hitH;
      R(g,-hrW/2,-hrH/2,hrW,hrH,'hit-rect');
    }
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
          toggleProbeAt(absX,absY);
        } else if(S.wire.drawing){handleWireClick({x:absX,y:absY});}
        else{startWireFromPin(absX,absY,{type:'pin',compId:comp.id,pinIdx:i});}
      };})(comp,tp.x,tp.y,i));
    }
    if(isSelected)g.classList.add('selected');
    g.addEventListener('mousedown',(function(id){return function(e){onCompDown(e,id);};})(comp.id));
    lyrC.appendChild(g);
  }
}

// Blanket is a pure background annotation: always rendered into #lyr-blankets
// (structurally before every other layer, so it's always behind everything
// regardless of S.components order), and only its title text is
// clickable/draggable — the frame itself has pointer-events:none (see CSS)
// so clicks pass through to whatever is drawn on top of it.
function renderBlankets(){
  lyrBlk.innerHTML='';
  for(const comp of S.components){
    if(comp.type!=='blanket') continue;
    const def=CD.blanket;
    const g=el('g',{transform:`translate(${comp.x},${comp.y})`,class:'component-group',
      'data-id':comp.id,'data-type':'blanket'});
    def.draw(g,comp);
    var isSelected=S.selected.some(function(s){return s.type==='comp'&&s.id===comp.id;});
    if(isSelected)g.classList.add('selected');
    var title=g.querySelector('.blanket-title');
    if(title){
      title.addEventListener('mousedown',(function(id){return function(e){onBlanketTitleDown(e,id);};})(comp.id));
    }
    if(isSelected){
      var bw=parseFloat(comp.w)||400,bh=parseFloat(comp.h)||300;
      addResizeHandle(g,bw,bh,'nwse-resize',{type:'resize',id:comp.id});
    }
    lyrBlk.appendChild(g);
  }
}

function onBlanketTitleDown(e,id){
  if(e.button!==0)return; e.stopPropagation();
  if(S.mode!=='select')return;
  if(!S.selected.some(function(s){return s.type==='comp'&&s.id===id;})){
    clearSel();S.selected=[{type:'comp',id:id}];renderAll();renderProps();
  }
  startDrag(e,{type:'comp',id:id});
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
      // Prefer the longest horizontal element; only fall back to a vertical
      // one (rotated text) when the wire has no horizontal element at all.
      var bestH=-1,bestHLen=0,bestV=-1,bestVLen=0;
      for(var si=0;si<w.points.length-1;si++){
        var sa=w.points[si],sb=w.points[si+1];
        var hl=Math.abs(sb.x-sa.x),vl=Math.abs(sb.y-sa.y);
        if(sa.y===sb.y&&hl>bestHLen){bestHLen=hl;bestH=si;}
        else if(sa.x===sb.x&&vl>bestVLen){bestVLen=vl;bestV=si;}
      }
      var mi=bestH>=0?bestH:(bestV>=0?bestV:Math.floor((w.points.length-1)/2));
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
// Property keys that never take a numeric value, hence get no parameter button.
var PARAM_BTN_SKIP_KEYS=['label','text','model','part'];
function renderProps(){
  // The simulation settings share the properties panel. They stay in front only
  // while nothing is selected — selecting a component hands the panel back to
  // the properties (the plot pane itself stays open). The settings can be
  // reopened from the plot header or the SIMULATE button.
  if(typeof simPanelOpen!=='undefined' && simPanelOpen){
    if(S.selected.length){
      if(typeof setSimPanel==='function'){setSimPanel(false);return;}
    }else{
      var ss=document.getElementById('sim-settings'); if(ss)ss.style.display='block';
      document.getElementById('props-content').style.display='none';
      var ccs=document.getElementById('custom-comp-section'); if(ccs)ccs.style.display='none';
      return;
    }
  }
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
  let html='<div class="props-badge">'+comp.type.toUpperCase()+'</div>';
  var inlineCustomDef=customComponents[comp.type];
  if(inlineCustomDef){
    html+='<button class="tb-btn" style="margin:6px 12px;width:calc(100% - 24px)" onclick="editCustomComp(\''+comp.type+'\',\'inline\')">&#9881; Configure Component</button>';
    if(inlineCustomDef._libraryKey && libraryComponents[inlineCustomDef._libraryKey]){
      html+='<button class="tb-btn" style="margin:0 12px 6px;width:calc(100% - 24px)" onclick="updateComponentFromLibrary(\''+comp.type+'\')" title="Pull the current library version of this component into this schematic">&#8635; Update from Library</button>';
    }
  }
  html+='<div class="props-sect">General</div>';
  const curMode = comp.mode || 'DC';
  for(const[key,pd0]of Object.entries(def.props||{})){
    if(pd0 && pd0.modes && !pd0.modes.includes(curMode)) continue;
    if(pd0 && pd0.meas && !pd0.meas.includes(comp.meas||'V')) continue;
    // Sources: "(V)" in a label becomes "(A)" for a current source.
    const pd=(comp.type==='source'&&comp.meas==='I'&&pd0.l)?Object.assign({},pd0,{l:pd0.l.replace(/\(V\)/g,'(A)').replace(/^Voltage/,'Current').replace(/^V(initial|on)\b/,'I$1')}):pd0;
    const val=comp[key]||'';
    if(pd.type==='enum'&&Array.isArray(pd.options)){
      html+='<div class="prop-row"><div class="prop-lbl">'+pd.l+'</div><div style="padding:6px 12px;display:flex;gap:8px;align-items:center">';
      for(const opt of pd.options){
        const id='prop-'+key+'-'+opt.v;
        const chk=(String(val)===String(opt.v))?' checked':'';
        html+='<label style="display:flex;align-items:center;gap:6px"><input type="radio" name="prop-'+key+'" data-key="'+key+'" value="'+opt.v+'"'+chk+'> '+opt.l+'</label>';
      }
      html+='</div></div>';
    } else if(pd.type==='bool'){
      const chk=comp[key]?' checked':'';
      html+='<div class="prop-row" style="flex-direction:row;align-items:center;gap:8px;padding:8px 12px">'+
      '<input type="checkbox" data-key="'+key+'" id="prop-bool-'+key+'"'+chk+'>'+
      '<label for="prop-bool-'+key+'" class="prop-lbl" style="margin:0">'+pd.l+'</label></div>';
    } else if(pd.type==='textarea'){
      html+='<div class="prop-row"><div class="prop-lbl">'+pd.l+'</div>'+
      '<textarea class="prop-input" data-key="'+key+'" rows="6">'+esc(String(val))+'</textarea></div>';
    } else {
      const ph=pd.def!=null?' placeholder="'+esc(String(pd.def))+'"':'';
      var inpHtml='<input class="prop-input" data-key="'+key+'" type="text" value="'+esc(String(val))+'"'+ph+'/>';
      // Value-like fields get a ƒ button that inserts a {parameter} (js/params.js);
      // names, labels and model references are not numeric values.
      if(PARAM_BTN_SKIP_KEYS.indexOf(key)<0){
        inpHtml='<div class="prop-input-wrap">'+inpHtml+'<button type="button" class="prop-param-btn" data-pbtn="'+key+'" title="Insert a parameter ({name})">ƒ</button></div>';
      }
      html+='<div class="prop-row"><div class="prop-lbl">'+pd.l+'</div>'+inpHtml+'</div>';
    }
  }
  // properties apply immediately on change — no Apply button
  if(def.pins.length){
    html+='<div class="props-sect">Pins</div>';
    for(var pidx=0;pidx<def.pins.length;pidx++){
      var pin=def.pins[pidx];
      var tpp=xfPin(pin.x,pin.y,comp.rot||0,comp.mirror||false);
      const ax=comp.x+tpp.x,ay=comp.y+tpp.y;
      const cnt=S.wires.filter(function(w){const f=w.points[0],l=w.points[w.points.length-1];return(f.x===ax&&f.y===ay)||(l.x===ax&&l.y===ay);}).length;
      html+='<div class="pin-row"><span class="pin-name">'+pin.n+'</span><span class="pin-net">'+(cnt?cnt+' wire(s)':'unconnected')+'</span></div>';
    }
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
  // ƒ buttons: pick a parameter for the neighbouring value field
  pc.querySelectorAll('.prop-param-btn').forEach(function(btn){
    var inp=pc.querySelector('.prop-input[data-key="'+btn.getAttribute('data-pbtn')+'"]');
    // mousedown must not take the focus (and the caret) away from the field
    btn.addEventListener('mousedown',function(e){e.preventDefault();});
    btn.addEventListener('click',function(){if(inp&&typeof openParamMenu==='function')openParamMenu(btn,inp);});
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
        if(key==='mode'||(key==='meas'&&comp.type==='source'))renderProps();
      }
    });
  });
  // boolean checkboxes
  pc.querySelectorAll('input[type=checkbox][data-key]').forEach(function(cb){
    var key=cb.getAttribute('data-key');
    cb.addEventListener('change',function(){
      comp[key]=cb.checked;
      renderAll();
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

function selectComp(type,ev){
  placeRot=0;placeMirror=false;
  mergeCustomComponents();
  S.placeType=type;setMode('place');
  document.querySelectorAll('.comp-btn').forEach(function(b){b.classList.remove('selected');});
  if(ev && ev.currentTarget)ev.currentTarget.classList.add('selected');
  showGhost(type);
}

// ═══ DRAG & DROP PLACEMENT ═══
// Sidebar buttons carry data-comp and draggable=true; dropping one on the
// canvas places it at the drop position (an alternative to click-to-arm +
// click-to-place, which keeps working).
var dndType=null;
var lastMousePt=null; // last known SVG-space mouse position, used to place OS-clipboard image pastes near the cursor
(function initCompDnD(){
  function attach(){
    var sidebar=document.getElementById('sidebar');
    var pane=document.getElementById('schematic-pane');
    if(!sidebar||!pane)return;
    // Delegated so dynamically added custom-component buttons work too.
    sidebar.addEventListener('dragstart',function(e){
      var btn=e.target&&e.target.closest?e.target.closest('.comp-btn[data-comp]'):null;
      if(!btn)return;
      var type=btn.getAttribute('data-comp');
      mergeCustomComponents();
      if(!CD[type]){e.preventDefault();return;}
      dndType=type;
      if(e.dataTransfer){
        e.dataTransfer.effectAllowed='copy';
        try{e.dataTransfer.setData('text/plain',type);}catch(err){}
      }
    });
    sidebar.addEventListener('dragend',function(){
      dndType=null;
      if(S.mode!=='place')clearGhost();
    });
    pane.addEventListener('dragover',function(e){
      if(dndType){
        e.preventDefault();
        if(e.dataTransfer)e.dataTransfer.dropEffect='copy';
        var pt=svgPt(e),sp=snp(pt.x,pt.y);
        showGhost(dndType);
        moveGhost(sp.x,sp.y);
        return;
      }
      // OS file drag (e.g. an image from the desktop/Explorer): allow the drop.
      if(e.dataTransfer&&e.dataTransfer.types&&Array.from(e.dataTransfer.types).includes('Files')){
        e.preventDefault();
        if(e.dataTransfer)e.dataTransfer.dropEffect='copy';
      }
    });
    pane.addEventListener('dragleave',function(e){
      if(dndType&&!pane.contains(e.relatedTarget))clearGhost();
    });
    pane.addEventListener('drop',function(e){
      if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length){
        var f=e.dataTransfer.files[0];
        if(f&&f.type&&f.type.indexOf('image/')===0){
          e.preventDefault();
          dndType=null; clearGhost();
          placeImageFromFile(f,svgPt(e));
          return;
        }
      }
      var type=dndType||(e.dataTransfer?e.dataTransfer.getData('text/plain'):'');
      if(!type)return;
      e.preventDefault();
      dndType=null;
      mergeCustomComponents();
      if(!CD[type]){clearGhost();return;}
      if(S.mode!=='place')clearGhost();
      var pt=svgPt(e),sp=snp(pt.x,pt.y);
      placeComp(type,sp);
      hint('Placed '+(CD[type]._name||type)+' at '+sp.x+', '+sp.y);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach);else attach();
})();

// ═══ IMAGE INSERTION (File menu, drag&drop of files, Ctrl+V of OS clipboard) ═══
// All three entry points funnel through placeImageFromFile()/placeImageComp(),
// mirroring placeComp()'s generic "push, render, pushState, save" pattern.
function viewCenterPoint(){
  var r=svg.getBoundingClientRect();
  var w=r.width/view.zoom,h=r.height/view.zoom;
  return snp(view.x+w/2,view.y+h/2);
}
function insertImageViaFilePicker(){
  var inp=document.createElement('input');
  inp.type='file';inp.accept='image/*';
  inp.addEventListener('change',function(){
    var file=inp.files[0];if(!file)return;
    placeImageFromFile(file,viewCenterPoint());
  });
  inp.click();
}
function placeImageFromFile(file,dropPoint){
  if(!file||!file.type||file.type.indexOf('image/')!==0)return;
  var reader=new FileReader();
  reader.onload=function(ev){
    var dataURL=ev.target.result;
    var img=new Image();
    img.onload=function(){ placeImageComp(dataURL,img.naturalWidth||200,img.naturalHeight||150,dropPoint); };
    img.onerror=function(){ placeImageComp(dataURL,200,150,dropPoint); };
    img.src=dataURL;
  };
  reader.readAsDataURL(file);
}
function placeImageComp(dataURL,natW,natH,dropPoint){
  var maxDim=600;
  var scale=Math.min(1,maxDim/Math.max(natW,natH));
  var w=Math.max(GRID,Math.round(natW*scale/GRID)*GRID);
  var h=Math.max(GRID,Math.round(natH*scale/GRID)*GRID);
  var sp=snp(dropPoint.x-w/2,dropPoint.y-h/2);
  var comp={id:newId(),type:'image',x:sp.x,y:sp.y,w:w,h:h,src:dataURL,
    natW:natW,natH:natH,crop:{x:0,y:0,w:natW,h:natH},label:'Image'};
  S.components.push(comp);
  clearSel();S.selected=[{type:'comp',id:comp.id}];
  renderAll();renderProps();
  pushState();saveSchematic();
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

// Hovering a device pin in probe mode measures the CURRENT INTO that terminal,
// so the marker is a distinct current symbol (ring + arrow pointing into the
// device + "I" tag) instead of the plain voltage ring used on nets.
function showProbeHighlight(x,y,isPin,pinRef){
  clearProbeHighlight();
  var cv=null;
  if(pinRef){
    var comp=S.components.find(function(c){return c.id===pinRef.compId;});
    if(comp&&typeof currentVectorsForPin==='function')cv=currentVectorsForPin(comp,pinRef.pinIdx);
    if(cv)cv._comp=comp;
  }
  if(cv){
    probeHighlightEl=drawCurrentProbeMarker(x,y,cv._comp,cv);
    return;
  }
  probeHighlightEl=CE(lyrO,x,y,isPin?9:12,'probe-highlight'+(isPin?' pin':''));
  probeHighlightEl.style.opacity='1';
}

// Arrow points from outside the symbol towards the component body: that is the
// direction of a positive terminal current.
function drawCurrentProbeMarker(x,y,comp,cv){
  var g=el('g',{class:'probe-current-marker'});
  var dx=comp?(comp.x-x):0, dy=comp?(comp.y-y):-1;
  var len=Math.hypot(dx,dy)||1;
  var ux=dx/len, uy=dy/len;
  if(!comp||(dx===0&&dy===0)){ux=0;uy=-1;}
  var tailX=x-ux*26, tailY=y-uy*26;   // start outside the pin
  var headX=x+ux*6,  headY=y+uy*6;    // end just inside the body
  var line=el('line',{x1:tailX,y1:tailY,x2:headX,y2:headY,class:'probe-current-arrow'});
  g.appendChild(line);
  var px=-uy, py=ux;
  var back=8, wide=4;
  g.appendChild(el('polygon',{
    points:headX+','+headY+' '+
           (headX-ux*back+px*wide)+','+(headY-uy*back+py*wide)+' '+
           (headX-ux*back-px*wide)+','+(headY-uy*back-py*wide),
    class:'probe-current-head'}));
  var ring=el('circle',{cx:x,cy:y,r:9,class:'probe-highlight current'});
  g.appendChild(ring);
  var tag=el('text',{x:x+px*16,y:y+py*16+4,class:'probe-current-tag'});
  tag.textContent=cv?('I '+cv.dev.toUpperCase()+'.'+cv.pin):'I';
  tag.setAttribute('text-anchor','middle');
  g.appendChild(tag);
  lyrO.appendChild(g);
  return g;
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

// Begin a probe drag gesture at point pt. Returns true if a probe target
// (a pin or a named/derivable net) was found and the drag was started.
// Shared by startProbeDrag, onWireDown and onJuncDown.
function beginProbeDrag(pt){
  clearProbeStartHighlight();
  clearProbeHighlight();
  var near=findPin(pt.x,pt.y,18);
  var isPin=(near&&near.type==='pin');
  var netName=getNetNameAt(pt.x,pt.y);
  if(!(isPin||!!netName))return false;
  probeState.active=true;
  probeState.startX=pt.x;
  probeState.startY=pt.y;
  probeState.startNetName=netName;
  probeState.startIsPin=isPin;
  probeState.dragging=true;
  showProbeStartHighlight(pt.x,pt.y,isPin);
  probeDragLineEl=el('line',{x1:pt.x,y1:pt.y,x2:pt.x,y2:pt.y,class:'probe-drag-line'});
  lyrO.appendChild(probeDragLineEl);
  return true;
}

function startProbeDrag(e,pt){
  beginProbeDrag(pt);
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

  // A click (no meaningful drag) selects/deselects the net for plotting.
  if(Math.abs(pt.x-probeState.startX)<6 && Math.abs(pt.y-probeState.startY)<6){
    toggleProbeAt(probeState.startX,probeState.startY);
    probeState.active=false;probeState.dragging=false;
    return;
  }

  // A real drag from net A to net B adds a differential probe V(B)-V(A).
  addDiffProbe(probeState.startX,probeState.startY,pt.x,pt.y);

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
  lastMousePt=pt;
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
        showProbeHighlight(nearPin.x,nearPin.y,true,{compId:nearPin.compId,pinIdx:nearPin.pinIdx});
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
      showProbeHighlight(nearPin.x,nearPin.y,true,{compId:nearPin.compId,pinIdx:nearPin.pinIdx});
      var pc=S.components.find(function(c){return c.id===nearPin.compId;});
      var pcv=(pc&&typeof currentVectorsForPin==='function')?currentVectorsForPin(pc,nearPin.pinIdx):null;
      hint(pcv?('Click to plot the current into '+pcv.dev.toUpperCase()+'.'+pcv.pin
                  +' — drag for a differential voltage')
              :'No terminal current available for this pin — click plots the node voltage');
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
    beginProbeDrag(svgPt(e));
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
    beginProbeDrag(svgPt(e));
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
// Next free reference number for a given SPICE prefix (e.g. 'R', 'Q', 'D').
// Uses the highest existing suffix + 1 across all components sharing the
// prefix, so deleting and re-placing never produces duplicate references
// (which SPICE rejects). Diode/LED share 'D', NPN/PNP share 'Q', etc.
function nextRefNum(prefix){
  var max=0;
  for(var i=0;i<S.components.length;i++){
    var c=S.components[i];
    var cdef=CD[c.type];
    if(!cdef||cdef.lbl!==prefix)continue;
    var lab=c.label||'';
    if(lab.indexOf(prefix)!==0)continue;
    var n=parseInt(lab.slice(prefix.length),10);
    if(!isNaN(n)&&n>max)max=n;
  }
  return max+1;
}
function placeComp(type,sp){
  // First real use of a library-only part in this schematic: copy it into
  // the inline registry (customComponents) so the schematic stays
  // self-contained/portable, and remember where it came from (_libraryKey)
  // so "Update from Library" can find its way back later.
  if(libraryComponents[type] && !customComponents[type]){
    var built=createCustomCompDef(type,extractCustomCompConfig(libraryComponents[type]));
    built.def._libraryKey=type;
    customComponents[type]=built.def;
    mergeCustomComponents();
  }
  var def=CD[type];
  var lbl=type==='netconn'?'NET':def.lbl+nextRefNum(def.lbl);
  // Annotations never rotate/mirror (see rotateSelected/mirrorSelected) — ignore
  // any leftover placeRot/placeMirror from a previous rotated placement.
  var isAnno=UI_ANNOTATION_TYPES.includes(type);
  var comp={id:newId(),type:type,x:sp.x,y:sp.y,label:lbl,value:def.val,rot:isAnno?0:placeRot,mirror:isAnno?false:placeMirror,props:{}};
  // initialize enum and plain property defaults
  for(const[key,pd]of Object.entries(def.props||{})){
    if(pd.type==='enum'&&Array.isArray(pd.options)&&!comp[key]){comp[key]=pd.options[0].v;}
    else if(pd.def!==undefined&&!comp[key]){comp[key]=pd.def;}
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
    comp.ac_ncycles = comp.ac_ncycles || '0';
    // Pulse defaults
    comp.pulse_vinit = comp.pulse_vinit || '0';
    comp.pulse_von = comp.pulse_von || '5';
    comp.pulse_tdelay = comp.pulse_tdelay || '0';
    comp.pulse_trise = comp.pulse_trise || '1e-6';
    comp.pulse_tfall = comp.pulse_tfall || '1e-6';
    comp.pulse_ton = comp.pulse_ton || '0.001';
    comp.pulse_tperiod = comp.pulse_tperiod || '0.002';
    comp.pulse_ncycles = comp.pulse_ncycles || '0';
    // Ramp defaults
    comp.ramp_start = comp.ramp_start || '0';
    comp.ramp_end = comp.ramp_end || '5';
    comp.ramp_tdelay = comp.ramp_tdelay || '0';
    comp.ramp_duration = comp.ramp_duration || '0.01';
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
    // Unselected wires running purely between moved parts (both ends on moved
    // pins/junctions) must travel with the group too; otherwise both ends get
    // re-routed independently and the wire is distorted.
    for(const w of S.wires){
      if(selIdsWire.has(w.id)||!w.from||!w.to)continue;
      const endMoved=function(c){return c&&((c.type==='pin'&&selIdsComp.has(c.compId))||(c.type==='junction'&&selIdsJunc.has(c.id)));};
      if(endMoved(w.from)&&endMoved(w.to))groupInitial.push({type:'wire',id:w.id,points:w.points.map(p=>({x:p.x,y:p.y}))});
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
  if(S.drag.target.type==='resize'){onResizeMove(e);return;}
  if(S.drag.target.type==='crop'){onCropMove(e);return;}
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
      }
    }
    // Wires are translated in a second pass, after moveComp/moveJunc (which
    // re-route attached wire ends). A wire moves as a whole unless one end is
    // attached to something that stays put (unmoved pin/junction); that end
    // must stay anchored, so those wires keep the end-only re-routing.
    const fixedEnd=function(c){return c&&((c.type==='pin'&&!movedCompIds.has(c.compId))||(c.type==='junction'&&!movedJuncIds.has(c.id)));};
    for(const it of S.drag.groupInitial){
      if(it.type!=='wire')continue;
      const w=S.wires.find(ww=>ww.id===it.id); if(!w) continue;
      if(fixedEnd(w.from)||fixedEnd(w.to)) continue;
      w.points = it.points.map(p=>({x:p.x+dx,y:p.y+dy}));
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

// ═══ RESIZE / CROP DRAG (blanket + image) ═══
// Shares the S.drag state machine used by comp/junction/wire-seg drags —
// dispatched from onDragMove via target.type==='resize'|'crop', finalized
// generically by onDragEnd (no net cleanup needed: these types have pins:[]).
function startResizeDrag(e,target){
  e.stopPropagation(); e.preventDefault();
  var c=S.components.find(function(cc){return cc.id===target.id;}); if(!c)return;
  var defW=c.type==='image'?200:(c.type==='note'?220:400), defH=c.type==='image'?150:(c.type==='note'?160:300);
  S.drag={active:true,target:target,sm:svgPt(e),
    w0:parseFloat(c.w)||defW, h0:parseFloat(c.h)||defH, x0:c.x, y0:c.y,
    crop0: c.crop?{x:c.crop.x,y:c.crop.y,w:c.crop.w,h:c.crop.h}:null,
    moved:false};
}

function onResizeMove(e){
  var pt=svgPt(e);
  var c=S.components.find(function(cc){return cc.id===S.drag.target.id;}); if(!c)return;
  var dx=snap(pt.x-S.drag.sm.x), dy=snap(pt.y-S.drag.sm.y);
  var minSize=GRID*2;
  var nw,nh;
  if(c.type==='image' && S.drag.w0>0 && S.drag.h0>0){
    // Images keep their aspect ratio on a corner resize (crop separately if
    // you want a different shape) — drive the resize from whichever axis is
    // being dragged further, so a diagonal drag feels natural either way.
    var ratio=S.drag.w0/S.drag.h0;
    if(Math.abs(dx)>=Math.abs(dy)*ratio){ nw=S.drag.w0+dx; nh=nw/ratio; }
    else { nh=S.drag.h0+dy; nw=nh*ratio; }
    if(nw<minSize){ nw=minSize; nh=nw/ratio; }
    if(nh<minSize){ nh=minSize; nw=nh*ratio; }
  } else {
    nw=Math.max(minSize, S.drag.w0+dx);
    nh=Math.max(minSize, S.drag.h0+dy);
  }
  if(nw===c.w && nh===c.h) return;
  c.w=nw; c.h=nh;
  S.drag.moved=true;
  renderAll();
}

// Non-destructive crop: dragging an edge handle inward shrinks the visible
// box AND the same fraction of the crop rect on that side (in the image's
// natural pixel space); dragging back out grows the crop rect again, up to
// the original image bounds. The source image data is never modified.
function onCropMove(e){
  var pt=svgPt(e);
  var c=S.components.find(function(cc){return cc.id===S.drag.target.id;});
  if(!c||c.type!=='image'||!c.crop)return;
  var edge=S.drag.target.edge;
  var crop0=S.drag.crop0;
  var natW=c.natW||S.drag.w0, natH=c.natH||S.drag.h0;
  var minBox=GRID; // minimum on-screen box size along the cropped axis
  if(edge==='left'||edge==='right'){
    var scale=S.drag.w0>0?crop0.w/S.drag.w0:1;
    var dx=snap(pt.x-S.drag.sm.x);
    if(edge==='right'){
      var maxW=natW-crop0.x; // can't grow past the right edge of the source image
      var minW=Math.max(1,minBox*scale);
      var newCropW=Math.min(maxW, Math.max(minW, crop0.w+dx*scale));
      var boxDx=(newCropW-crop0.w)/scale;
      c.crop.w=newCropW; c.w=Math.max(minBox, S.drag.w0+boxDx);
    } else { // left
      var minW2=Math.max(1,minBox*scale);
      var newCropW2=Math.min(crop0.x+crop0.w, Math.max(minW2, crop0.w-dx*scale));
      var deltaCropW=newCropW2-crop0.w; // negative when shrinking from the left
      c.crop.x=crop0.x-deltaCropW;
      c.crop.w=newCropW2;
      // Box width must shrink/grow by the SAME sign as the crop (so the
      // display scale w/crop.w stays constant, i.e. no stretch) — not the
      // opposite sign, which previously made the box grow while cropping.
      var boxDx2=deltaCropW/scale;
      c.w=Math.max(minBox, S.drag.w0+boxDx2);
      c.x=S.drag.x0-boxDx2;
    }
  } else {
    var scaleY=S.drag.h0>0?crop0.h/S.drag.h0:1;
    var dy=snap(pt.y-S.drag.sm.y);
    if(edge==='bottom'){
      var maxH=natH-crop0.y;
      var minH=Math.max(1,minBox*scaleY);
      var newCropH=Math.min(maxH, Math.max(minH, crop0.h+dy*scaleY));
      var boxDy=(newCropH-crop0.h)/scaleY;
      c.crop.h=newCropH; c.h=Math.max(minBox, S.drag.h0+boxDy);
    } else { // top
      var minH2=Math.max(1,minBox*scaleY);
      var newCropH2=Math.min(crop0.y+crop0.h, Math.max(minH2, crop0.h-dy*scaleY));
      var deltaCropH=newCropH2-crop0.h;
      c.crop.y=crop0.y-deltaCropH;
      c.crop.h=newCropH2;
      // Same sign fix as 'left' above.
      var boxDy2=deltaCropH/scaleY;
      c.h=Math.max(minBox, S.drag.h0+boxDy2);
      c.y=S.drag.y0-boxDy2;
    }
  }
  S.drag.moved=true;
  renderAll();
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
      const selWireIds = S.drag.groupInitial.filter(s=>s.type==='wire').map(s=>s.id);
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
    // Resize/crop change comp.w/h/crop directly (not through a prop-input
    // that already keeps itself in sync) — refresh the panel so the Width/
    // Height fields don't show stale pre-drag values.
    if(S.drag.target.type==='resize'||S.drag.target.type==='crop')renderProps();
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
    if(selectedIds.comp[c.id]){
      // Shallow-copy the whole component (not just a fixed field whitelist) so
      // type-specific extras — blanket/note w/h/align, image src/crop/natW/H,
      // text-label style flags — survive copy/paste too. `crop` is deep-cloned
      // so pasting the same buffer twice never lets two images share (and
      // fight over) the same crop object.
      var cc=Object.assign({},c);
      if(cc.crop)cc.crop=Object.assign({},cc.crop);
      comps.push(cc);
    }
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

// Fresh reference designators for a batch of pasted components, exactly as if
// each one had been placed anew (nextRefNum), so copy/paste never produces
// duplicate SPICE refs. Net Connectors and text labels keep their label
// (it is their content); a Net Connector's name is re-derived from the net
// it lands on via applyNetConnName, if any.
function computePasteLabels(bufferComps){
  var counters={};
  var labels=[];
  for(var i=0;i<bufferComps.length;i++){
    var oc=bufferComps[i];
    // For these types `label` IS the content (net name / visible text), not a
    // reference designator, so it must survive the copy unchanged.
    if(oc.type==='netconn'||oc.type==='textlabel'){labels.push(oc.label);continue;}
    var def=CD[oc.type];
    var prefix=def?def.lbl:'';
    if(!(prefix in counters))counters[prefix]=nextRefNum(prefix);
    labels.push(prefix+counters[prefix]);
    counters[prefix]++;
  }
  return labels;
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
  S.pasteMode.newLabels=computePasteLabels(S.buffer.comps);
  for(var i=0;i<S.buffer.comps.length;i++){
    var oc=S.buffer.comps[i];
    var nc=Object.assign({},oc,{id:newId(),label:S.pasteMode.newLabels[i]});
    S.pasteMode.compMap[oc.id]=nc.id;
    var g=el('g',{class:'component-group ghost',transform:'translate('+nc.x+','+nc.y+')','data-id':nc.id});
    var inner=el('g',{class:''});
    var xf='';if(nc.rot)xf+='rotate('+nc.rot+')';if(nc.mirror)xf+=(xf?' ':'')+'scale(-1,1)';
    if(xf)inner.setAttribute('transform',xf);
    CD[nc.type].draw(inner,nc);
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
    var bc=S.buffer.comps[i];
    var sp=snp(bc.x+dx,bc.y+dy);
    var nc=Object.assign({},bc,{id:S.pasteMode.compMap[bc.id],x:sp.x,y:sp.y,label:S.pasteMode.newLabels[i]});
    if(bc.crop)nc.crop=Object.assign({},bc.crop); // don't let two pasted copies share one crop object
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
  // Net Connectors get their real name from whatever net they now touch —
  // same as a freshly placed one (placeComp -> applyNetConnName).
  for(var key in S.pasteMode.compMap){
    var pastedNc=S.components.find(function(c){return c.id===S.pasteMode.compMap[key];});
    if(pastedNc&&pastedNc.type==='netconn')applyNetConnName(pastedNc);
  }
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
// "New Schematic": the current schematic is NOT discarded — it stays in the
// internal library (see "SCHEMATIC FILES" below) and a fresh empty one becomes
// the current file.
function newSchematic(){
  saveSchematic(); // flush the file we are leaving
  var id=createInternalFile('Untitled',null);
  setCurrentFile(id);
  applyState({components:[],wires:[],junctions:[],nextId:1,customComponents:{},probes:[]},{applySim:true});
  view.x=0;view.y=0;view.zoom=1;
  cancelWire();applyView();renderAll();renderProps();
  clearHistory(); pushState();
  saveSchematic();
}

// ═══ STATE (shared by SVG export, autosave and the internal file store) ═══
// Full, self-contained description of the current schematic. The simulation
// setup is read from simulation.js globals when that script is loaded (it is
// not yet during the very first autosave at startup — hence the typeof guards).
function collectState(){
  var simDirEl=document.getElementById('sim-directives');
  return {version:SCHEMA_VERSION,components:S.components,wires:S.wires,junctions:S.junctions,nextId:S.nextId,
    // Inline custom-component definitions used by this schematic, so it
    // stays self-contained on import regardless of the importing browser's
    // local component library (see components.js: customComponents vs
    // libraryComponents). JSON.stringify silently drops each def's `draw`
    // function; mergeCustomComponents() rebuilds a generic one on import.
    customComponents:customComponents,
    probes:S.probes||[],
    // Parameters dialog: .param definitions and sweeps (schematic-level data).
    params:S.params||[],
    // Full simulation setup, including the analysis params of modes that
    // aren't currently selected, so switching modes never loses their config.
    sim:{
      analysis:(typeof simAnalysis!=='undefined')?simAnalysis:undefined,
      formulas:(typeof simFormulas!=='undefined')?simFormulas:undefined,
      directives:simDirEl?simDirEl.value:'',
      saveAll:(typeof getRawMode==='function')?getRawMode():undefined,
      // .measure statements; `result` is transient and never stored.
      measurements:(typeof simMeasurements!=='undefined')?simMeasurements.map(function(m){var c={};for(var k in m)if(k!=='result'&&k!=='results')c[k]=m[k];return c;}):undefined,
      probes:S.probes||[],
      powerAnalyzer:(typeof paConfig!=='undefined'&&paConfig)?paConfig:undefined
    }
  };
}

// Inverse of collectState(). View (pan/zoom) is never restored; callers
// zoom-to-fit afterwards. `opts.applySim` additionally restores the
// simulation setup (skipped at startup, where simulation.js isn't loaded yet,
// and for temporary swaps in withStateApplied()).
function applyState(state,opts){
  opts=opts||{};
  S.components=state.components||[];
  S.wires=state.wires||[];
  S.junctions=state.junctions||[];
  S.nextId=state.nextId||1;
  S.selected=[];
  S.params=Array.isArray(state.params)?state.params:[];
  S.probes=Array.isArray(state.probes)?state.probes:((state.sim&&Array.isArray(state.sim.probes))?state.sim.probes:[]);
  // Inline custom-component defs are this schematic's own — replace
  // wholesale (like S.components etc. above), independent of whatever
  // the local component library currently holds.
  customComponents=state.customComponents||{};
  mergeCustomComponents();
  renderCustomCompsList();
  if(opts.applySim&&typeof resetSimForSchematic==='function')resetSimForSchematic(!state.sim);
  if(opts.applySim&&state.sim){
    var sim=state.sim;
    if(sim.analysis&&typeof simAnalysis!=='undefined'){
      simAnalysis.type=sim.analysis.type||simAnalysis.type;
      if(sim.analysis.tran)for(var kt in sim.analysis.tran)simAnalysis.tran[kt]=sim.analysis.tran[kt];
      if(sim.analysis.dc)for(var kd in sim.analysis.dc)simAnalysis.dc[kd]=sim.analysis.dc[kd];
      if(sim.analysis.ac)for(var ka in sim.analysis.ac)simAnalysis.ac[ka]=sim.analysis.ac[ka];
    }
    if(Array.isArray(sim.formulas)&&typeof simFormulas!=='undefined')simFormulas=sim.formulas;
    if(typeof simMeasurements!=='undefined'){
      simMeasurements=Array.isArray(sim.measurements)?sim.measurements:[];
      simMeasurements.forEach(function(m){var n=parseInt(String(m.id||'').replace(/^m/,''),10);if(!isNaN(n)&&n>=MEASURE_NEXT_ID)MEASURE_NEXT_ID=n+1;});
    }
    var simDirEl2=document.getElementById('sim-directives');
    if(simDirEl2)simDirEl2.value=sim.directives||'';
    var saveAllEl=document.getElementById('sim-raw-mode');
    if(saveAllEl&&typeof sim.saveAll==='boolean')saveAllEl.checked=sim.saveAll;
    if(Array.isArray(sim.probes))S.probes=sim.probes;
    if(typeof paApplyStateConfig==='function')paApplyStateConfig(sim.powerAnalyzer);
    // A schematic that carries probes plots exactly those (probing takes over
    // from the automatic "all node voltages" set); without probes it stays auto.
    if(typeof simSelectionAuto!=='undefined')simSelectionAuto=!(S.probes&&S.probes.length);
    if(typeof simSelection!=='undefined')simSelection={};
    if(typeof saveSimSettings==='function')saveSimSettings();
    if(typeof renderAnalysisPanel==='function')renderAnalysisPanel();
    if(typeof renderFormulaList==='function')renderFormulaList();
    if(typeof renderProbeList==='function')renderProbeList();
    if(typeof renderMeasureList==='function')renderMeasureList();
  }
}

// ═══ EXPORT ═══
// `opts.sim` overrides the simulation block (used when exporting a stored
// file that is temporarily swapped in, see downloadInternalFile()).
function exportSVG(opts){
  opts=opts||{};
  var clone=svg.cloneNode(true);
  // remove interactive/overlay elements
  var overlay=clone.querySelector('#lyr-overlay');
  if(overlay)overlay.remove();
  clone.querySelectorAll('.wire-hit,.hit-rect,.junction-hit,.pin-ring,.ghost,.resize-handle,.crop-handle').forEach(function(e){e.remove();});
  // remove grid and defs so exported SVG is clean for printing
  var gb=clone.querySelector('#grid-bg'); if(gb) gb.remove();
  var defs=clone.querySelector('defs'); if(defs) defs.remove();
  // insert a white background rect for print
  var bgRect=document.createElementNS('http://www.w3.org/2000/svg','rect');
  bgRect.setAttribute('x','0');bgRect.setAttribute('y','0');bgRect.setAttribute('width','100%');bgRect.setAttribute('height','100%');bgRect.setAttribute('fill','#ffffff');
  clone.insertBefore(bgRect,clone.firstChild);
  // Insert print-oriented B/W styles with thicker strokes
  var st=document.createElementNS('http://www.w3.org/2000/svg','style');
  // NOTE: the exported SVG carries none of styles.css (only this inline
  // block) — any class without a rule here falls back to the SVG default
  // fill, which is solid black. blanket-frame/image-frame/note-body are
  // plain <rect>s with no inline fill/stroke (styling lives entirely in
  // styles.css for the live canvas), so they need explicit entries here too,
  // or they render as opaque black boxes in the export (hiding the embedded
  // image entirely, and turning the blanket into a black block instead of a
  // dashed outline).
  st.textContent='.wire-vis{stroke:#000;stroke-width:2.5;fill:none;stroke-linecap:square}.comp-body{stroke:#000;stroke-width:2;fill:#ffffff}.comp-pin{stroke:#000;stroke-width:2;fill:none}.comp-label{fill:#000;font-family:monospace;font-size:18px}.comp-value{fill:#000;font-family:monospace;font-size:16px}.pin-dot{fill:#000}.junction-vis{fill:#000;stroke:#000;stroke-width:1} text{fill:#000}.blanket-frame{fill:none;stroke:#000;stroke-width:1.5;stroke-dasharray:6 4}.blanket-title{fill:#000;font-family:monospace;font-size:16px}.image-frame{fill:none;stroke:#000;stroke-width:1}.note-body{fill:#ffffff;stroke:#000;stroke-width:1.5}.note-text{color:#000}';
  clone.insertBefore(st,bgRect.nextSibling);
  // Embed schematic state for round-trip import
  var desc=document.createElementNS('http://www.w3.org/2000/svg','desc');
  desc.setAttribute('id','schematic-data');
  var state=collectState();
  if('sim' in opts)state.sim=opts.sim;
  desc.textContent=JSON.stringify(state);
  clone.insertBefore(desc,st.nextSibling);
  // XMLSerializer, not outerHTML: the HTML-style serialization writes void
  // elements bare (a Note's blank line becomes `<br>` inside its foreignObject),
  // which makes the file ill-formed XML and breaks importSVG()'s DOMParser.
  downloadBlob(new Blob([new XMLSerializer().serializeToString(clone)],{type:'image/svg+xml'}),(opts.filename||currentFileName()||'schematic')+'.svg');
}
function downloadBlob(blob,filename){
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);},1000);
}

// ═══ IMPORT ═══
// Parses an exported SVG and returns its embedded state, or null (after an
// alert) if it isn't one of ours.
function parseSchematicSVG(text){
  var doc=new DOMParser().parseFromString(text,'image/svg+xml');
  var desc=doc.getElementById('schematic-data');
  if(!desc){
    alert('This SVG has no embedded schematic data.\nOnly SVGs exported from TurmericLab can be imported.');
    return null;
  }
  try{ return JSON.parse(desc.textContent); }
  catch(err){ alert('Failed to parse schematic data: '+err.message); return null; }
}

// Stores `state` as a NEW internal file and makes it the current schematic.
// The file we were working on stays in the internal library untouched.
function openStateAsNewFile(state,name,origin){
  saveSchematic(); // flush the file we are leaving
  var id=createInternalFile(name,state,origin);
  setCurrentFile(id);
  applyState(state,{applySim:true});
  // View is NOT restored from import — open with zoom-to-fit instead.
  cancelWire();renderAll();renderProps();
  zoomToFit();
  // reset history to the imported state
  clearHistory(); pushState();
  saveSchematic();
}

function importSVG(){
  var inp=document.createElement('input');
  inp.type='file';inp.accept='.svg,image/svg+xml';
  inp.addEventListener('change',function(){
    var file=inp.files[0];if(!file)return;
    var reader=new FileReader();
    reader.onload=function(ev){
      var state=parseSchematicSVG(ev.target.result);
      if(!state)return;
      openStateAsNewFile(state,file.name.replace(/\.svg$/i,''),null);
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
    if(UI_ANNOTATION_TYPES.includes(comp.type))continue; // annotations don't rotate/mirror
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
    if(UI_ANNOTATION_TYPES.includes(comp.type))continue; // annotations don't rotate/mirror
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
// Bump when the persisted schema changes; loadSchematic can then migrate.
var SCHEMA_VERSION=1;

// ═══ SCHEMATIC FILES (internal library, browser storage) ═══
// Several schematics live side by side in localStorage:
//   schematic_files        index: [{id,name,modified,origin?}]
//   schematic_file_<id>    full state of one file (collectState() format)
//   schematic_current_file id of the file the editor is working on
// Autosave only ever writes the current file's key, so it stays cheap.
// `origin` ({file,version}) records which global-library schematic a file was
// copied from, so the dialog can flag when the library has a newer version.
var FILES_INDEX_KEY='schematic_files';
var FILE_KEY_PREFIX='schematic_file_';
var CURRENT_FILE_KEY='schematic_current_file';
var fileIndex=[];
var currentFileId=null;

function loadFileIndex(){
  try{
    var raw=localStorage.getItem(FILES_INDEX_KEY);
    var arr=raw?JSON.parse(raw):[];
    fileIndex=Array.isArray(arr)?arr:[];
  }catch(e){console.warn('Failed to load file index',e);fileIndex=[];}
}
function saveFileIndex(){
  try{ localStorage.setItem(FILES_INDEX_KEY,JSON.stringify(fileIndex)); }
  catch(e){console.warn('Failed to save file index',e);}
}
function findFileEntry(id){
  for(var i=0;i<fileIndex.length;i++)if(fileIndex[i].id===id)return fileIndex[i];
  return null;
}
function currentFileName(){
  var f=currentFileId&&findFileEntry(currentFileId);
  return f?f.name:'';
}
function uniqueFileName(base,exceptId){
  base=(base||'').trim()||'Untitled';
  var name=base,n=2;
  function taken(nm){return fileIndex.some(function(f){return f.id!==exceptId&&f.name.toLowerCase()===nm.toLowerCase();});}
  while(taken(name))name=base+' ('+(n++)+')';
  return name;
}
function readFileState(id){
  try{ var raw=localStorage.getItem(FILE_KEY_PREFIX+id); return raw?JSON.parse(raw):null; }
  catch(e){console.warn('Failed to read file',id,e);return null;}
}
function writeFileState(id,state){
  try{ localStorage.setItem(FILE_KEY_PREFIX+id,JSON.stringify(state)); return true; }
  catch(e){
    console.warn('Failed to save schematic (browser storage full?)',e);
    if(!writeFileState.warned){writeFileState.warned=true;alert('Could not save the schematic to browser storage (storage full?).\nUse SAVE or the library\'s DOWNLOAD to keep a copy, and delete unused internal files.');}
    return false;
  }
}
// state=null creates an empty schematic. Returns the new file's id.
function createInternalFile(name,state,origin){
  var id='f'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  var entry={id:id,name:uniqueFileName(name),modified:Date.now()};
  if(origin)entry.origin=origin;
  fileIndex.push(entry);
  writeFileState(id,state||{version:SCHEMA_VERSION,components:[],wires:[],junctions:[],nextId:1,customComponents:{},probes:[]});
  saveFileIndex();
  return id;
}
function setCurrentFile(id){
  currentFileId=id;
  try{ localStorage.setItem(CURRENT_FILE_KEY,id); }catch(e){}
  updateFileUI();
}
function updateFileUI(){
  var el=document.getElementById('sb-file');
  if(el)el.textContent=currentFileName();
}

function saveSchematic(){
  try{
    // View (pan/zoom) is intentionally not saved — schematic always opens with zoom-to-fit.
    if(!currentFileId||!findFileEntry(currentFileId))setCurrentFile(createInternalFile('Untitled',null));
    if(writeFileState(currentFileId,collectState())){
      findFileEntry(currentFileId).modified=Date.now();
      saveFileIndex();
    }
  }catch(e){console.warn('Failed to save schematic',e);}
}

function loadSchematic(){
  try{
    loadFileIndex();
    // Migrate the pre-library single-file autosave into the first internal file.
    var legacy=localStorage.getItem('schematic_state');
    if(legacy&&!fileIndex.length){
      try{
        var id0=createInternalFile('Untitled',JSON.parse(legacy));
        localStorage.setItem(CURRENT_FILE_KEY,id0);
      }catch(e){console.warn('Failed to migrate legacy schematic',e);}
    }
    if(legacy)localStorage.removeItem('schematic_state');
    var cur=localStorage.getItem(CURRENT_FILE_KEY);
    if(!cur||!findFileEntry(cur)){
      var latest=fileIndex.slice().sort(function(a,b){return b.modified-a.modified;})[0];
      cur=latest?latest.id:createInternalFile('Untitled',null);
    }
    setCurrentFile(cur);
    var state=readFileState(cur);
    if(!state)return;
    // Tolerate older saves (no version field) and warn on newer ones.
    var ver=state.version||0;
    if(ver>SCHEMA_VERSION)console.warn('Schematic saved with newer schema v'+ver+' (app supports v'+SCHEMA_VERSION+')');
    // Simulation setup is not applied here (simulation.js isn't loaded yet and
    // keeps its own persisted settings); it is applied when switching files.
    applyState(state,{applySim:false});
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
    var cb=compBBox(S.components[i]);
    if(cb.left<minX)minX=cb.left;if(cb.top<minY)minY=cb.top;
    if(cb.right>maxX)maxX=cb.right;if(cb.bottom>maxY)maxY=cb.bottom;
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

// ═══ CLIPBOARD PASTE (Ctrl+V) — unified dispatch by content ═══
// Both the internal buffer-paste (copied components/wires/junctions) and the
// OS-clipboard image paste are driven from this single 'paste' event, not
// from the keydown handler: calling preventDefault() on the Ctrl+V *keydown*
// would suppress the browser's native 'paste' event entirely, which is
// exactly what broke OS image paste before. So keydown does nothing special
// for Ctrl+V (see below) and this handler branches on what the clipboard
// actually contains.
window.addEventListener('paste',function(e){
  if(document.activeElement&&(document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA'))return;
  var items=e.clipboardData&&e.clipboardData.items;
  if(items){
    for(var i=0;i<items.length;i++){
      if(items[i].type&&items[i].type.indexOf('image/')===0){
        var file=items[i].getAsFile();
        if(file){ e.preventDefault(); placeImageFromFile(file,lastMousePt||viewCenterPoint()); }
        return;
      }
    }
  }
  // No image on the clipboard — fall back to the internal copy/paste buffer.
  e.preventDefault();
  pasteFromBuffer();
});

// ═══ KEYBOARD ═══
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;
  if(libraryOpen())return; // library dialog is modal: no editor shortcuts behind it
  if(typeof paIsModal==='function'&&paIsModal())return; // same for the power analyzer
  // Undo / Redo shortcuts
  if((e.ctrlKey||e.metaKey) && (e.key==='z' || e.key==='Z')){
    e.preventDefault(); if(e.shiftKey) redo(); else undo(); return;
  }
  if((e.ctrlKey||e.metaKey) && (e.key==='y' || (e.shiftKey && e.key==='Z'))){ e.preventDefault(); redo(); return; }
  // Copy / Cut shortcuts. Paste (Ctrl+V) is intentionally NOT handled here —
  // see the 'paste' event listener above: preventDefault() on this keydown
  // would suppress the browser's native paste event, breaking OS-clipboard
  // image paste.
  if((e.ctrlKey||e.metaKey) && (e.key==='c' || e.key==='C')){
    e.preventDefault(); copyToBuffer(); return; }
  if((e.ctrlKey||e.metaKey) && (e.key==='x' || e.key==='X')){
    e.preventDefault(); cutSelected(); return; }
  if(e.key==='Escape'){if(S.pasteMode.active){cancelPaste();}else if(S.mode==='probe'){if(probeState.dragging){probeState.dragging=false;}clearAllProbeHighlights();probeState.active=false;setMode('select');}else{cancelWire();setMode('select');}}
  if(!(e.ctrlKey||e.metaKey) && (e.key==='v'||e.key==='V')){if(!S.pasteMode.active)setMode('select');}
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
  editingCustomCompScope=null;
  document.getElementById('custom-comp-section').style.display='block';
  document.getElementById('custom-comp-edit').style.display='none';
  document.getElementById('props-content').style.display='none';
  renderCustomCompsList(); // clear any leftover highlight from a previous edit
}

function hideCustomCompPanel(){
  // renderProps() resets custom-comp-section's display anyway and shows
  // whatever should actually be visible (selected component, empty state, or
  // the sim panel) — no need to duplicate that logic here.
  renderProps();
}

// scope ('inline'|'library') disambiguates which definition to open when the
// SAME key exists in both registries (e.g. a library part whose name happens
// to collide with an unrelated local one) — both show as separate rows in
// the management list (see renderCustomCompsList), each passing its own
// scope here. Omit scope to fall back to the old default-preference lookup
// (inline first) for call sites that only ever mean one specific def anyway.
function editCustomComp(key,scope){
  if(!scope)scope=customComponents[key]?'inline':'library';
  var comp=scope==='library'?libraryComponents[key]:customComponents[key];
  if(!comp)return;
  editingCustomCompKey=key;
  editingCustomCompScope=scope;
  document.getElementById('cc-name').value=comp._name||comp.lbl||'';
  document.getElementById('cc-prefix').value=comp.lbl||'U';
  document.getElementById('cc-desc').value=comp._desc||'';
  document.getElementById('cc-model').value=comp._model||'';
  var cfg=extractCustomCompConfig(comp);
  ccLeftPins=cfg.leftPins;
  ccRightPins=cfg.rightPins;
  normalizeCustomPinArray(ccLeftPins);
  normalizeCustomPinArray(ccRightPins);
  setCustomCompWarn('name',false);
  setCustomCompWarn('pins',false);
  renderCustomPinInputs('left');
  renderCustomPinInputs('right');
  document.getElementById('props-content').style.display='none';
  document.getElementById('custom-comp-section').style.display='block';
  document.getElementById('custom-comp-edit').style.display='block';
  // Re-render so the list's highlight (see appendCustomCompRow) picks up
  // editingCustomCompKey/Scope right away, not just after the first edit.
  renderCustomCompsList();
}

// ═══ CUSTOM COMPONENT FUNCTIONS ═══
var ccLeftPins=[];
var ccRightPins=[];
var editingCustomCompKey=null;
var editingCustomCompScope=null; // 'inline' | 'library' — which registry editingCustomCompKey refers to

// Keeps exactly one trailing empty pin row (the "always one more than what's
// filled" slot you can drag a pin into to open up a gap), while leaving any
// INTERIOR empty entries alone — those are deliberate gaps, not clutter.
function normalizeCustomPinArray(arr){
  while(arr.length>=2 && arr[arr.length-1]==='' && arr[arr.length-2]==='')arr.pop();
  if(!arr.length || arr[arr.length-1]!=='')arr.push('');
}

function renderCustomPinInputs(side){
  var container=document.getElementById('cc-'+side+'-pins');
  var pins=side==='left'?ccLeftPins:ccRightPins;
  var html='';
  for(var i=0;i<pins.length;i++){
    var empty=!pins[i].trim();
    html+='<div class="cc-pin-row'+(empty?' cc-pin-row-empty':'')+'" draggable="true" data-side="'+side+'" data-idx="'+i+'">'+
      '<span class="cc-pin-drag" title="Drag to reorder">&#8942;&#8942;</span>'+
      '<input type="text" placeholder="Pin name" value="'+esc(pins[i])+'" oninput="updateCustomPin(\''+side+'\','+i+',this.value)">'+
      '<button class="cc-pin-trash" title="Delete pin" onclick="removeCustomPinRow(\''+side+'\','+i+')">&#128465;</button>'+
      '</div>';
  }
  container.innerHTML=html;
  initCustomPinDnD();
}

function updateCustomPin(side,idx,val){
  var arr=side==='left'?ccLeftPins:ccRightPins;
  arr[idx]=val;
  var lenBefore=arr.length;
  normalizeCustomPinArray(arr);
  if(arr.length!==lenBefore){
    renderCustomPinInputs(side);
    var sel=document.querySelector('.cc-pin-row[data-side="'+side+'"][data-idx="'+idx+'"] input');
    if(sel){sel.focus();sel.setSelectionRange(sel.value.length,sel.value.length);}
  }
  commitCustomCompEdit();
}

function removeCustomPinRow(side,idx){
  var arr=side==='left'?ccLeftPins:ccRightPins;
  arr.splice(idx,1);
  normalizeCustomPinArray(arr);
  renderCustomPinInputs('left');
  renderCustomPinInputs('right');
  commitCustomCompEdit();
}

function moveCustomPin(fromSide,fromIdx,toSide,toIdx){
  var fromArr=fromSide==='left'?ccLeftPins:ccRightPins;
  var val=fromArr[fromIdx];
  if(val===undefined)return;
  fromArr.splice(fromIdx,1);
  var toArr=toSide==='left'?ccLeftPins:ccRightPins;
  if(fromArr===toArr && fromIdx<toIdx)toIdx--;
  toArr.splice(toIdx,0,val);
  normalizeCustomPinArray(ccLeftPins);
  normalizeCustomPinArray(ccRightPins);
  renderCustomPinInputs('left');
  renderCustomPinInputs('right');
  commitCustomCompEdit();
}

var ccDragSrc=null;
function initCustomPinDnD(){
  var root=document.getElementById('cc-pins-cols');
  if(!root||root._dndInit)return;
  root._dndInit=true;
  root.addEventListener('dragstart',function(e){
    var row=e.target.closest?e.target.closest('.cc-pin-row'):null;
    if(!row){e.preventDefault();return;}
    ccDragSrc={side:row.getAttribute('data-side'),idx:parseInt(row.getAttribute('data-idx'),10)};
    if(e.dataTransfer){e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain','pin');}catch(err){}}
    row.classList.add('cc-pin-dragging');
  });
  root.addEventListener('dragend',function(e){
    var row=e.target.closest?e.target.closest('.cc-pin-row'):null;
    if(row)row.classList.remove('cc-pin-dragging');
    ccDragSrc=null;
  });
  root.addEventListener('dragover',function(e){
    if(!ccDragSrc)return;
    var row=e.target.closest?e.target.closest('.cc-pin-row'):null;
    if(!row)return;
    e.preventDefault();
    if(e.dataTransfer)e.dataTransfer.dropEffect='move';
  });
  root.addEventListener('drop',function(e){
    if(!ccDragSrc)return;
    var row=e.target.closest?e.target.closest('.cc-pin-row'):null;
    if(!row)return;
    e.preventDefault();
    var toSide=row.getAttribute('data-side'),toIdx=parseInt(row.getAttribute('data-idx'),10);
    var src=ccDragSrc;ccDragSrc=null;
    moveCustomPin(src.side,src.idx,toSide,toIdx);
  });
}

function setCustomCompWarn(which,show){
  var el=document.getElementById('cc-'+which+'-warn');
  if(el)el.style.display=show?'block':'none';
}

function newCustomComp(){
  var name='Custom';
  var cnt=1;
  while(customComponents['custom_'+name.toLowerCase()+cnt]||libraryComponents['custom_'+name.toLowerCase()+cnt])cnt++;
  var fullKey='custom_'+name.toLowerCase()+cnt;
  var config={name:name+cnt,prefix:'U',leftPins:[''],rightPins:[''],description:'',model:''};
  var built=createCustomCompDef(fullKey,config);
  customComponents[fullKey]=built.def;
  mergeCustomComponents();
  renderCustomCompsList();
  saveSchematic();
  editCustomComp(fullKey);
}

// Live-apply handler for every field/pin edit in the custom component editor
// (no separate Apply button — see CLAUDE.md/DOKUMENTATION.md for the
// rationale). Always operates on editingCustomCompKey, which is set whenever
// the editor is open (via editCustomComp()).
function commitCustomCompEdit(){
  var existingKey=editingCustomCompKey;
  if(!existingKey)return;
  var name=document.getElementById('cc-name').value.trim()||'Custom';
  var prefix=document.getElementById('cc-prefix').value.trim()||'U';
  var desc=document.getElementById('cc-desc').value.trim();
  var model=document.getElementById('cc-model').value;
  var validLeft=ccLeftPins.filter(function(p){return p.trim();});
  var validRight=ccRightPins.filter(function(p){return p.trim();});
  setCustomCompWarn('pins',validLeft.length===0&&validRight.length===0);

  var newKey='custom_'+name.replace(/[^a-zA-Z0-9]/g,'_').toLowerCase();
  // Which registry we're editing is tracked explicitly via
  // editingCustomCompScope, NOT inferred from presence — the same key can
  // legitimately exist in both registries at once (e.g. a library part that
  // happens to collide in name with an unrelated inline one), and both then
  // show as separate rows in the management list, each pinned to its own
  // scope.
  var isLibraryOnly=editingCustomCompScope==='library';
  var srcDef=isLibraryOnly?libraryComponents[existingKey]:customComponents[existingKey];
  var renameBlocked=newKey!==existingKey&&(customComponents[newKey]||libraryComponents[newKey]);
  setCustomCompWarn('name',!!renameBlocked);
  var effectiveKey=renameBlocked?existingKey:newKey;

  var oldPins=srcDef?srcDef.pins.slice():null;

  if(!renameBlocked && existingKey!==effectiveKey){
    if(isLibraryOnly){
      delete libraryComponents[existingKey];
    } else {
      for(var i=0;i<S.components.length;i++){
        if(S.components[i].type===existingKey)S.components[i].type=effectiveKey;
      }
      delete customComponents[existingKey];
    }
    delete CD[existingKey];
    editingCustomCompKey=effectiveKey;
  }

  var config={name:name,prefix:prefix,leftPins:ccLeftPins,rightPins:ccRightPins,description:desc,model:model};
  var built=createCustomCompDef(effectiveKey,config);
  if(srcDef&&srcDef._libraryKey)built.def._libraryKey=srcDef._libraryKey;
  // Editing a library-only entry (opened straight from the list without ever
  // being placed) updates the library in place; otherwise it's an inline def.
  if(isLibraryOnly)libraryComponents[effectiveKey]=built.def;
  else customComponents[effectiveKey]=built.def;
  mergeCustomComponents();

  if(oldPins)relinkCustomCompPins(effectiveKey,oldPins);

  // NOTE: deliberately not calling renderProps() here — it unconditionally
  // hides #custom-comp-section (see its top), which would close this very
  // editor on every keystroke. renderAll() is enough to keep the canvas (and
  // any placed instances) in sync while editing.
  renderCustomCompsList();
  renderAll();
  if(isLibraryOnly)saveLibrary();else saveSchematic();
}

function cloneCustomComp(key,scope){
  if(!scope)scope=customComponents[key]?'inline':'library';
  var src=scope==='library'?libraryComponents[key]:customComponents[key];
  if(!src)return;
  var cfg=extractCustomCompConfig(src);
  cfg.name=cfg.name+' Copy';
  var baseKey='custom_'+cfg.name.replace(/[^a-zA-Z0-9]/g,'_').toLowerCase();
  var newKey=baseKey,n=2;
  while(customComponents[newKey]||libraryComponents[newKey]){newKey=baseKey+n;n++;}
  var built=createCustomCompDef(newKey,cfg);
  // Deliberately no _libraryKey: a clone is an independent derivative, never
  // linked back to (or able to affect) the component it was cloned from.
  customComponents[newKey]=built.def;
  mergeCustomComponents();
  renderCustomCompsList();
  saveSchematic();
  editCustomComp(newKey);
}

function saveCustomCompToLibrary(){
  // Only meaningful from an inline definition (publishing it to the shared
  // library). If the open editor is itself the library entry (scope
  // 'library'), there's nothing to "save to library" — and blindly reading
  // customComponents[key] here would risk grabbing an unrelated inline def
  // that happens to share the same key.
  if(editingCustomCompScope!=='inline')return;
  var key=editingCustomCompKey;
  var def=customComponents[key];
  if(!key||!def)return;
  var built=createCustomCompDef(key,extractCustomCompConfig(def));
  libraryComponents[key]=built.def;
  def._libraryKey=key;
  saveLibrary();
  mergeCustomComponents();
  renderCustomCompsList();
  saveSchematic();
}

function updateComponentFromLibrary(typeKey){
  var inlineDef=customComponents[typeKey];
  var libKey=inlineDef&&inlineDef._libraryKey;
  var libDef=libKey&&libraryComponents[libKey];
  if(!libDef)return;
  var oldPins=inlineDef.pins.slice();
  var built=createCustomCompDef(typeKey,extractCustomCompConfig(libDef));
  built.def._libraryKey=libKey;
  customComponents[typeKey]=built.def;
  mergeCustomComponents();
  relinkCustomCompPins(typeKey,oldPins);
  renderCustomCompsList();
  renderAll();
  renderProps();
  saveSchematic();
}

function loadCustomModelFile(){
  var inp=document.createElement('input');
  inp.type='file';inp.accept='.lib,.mod,.cir,.sub,.txt,.sp,.spi';
  inp.addEventListener('change',function(){
    var file=inp.files[0];if(!file)return;
    var reader=new FileReader();
    reader.onload=function(ev){
      var ta=document.getElementById('cc-model');
      ta.value=ev.target.result;
      syncCustomPinsFromModel();
      commitCustomCompEdit();
    };
    reader.readAsText(file);
  });
  inp.click();
}

// Re-derives the pin list from the pasted/loaded model's ".subckt NAME p1 p2
// ..." header (in header order, first half left, rest right). Only runs on
// blur/paste-settle (see the model textarea's onchange), not on every
// keystroke, so it doesn't fight manual pin renames mid-edit. No-op when the
// model text has no parseable subckt header.
function syncCustomPinsFromModel(){
  var text=document.getElementById('cc-model').value;
  var parsed=parseSubcktHeader(text);
  if(!parsed||!parsed.pins.length)return;
  var half=Math.ceil(parsed.pins.length/2);
  ccLeftPins=parsed.pins.slice(0,half);
  ccRightPins=parsed.pins.slice(half);
  if(!ccLeftPins.length)ccLeftPins=[''];
  if(!ccRightPins.length)ccRightPins=[''];
  normalizeCustomPinArray(ccLeftPins);
  normalizeCustomPinArray(ccRightPins);
  renderCustomPinInputs('left');
  renderCustomPinInputs('right');
  commitCustomCompEdit();
}

function renderCustomCompsList(){
  var container=document.getElementById('custom-comps-list');
  var sidebar=document.getElementById('sidebar-custom-comps');
  if(container)container.innerHTML='';
  if(sidebar)sidebar.innerHTML='';
  var keys=Object.keys(customComponents).concat(Object.keys(libraryComponents)).filter(function(k,i,a){return a.indexOf(k)===i;}).sort();
  // The management list shows ONE ROW PER (key, scope) PAIR — if the same
  // key exists in both registries (e.g. an inline component that happens to
  // share a name with an unrelated library part), both show up separately,
  // each labeled and independently editable/clonable/deletable via their own
  // scope, rather than one silently shadowing the other.
  for(var ki=0;ki<keys.length;ki++){
    var key=keys[ki];
    if(container){
      if(customComponents[key])appendCustomCompRow(container,key,'inline',customComponents[key]);
      if(libraryComponents[key])appendCustomCompRow(container,key,'library',libraryComponents[key]);
    }
    if(sidebar){
      var def=CD[key];
      if(!def)continue;
      var sbBtn=document.createElement('button');
      sbBtn.className='comp-btn';
      sbBtn.innerHTML='<svg class="comp-prev" viewBox="-10 -8 20 16"><rect x="-8" y="-6" width="16" height="12" stroke="#00c8ff" stroke-width="1.5" fill="none"/><line x1="-4" y1="-3" x2="4" y2="-3" stroke="#00c8ff" stroke-width="1"/><line x1="-4" y1="3" x2="4" y2="3" stroke="#00c8ff" stroke-width="1"/></svg>'+(def._name||def.lbl);
      sbBtn.onclick=function(k){return function(e){selectComp(k,e);};}(key);
      sbBtn.setAttribute('draggable','true');
      sbBtn.setAttribute('data-comp',key);
      sidebar.appendChild(sbBtn);
    }
  }
}

function appendCustomCompRow(container,key,scope,def){
  var row=document.createElement('div');
  row.className='cc-comp-row'+(key===editingCustomCompKey&&scope===editingCustomCompScope?' cc-comp-row-active':'');
  row.style.display='flex';
  row.style.alignItems='center';
  row.style.gap='8px';
  row.style.padding='6px 12px';
  row.style.borderBottom='1px solid var(--border)';
  var badge=document.createElement('span');
  badge.className='cc-scope-badge '+(scope==='inline'?'cc-scope-local':'cc-scope-lib');
  badge.textContent=scope==='inline'?'LOCAL':'LIB';
  badge.title=scope==='inline'?'Embedded in this schematic':'From the shared component library';
  var cloneBtn=document.createElement('button');
  cloneBtn.className='tb-btn';
  cloneBtn.style.cssText='width:16px;height:16px;min-width:16px;padding:0;flex:none;display:flex;align-items:center;justify-content:center;font-size:9px;';
  cloneBtn.title='Clone';
  cloneBtn.innerHTML='<span style="color:var(--text-mid)">&#10697;</span>';
  cloneBtn.onclick=function(k,s){return function(){cloneCustomComp(k,s);};}(key,scope);
  var delBtn=document.createElement('button');
  delBtn.className='tb-btn';
  delBtn.style.cssText='width:16px;height:16px;min-width:16px;padding:0;flex:none;display:flex;align-items:center;justify-content:center;font-size:9px;';
  delBtn.title='Delete';
  delBtn.innerHTML='<span style="color:var(--text-mid)">✕</span>';
  delBtn.onclick=function(k,s,el){return function(){confirmDeleteCustomComp(k,s,el);};}(key,scope,delBtn);
  var nameLbl=document.createElement('span');
  nameLbl.style.flex='1';
  nameLbl.style.fontSize='11px';
  nameLbl.style.color='var(--text-hi)';
  nameLbl.style.cursor='pointer';
  nameLbl.textContent=def._name||def.lbl;
  nameLbl.onclick=function(k,s){return function(){editCustomComp(k,s);};}(key,scope);
  var chk=document.createElement('input');
  chk.type='checkbox';
  chk.value=scope+':'+key;
  chk.id='cc-chk-'+scope+'-'+key;
  row.appendChild(badge);
  row.appendChild(nameLbl);
  row.appendChild(cloneBtn);
  row.appendChild(delBtn);
  row.appendChild(chk);
  container.appendChild(row);
}

var pendingDelete=null;
function confirmDeleteCustomComp(key,scope,btnEl){
  // pendingDelete is keyed by "scope:key" (not just key) — the same key can
  // have two independent rows (inline + library), each with its own
  // two-click confirm state, so they must not be confused with one another.
  var pendingId=scope+':'+key;
  if(pendingDelete===pendingId){
    var removedInline=scope==='inline';
    if(removedInline)delete customComponents[key];
    else delete libraryComponents[key];
    delete CD[key];
    mergeCustomComponents();
    pendingDelete=null;
    renderCustomCompsList();
    if(removedInline)saveSchematic();else saveLibrary();
  }else{
    pendingDelete=pendingId;
    btnEl.innerHTML='<span style="color:var(--wire-sel)">✔</span>';
    setTimeout(function(){if(pendingDelete===pendingId){pendingDelete=null;renderCustomCompsList();}},3000);
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
    // checkbox value is "scope:key" (see appendCustomCompRow) so a key that
    // exists in both registries exports the one the checked row actually
    // represents, not an ambiguous default.
    var parts=chks[i].value.split(':');
    var scope=parts[0],key=parts.slice(1).join(':');
    var def=scope==='library'?libraryComponents[key]:customComponents[key];
    if(def)data.push({key:key,definition:def});
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
  var inp=document.createElement('input');
  inp.type='file';inp.accept='.json';
  inp.addEventListener('change',function(){
    var file=inp.files[0];if(!file)return;
    var reader=new FileReader();
    reader.onload=function(e){
      try{
        var data=JSON.parse(e.target.result);
        var arr=Array.isArray(data)?data:[data];
        for(var i=0;i<arr.length;i++){
          var item=arr[i];
          if(item.key&&item.definition){
            customComponents[item.key]=item.definition;
          }
        }
        mergeCustomComponents();
        renderCustomCompsList();
        saveSchematic();
      }catch(err){
        alert('Failed to import: '+err.message);
      }
    };
    reader.readAsText(file);
  });
  inp.click();
}

function exportCustomComp(key){
  var def=customComponents[key]||libraryComponents[key];
  if(!def)return;
  var data={key:key,definition:def};
  var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=key+'.json';
  a.click();
}

// ═══ COMPONENT LIBRARY (persistent, schematic-independent) ═══
function saveLibrary(){
  try{ localStorage.setItem('schematic_library',JSON.stringify(libraryComponents)); }
  catch(e){console.warn('Failed to save component library',e);}
}
function loadLibrary(){
  try{
    var raw=localStorage.getItem('schematic_library');
    if(raw)libraryComponents=JSON.parse(raw);
  }catch(e){console.warn('Failed to load component library',e);}
}
// Seeds first-run/newly-added library parts from lib/default_components.json.
// Only fills in keys the local library doesn't already have, so the user's
// own library edits survive across reloads; skipped silently when there is
// no dev server to fetch from (see CLAUDE.md — never opened via file://).
function seedLibraryFromDefaults(){
  fetch('lib/default_components.json').then(function(r){return r.ok?r.json():null;})
    .then(function(arr){
      if(!Array.isArray(arr))return;
      var changed=false;
      for(var i=0;i<arr.length;i++){
        var item=arr[i];
        if(item&&item.key&&item.definition&&!libraryComponents[item.key]){
          libraryComponents[item.key]=item.definition;
          changed=true;
        }
      }
      if(changed){ saveLibrary(); mergeCustomComponents(); renderCustomCompsList(); renderAll(); }
    }).catch(function(){});
}

// ═══ SCHEMATIC LIBRARY DIALOG (internal files + global project library) ═══
// "Internal" = schematics in browser storage (see SCHEMATIC FILES above),
// "Global" = read-only templates shipped with the project in library/,
// described by library/library.toml. Opening a global template copies it into
// the internal library, so editing never touches the shipped file.
var LIBRARY_DIR='library/';
var LIBRARY_INDEX_FILE='library.toml';
var globalLibrary={status:'idle',name:'',version:'',entries:[],error:''};
var libRenamingId=null;

// Minimal TOML subset: comments, [table], [[array of tables]] and
// `key = value` with strings, numbers, booleans and JSON-style arrays.
function parseTOML(text){
  var root={},cur=root,lines=text.replace(/^﻿/,'').split(/\r?\n/);
  for(var i=0;i<lines.length;i++){
    var line=stripTomlComment(lines[i]).trim();
    if(!line)continue;
    var m=line.match(/^\[\[\s*([A-Za-z0-9_-]+)\s*\]\]$/);
    if(m){
      if(!Array.isArray(root[m[1]]))root[m[1]]=[];
      cur={};root[m[1]].push(cur);continue;
    }
    m=line.match(/^\[\s*([A-Za-z0-9_-]+)\s*\]$/);
    if(m){cur=root[m[1]]={};continue;}
    var eq=line.indexOf('=');
    if(eq<1)throw new Error('line '+(i+1)+': expected key = value');
    var key=line.slice(0,eq).trim().replace(/^"(.*)"$/,'$1');
    cur[key]=parseTomlValue(line.slice(eq+1).trim(),i+1);
  }
  return root;
}
function stripTomlComment(line){
  var q=null;
  for(var i=0;i<line.length;i++){
    var c=line[i];
    if(q){if(c==='\\'&&q==='"'){i++;continue;}if(c===q)q=null;}
    else if(c==='"'||c==="'")q=c;
    else if(c==='#')return line.slice(0,i);
  }
  return line;
}
function parseTomlValue(v,ln){
  try{
    if(v[0]==='"'||v[0]==='[')return JSON.parse(v);
    if(v[0]==="'"&&v.slice(-1)==="'")return v.slice(1,-1);
    if(v==='true')return true;
    if(v==='false')return false;
    if(/^[+-]?\d+(\.\d+)?$/.test(v))return Number(v);
  }catch(e){}
  throw new Error('line '+ln+': cannot parse value '+v);
}

function loadGlobalLibrary(){
  globalLibrary.status='loading';renderLibrary();
  return fetch(LIBRARY_DIR+LIBRARY_INDEX_FILE,{cache:'no-store'})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
    .then(function(txt){
      var t=parseTOML(txt),lib=t.library||{},list=Array.isArray(t.schematic)?t.schematic:[];
      globalLibrary.name=lib.name||'';
      globalLibrary.version=lib.version!=null?String(lib.version):'';
      globalLibrary.entries=list.filter(function(e){return e&&e.file;}).map(function(e){
        return {file:String(e.file),name:String(e.name||e.file).trim(),description:e.description?String(e.description):'',version:e.version!=null?String(e.version):''};
      });
      globalLibrary.status='ok';
    })
    .catch(function(e){
      globalLibrary.status='error';
      globalLibrary.error=e.message||String(e);
    })
    .then(renderLibrary);
}

function openGlobalSchematic(entry){
  fetch(LIBRARY_DIR+encodeURI(entry.file),{cache:'no-store'})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
    .then(function(txt){
      var state=parseSchematicSVG(txt);
      if(!state)return;
      openStateAsNewFile(state,entry.name,{file:entry.file,version:entry.version});
      closeLibrary();
    })
    .catch(function(e){alert('Could not load "'+entry.file+'": '+(e.message||e));});
}
function downloadGlobalSchematic(entry){
  fetch(LIBRARY_DIR+encodeURI(entry.file),{cache:'no-store'})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.blob();})
    .then(function(blob){downloadBlob(blob,entry.file.split('/').pop());})
    .catch(function(e){alert('Could not download "'+entry.file+'": '+(e.message||e));});
}

// Switches the editor to an already stored file (caller flushes the old one).
function switchToFile(id){
  var state=readFileState(id);
  if(!state){alert('This file is missing from browser storage.');return false;}
  setCurrentFile(id);
  applyState(state,{applySim:true});
  cancelWire();renderAll();renderProps();
  zoomToFit();
  clearHistory(); pushState();
  return true;
}
function openInternalFile(id){
  if(id!==currentFileId){saveSchematic();switchToFile(id);}
  closeLibrary();
}
function renameInternalFile(id,name){
  var f=findFileEntry(id);
  if(f&&name.trim()){f.name=uniqueFileName(name,id);saveFileIndex();updateFileUI();}
}
function deleteInternalFile(id){
  var f=findFileEntry(id);if(!f)return;
  if(!confirm('Delete "'+f.name+'" from browser storage?\nThis cannot be undone — use DOWNLOAD first if you want to keep it.'))return;
  try{localStorage.removeItem(FILE_KEY_PREFIX+id);}catch(e){}
  fileIndex=fileIndex.filter(function(x){return x.id!==id;});
  saveFileIndex();
  if(id===currentFileId){
    currentFileId=null; // the file is gone: don't let autosave resurrect it
    var next=fileIndex.slice().sort(function(a,b){return b.modified-a.modified;})[0];
    if(!next||!switchToFile(next.id))switchToFile(createInternalFile('Untitled',null));
  }
}
// A stored file that is not the current one can only be rendered by the live
// canvas, so it is swapped in for the export and the editor state restored.
function downloadInternalFile(id){
  var f=findFileEntry(id);if(!f)return;
  if(id===currentFileId){saveSchematic();exportSVG({filename:f.name});return;}
  var state=readFileState(id);
  if(!state){alert('This file is missing from browser storage.');return;}
  var snap=collectState(),keepUndo=undoStack,keepRedo=redoStack,keepSel=S.selected,
      keepView={x:view.x,y:view.y,zoom:view.zoom};
  try{
    applyState(state,{applySim:false});
    cancelWire();renderAll();zoomToFit();
    exportSVG({filename:f.name,sim:state.sim});
  }finally{
    applyState(snap,{applySim:false});
    undoStack=keepUndo;redoStack=keepRedo;S.selected=keepSel;
    view.x=keepView.x;view.y=keepView.y;view.zoom=keepView.zoom;
    cancelWire();applyView();renderAll();renderProps();
  }
}

function libraryOpen(){
  var m=document.getElementById('library-modal');
  return !!m&&m.style.display!=='none';
}
function showLibrary(){
  var modal=document.getElementById('library-modal');
  saveSchematic(); // so the list shows the current file's latest modified time
  libRenamingId=null;
  modal.style.display='flex';
  modal.onclick=function(e){if(e.target===modal)closeLibrary();};
  renderLibrary();
  loadGlobalLibrary();
}
function closeLibrary(){
  libRenamingId=null;
  document.getElementById('library-modal').style.display='none';
}
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&libraryOpen()&&e.target.tagName!=='INPUT')closeLibrary();
});

function libEl(tag,cls,text){
  var e=document.createElement(tag);
  if(cls)e.className=cls;
  if(text!=null)e.textContent=text;
  return e;
}
function libBtn(label,title,fn,extraCls){
  var b=libEl('button','tb-btn lib-btn'+(extraCls?' '+extraCls:''),label);
  b.title=title;
  b.onclick=fn;
  return b;
}
function libSection(title,hint){
  var sec=libEl('div','lib-section');
  sec.appendChild(libEl('div','lib-section-title',title));
  if(hint)sec.appendChild(libEl('div','lib-hint',hint));
  return sec;
}

function renderLibrary(){
  var body=document.getElementById('library-body');
  if(!body)return;
  body.textContent='';

  // ── Internal ──
  var sec=libSection('Internal library','Stored in this browser. Wiping site data deletes it — use DOWNLOAD to keep a file permanently.');
  var files=fileIndex.slice().sort(function(a,b){return b.modified-a.modified;});
  if(!files.length)sec.appendChild(libEl('div','lib-empty','No internal schematics.'));
  var focusInput=null;
  files.forEach(function(f){
    var isCur=f.id===currentFileId;
    var row=libEl('div','lib-row'+(isCur?' lib-row-current':''));
    var info=libEl('div','lib-info');
    var nameLine=libEl('div','lib-name-line');
    if(libRenamingId===f.id){
      var inp=libEl('input','lib-rename');
      inp.type='text';inp.value=f.name;
      var done=false;
      var commit=function(save){
        if(done)return;done=true;
        if(save)renameInternalFile(f.id,inp.value);
        libRenamingId=null;renderLibrary();
      };
      inp.addEventListener('keydown',function(e){
        if(e.key==='Enter')commit(true);
        else if(e.key==='Escape'){e.stopPropagation();commit(false);}
      });
      inp.addEventListener('blur',function(){commit(true);});
      nameLine.appendChild(inp);
      focusInput=inp;
    }else{
      nameLine.appendChild(libEl('span','lib-name',f.name));
    }
    if(isCur)nameLine.appendChild(libEl('span','lib-badge lib-badge-cur','CURRENT'));
    info.appendChild(nameLine);
    var meta='Modified '+new Date(f.modified).toLocaleString();
    if(f.origin)meta+=' · from library: '+f.origin.file+(f.origin.version?' v'+f.origin.version:'');
    var metaEl=libEl('div','lib-meta',meta);
    if(f.origin&&globalLibrary.status==='ok'){
      var g=globalLibrary.entries.filter(function(e){return e.file===f.origin.file;})[0];
      if(g&&g.version&&g.version!==f.origin.version)metaEl.appendChild(libEl('span','lib-badge lib-badge-new','v'+g.version+' available'));
    }
    info.appendChild(metaEl);
    row.appendChild(info);
    var act=libEl('div','lib-actions');
    act.appendChild(libBtn('OPEN',isCur?'This schematic is already open':'Open this schematic',function(){openInternalFile(f.id);}));
    act.appendChild(libBtn('RENAME','Rename (internal name only)',function(){libRenamingId=f.id;renderLibrary();}));
    act.appendChild(libBtn('DOWNLOAD','Download as SVG',function(){downloadInternalFile(f.id);}));
    act.appendChild(libBtn('DELETE','Delete from browser storage',function(){deleteInternalFile(f.id);renderLibrary();},'lib-btn-danger'));
    row.appendChild(act);
    sec.appendChild(row);
  });
  body.appendChild(sec);

  // ── Global ──
  var gTitle='Global library'+(globalLibrary.version?' · v'+globalLibrary.version:'');
  var gsec=libSection(gTitle,globalLibrary.name||'Templates shipped with the project (read-only). OPEN copies one into your internal library.');
  if(globalLibrary.status==='loading')gsec.appendChild(libEl('div','lib-empty','Loading…'));
  else if(globalLibrary.status==='error')gsec.appendChild(libEl('div','lib-empty lib-error','Could not load '+LIBRARY_DIR+LIBRARY_INDEX_FILE+' ('+globalLibrary.error+'). The app has to be served over http(s), not opened via file://.'));
  else if(globalLibrary.status==='ok'&&!globalLibrary.entries.length)gsec.appendChild(libEl('div','lib-empty','No schematics in the global library yet.'));
  if(globalLibrary.status==='ok')globalLibrary.entries.forEach(function(e){
    var row=libEl('div','lib-row');
    var info=libEl('div','lib-info');
    var nameLine=libEl('div','lib-name-line');
    nameLine.appendChild(libEl('span','lib-name',e.name));
    if(e.version)nameLine.appendChild(libEl('span','lib-badge','v'+e.version));
    info.appendChild(nameLine);
    if(e.description)info.appendChild(libEl('div','lib-meta',e.description));
    row.appendChild(info);
    var act=libEl('div','lib-actions');
    act.appendChild(libBtn('OPEN','Copy into the internal library and open',function(){openGlobalSchematic(e);}));
    act.appendChild(libBtn('DOWNLOAD','Download the SVG file',function(){downloadGlobalSchematic(e);}));
    row.appendChild(act);
    gsec.appendChild(row);
  });
  body.appendChild(gsec);

  if(focusInput){focusInput.focus();focusInput.select();}
}

// ═══ INIT ═══
loadLibrary();
mergeCustomComponents();
loadSchematic();
renderAll();renderProps();
zoomToFit();
if(undoStack.length===0){ clearHistory(); pushState(); }
renderCustomCompsList();
seedLibraryFromDefaults();

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
    if(newWidth<minWidth)return;
    sidebar.style.width=newWidth+'px';
    // The canvas and the plot pane grow/shrink with the sidebar, so their
    // viewBox / canvas size has to follow.
    applyView();
    if(typeof resizeSimPlot==='function')resizeSimPlot();
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

// ═══ ABOUT DIALOG (click on the logo) ═══
// Build info comes from js/version.js, which the Pages deploy workflow
// overwrites; a local checkout only has the 'local build' defaults.
function showAbout(){
  if(document.getElementById('about-overlay'))return;
  var b=window.APP_BUILD||{};
  var rows=[['Version',b.version||'unknown']];
  if(b.commit){
    var short=esc(b.commit.slice(0,7));
    rows.push(['Git commit',b.url&&/^https:\/\//.test(b.url)?'<a href="'+esc(b.url)+'" target="_blank" rel="noopener" style="color:var(--accent)">'+short+'</a>':short]);
  }else rows.push(['Git commit','not available in local builds']);
  if(b.date)rows.push(['Built',esc(b.date)]);
  var ov=document.createElement('div');
  ov.id='about-overlay';ov.className='dialog-overlay';
  ov.innerHTML='<div class="dialog" style="width:340px">'+
    '<div class="dialog-header">TurmericLab</div>'+
    '<div style="padding:14px 16px"><table class="about-table">'+
    rows.map(function(r){return '<tr><td>'+r[0]+'</td><td>'+(r[0]==='Version'?esc(r[1]):r[1])+'</td></tr>';}).join('')+
    '</table></div>'+
    '<div class="dialog-footer"><button class="tb-btn" id="about-close">CLOSE</button></div></div>';
  function close(){ov.remove();document.removeEventListener('keydown',onKey,true);}
  function onKey(e){if(e.key==='Escape'){e.stopPropagation();close();}}
  ov.addEventListener('click',function(e){if(e.target===ov)close();});
  document.addEventListener('keydown',onKey,true);
  document.body.appendChild(ov);
  document.getElementById('about-close').onclick=close;
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
// ═══ SIDEBAR: collapsible sections ═══
// Quick Access (data-pinned) is always open; the other sections form an
// accordion (at most one open at a time).
function initSidebarSections(){
  var secs=Array.prototype.filter.call(document.querySelectorAll('#sidebar .sb-sec'),function(s){return !s.hasAttribute('data-pinned');});
  function open(sec){
    secs.forEach(function(s){s.classList.toggle('open',s===sec&&!s.classList.contains('open'));});
  }
  secs.forEach(function(sec){
    var head=sec.querySelector('.sb-toggle');
    head.addEventListener('click',function(){open(sec);});
    head.addEventListener('keydown',function(e){
      if(e.target===head&&(e.key==='Enter'||e.key===' ')){e.preventDefault();open(sec);}
    });
  });
}
initSidebarSections();
