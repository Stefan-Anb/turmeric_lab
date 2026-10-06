// ═══════════════════════════════════════════════════
// SVG HELPERS
// ═══════════════════════════════════════════════════
function el(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;}
function L(p,x1,y1,x2,y2,cls){const e=el('line',{x1,y1,x2,y2});if(cls)e.setAttribute('class',cls);p.appendChild(e);return e;}
const LE=L;
function R(p,x,y,w,h,cls){const e=el('rect',{x,y,width:w,height:h});if(cls)e.setAttribute('class',cls);p.appendChild(e);return e;}
function CE(p,cx,cy,r,cls){const e=el('circle',{cx,cy,r});if(cls)e.setAttribute('class',cls);p.appendChild(e);return e;}
function PE(p,d,cls){const e=el('path',{d});if(cls)e.setAttribute('class',cls);p.appendChild(e);return e;}
function PY(p,pts,cls){const e=el('polygon',{points:pts});if(cls)e.setAttribute('class',cls);p.appendChild(e);return e;}
function T(p,x,y,s,cls){const e=el('text',{x,y});if(cls)e.setAttribute('class',cls);e.textContent=s;e.setAttribute('text-anchor','middle');p.appendChild(e);return e;}
function TE(p,x,y,s,cls){const e=el('text',{x,y});if(cls)e.setAttribute('class',cls);e.textContent=s;e.setAttribute('text-anchor','middle');p.appendChild(e);return e;}
function TA(p,x,y,s,cls){const e=el('text',{x,y});if(cls)e.setAttribute('class',cls);e.textContent=s;e.setAttribute('text-anchor','middle');e.setAttribute('dominant-baseline','middle');p.appendChild(e);return e;}
function AH(p,x1,y1,x2,y2){
  const dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy),nx=dx/len,ny=dy/len,px=-ny,py=nx;
  PY(p,`${x2},${y2} ${x2-nx*10+px*4},${y2-ny*10+py*4} ${x2-nx*10-px*4},${y2-ny*10-py*4}`,'comp-body');
}

// Picks the label/value clearance for a component that draws itself in a
// fixed local frame while its rot/mirror is applied afterwards (see
// renderComps() in app.js). Reference/value text never rotates with the
// body — only its anchor point does — so an offset chosen to clear a body
// that is wide-and-short at rot 0/180 is nowhere near enough once that same
// body becomes narrow-and-tall at rot 90/270: the text's own (unrotated)
// width then runs across the narrow body instead of alongside the wide one.
// `horiz`/`vert` are the two clearance magnitudes to use in each case.
function vOff(v,horiz,vert){
  return (v.rot===90||v.rot===270)?vert:horiz;
}

// renderComps() (app.js) mirrors a component by flipping the x of every pin
// and text *anchor point* — it has no idea a given text was authored with
// text-anchor 'start'/'end' to make it grow away from the body on one
// particular side, so that anchor keyword itself never flips. Left as-is,
// a mirrored 'start'-anchored label grows towards the body instead of away
// from it. Any draw() that hand-picks 'start'/'end' (rather than the T()/TA()
// default 'middle', which is symmetric and needs no help) must route it
// through this.
function mSide(v,side){
  if(!v.mirror)return side;
  return side==='start'?'end':(side==='end'?'start':side);
}

// Inverse of xfPin() (js/schematic.js): given the WORLD position a text
// should always end up at, returns the local (pre-rot/mirror) coordinate to
// draw it at. renderComps() (app.js) applies xfPin(local, rot, mirror) to
// every text's anchor point after draw() runs — feeding it invXfPin's output
// undoes that up front, so the text lands at exactly (wx,wy) in every
// rotation/mirror combination, with no per-orientation branching needed at
// the call site. xfPin applies mirror first, then rotation, so the inverse
// undoes rotation first, then mirror.
function invXfPin(wx,wy,rot,mir){
  var r=-(rot||0)*Math.PI/180,c=Math.round(Math.cos(r)),s=Math.round(Math.sin(r));
  var x=wx*c-wy*s,y=wx*s+wy*c;
  if(mir)x=-x;
  return{x:x,y:y};
}
// Shorthand for the common case: T()/TA() at a fixed world position.
function worldAnchor(v,wx,wy){
  return invXfPin(wx,wy,v.rot||0,v.mirror||false);
}

// Shared reference/value placement for npn/pnp/nmos, whose body/pins are
// identical in layout (B/G on the left at local x=-40, C+E/D+S branching out
// to the right, C-E/D-S axis vertical). Rot 0/180 ("vertical": the C-E axis
// runs top-to-bottom) stacks both to the side, opposite the base/gate pin —
// deliberately in the *local* frame (not via worldAnchor()), so the pair
// tracks the component's own rotation/mirror like any pin would, always
// landing on whichever side base/gate isn't. Rot 90/270 ("horizontal": that
// axis now runs left-to-right) goes back to plain above/below.
//
// Which world side the rot-0/180 pair lands on depends on rot *and* mirror
// together (not just one or the other), so rather than guess via mSide()
// this runs the same xfPin() transform renderComps() (app.js) is about to
// apply and reads the resulting sign straight off it: growing 'start'
// (rightward) when that lands at positive world x, 'end' otherwise — always
// away from the body, whichever side it ended up on.
function drawTransistorLabels(g,v,defLbl){
  if(v.rot===0||v.rot===180){
    // Shifted half a grid step (10) down from center for a bit more
    // breathing room under the collector/emitter lines above.
    var lp=xfPin(34,-2,v.rot,v.mirror),vp=xfPin(34,22,v.rot,v.mirror);
    var rt=T(g,34,-2,v.label||defLbl,'comp-label');rt.setAttribute('text-anchor',lp.x>=0?'start':'end');
    var vt=T(g,34,22,v.value||'default','comp-value');vt.setAttribute('text-anchor',vp.x>=0?'start':'end');
  } else {
    T(g,0,-58,v.label||defLbl,'comp-label');
    T(g,0,58,v.value||'default','comp-value');
  }
}

// ═══════════════════════════════════════════════════
// TINY VANILLA MARKDOWN RENDERER (for the Note element)
// Deliberately minimal — headers, bold/italic/strikethrough/inline code,
// unordered lists, blank-line paragraph breaks. No tables, links, images,
// nested lists, etc. Input is HTML-escaped first, so markdown source can
// never inject markup.
// ═══════════════════════════════════════════════════
function renderMiniMarkdown(src){
  var text=String(src==null?'':src).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  function inline(s){
    s=s.replace(/`([^`]+)`/g,'<code>$1</code>');
    s=s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g,function(m,a,b){return '<strong>'+(a!==undefined?a:b)+'</strong>';});
    s=s.replace(/\*([^*]+)\*|_([^_]+)_/g,function(m,a,b){return '<em>'+(a!==undefined?a:b)+'</em>';});
    s=s.replace(/~~([^~]+)~~/g,'<del>$1</del>');
    return s;
  }
  var lines=text.split('\n');
  var out=[],listOpen=false;
  function closeList(){ if(listOpen){out.push('</ul>');listOpen=false;} }
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    var h=line.match(/^(#{1,3})\s+(.*)$/);
    var li=line.match(/^[-*]\s+(.*)$/);
    if(h){
      closeList();
      var lvl=h[1].length;
      out.push('<h'+lvl+'>'+inline(h[2])+'</h'+lvl+'>');
    } else if(li){
      if(!listOpen){out.push('<ul>');listOpen=true;}
      out.push('<li>'+inline(li[1])+'</li>');
    } else {
      closeList();
      if(line.trim()==='') out.push('<br>');
      else out.push('<div>'+inline(line)+'</div>');
    }
  }
  closeList();
  return out.join('');
}

// ═══════════════════════════════════════════
// COMPONENT LIBRARY — static definitions
// All pin.x/pin.y must be multiples of GRID (20).
// Symbols are drawn relative to (0,0) = anchor.
// GND: pin at (0,0) top, body goes downward.
// VCC: pin at (0,0) bottom, body goes upward.
// ═══════════════════════════════════════════════════
// Custom components live in two separate registries:
//  - libraryComponents: persistent, schematic-independent "parts bin"
//    (localStorage key 'schematic_library', seeded from
//    lib/default_components.json). Never touched by loadSchematic/importSVG.
//  - customComponents: the definitions actually embedded in/owned by the
//    CURRENT schematic ("inline"). Replaced wholesale whenever a schematic is
//    loaded/imported, same as the rest of S.* — that is intentional, a
//    document brings its own copies with it.
// CD (the flat runtime dictionary used everywhere for rendering/placement/
// netlisting) is built by layering both registries via mergeCustomComponents,
// library first so an inline definition always wins on key collision — a
// loaded schematic renders/simulates exactly as authored, regardless of what
// the user's local library has since diverged into. See DOKUMENTATION.md
// chapter 8 for the full rationale.
var customComponents={};
var libraryComponents={};

// Custom components are persisted via JSON.stringify (localStorage / export),
// which silently drops their `draw` function. mergeCustomComponents rebuilds a
// generic box-drawing `draw` from the stored geometry whenever it is missing,
// so a round-tripped definition stays renderable. This is why custom defs can
// be saved as plain data without losing their symbol.
function mergeCustomComponents(){
  function install(reg){
    for(var key in reg){
      var comp=reg[key];
      if(comp && !comp.draw){
        var bodyW=comp.hitW-40;
        var bodyH=comp.hitH;
        var name=comp._name||comp.lbl;
        var prefix=comp.lbl;
        comp.draw=function(g,v){
          R(g,-bodyW/2,-bodyH/2,bodyW,bodyH,'comp-body');
          // Match createCustomCompDef()'s clearance (label 8px above/below
          // is too tight once rot 90/270 turns bodyH into the box's
          // *width* — see vOff()'s doc comment).
          T(g,0,-bodyH/2-16,v.label||prefix+'1','comp-label');
          T(g,0,bodyH/2+22,name,'comp-value');
          for(var i=0;i<comp.pins.length;i++){
            var pin=comp.pins[i];
            var isLeft=pin.x<0;
            var pinY=pin.y;
            var frameX=isLeft?-bodyW/2:bodyW/2;
            var outX=isLeft?frameX-20:frameX+20;
            L(g,frameX,pinY,outX,pinY,'comp-pin');
            var textEl=el('text',{x:isLeft?frameX+8:frameX-8,y:pinY+4});
            textEl.textContent=pin.n;
            textEl.setAttribute('class','comp-label');
            textEl.setAttribute('text-anchor',mSide(v,isLeft?'start':'end'));
            g.appendChild(textEl);
          }
        };
      }
      CD[key]=comp;
    }
  }
  install(libraryComponents);
  install(customComponents);
}

// Reverse of createCustomCompDef: extracts the editable {name,prefix,
// leftPins,rightPins,description,model} config back out of a built
// definition. Shared by the editor's "load into form" step, cloning, "Save
// to Library" and "Update from Library" — anywhere an existing def needs to
// become a fresh, correctly-closured one again via createCustomCompDef.
function extractCustomCompConfig(def){
  var leftPins=[],rightPins=[];
  for(var i=0;i<(def.pins||[]).length;i++){
    var p=def.pins[i];
    (p.x<0?leftPins:rightPins).push(p.n||'');
  }
  if(!leftPins.length)leftPins=[''];
  if(!rightPins.length)rightPins=[''];
  return {
    name:def._name||def.lbl||'Custom',
    prefix:def.lbl||'U',
    leftPins:leftPins,
    rightPins:rightPins,
    description:def._desc||'',
    model:def._model||''
  };
}

// Finds the first ".subckt NAME p1 p2 ..." line (honouring "+" continuation
// lines) and returns {name,pins} node names, or null. Pin-list parsing stops
// at a "PARAMS:" marker or the first "key=value" token, since those are
// subcircuit parameters, not connection nodes.
function parseSubcktHeader(text){
  if(!text)return null;
  var lines=String(text).split(/\r\n|\r|\n/);
  for(var i=0;i<lines.length;i++){
    var m=lines[i].match(/^\s*\.subckt\s+(\S+)\s*(.*)$/i);
    if(!m)continue;
    var name=m[1];
    var rest=m[2]||'';
    var j=i+1;
    while(j<lines.length && /^\s*\+/.test(lines[j])){ rest+=' '+lines[j].replace(/^\s*\+/,''); j++; }
    var tokens=rest.trim().split(/\s+/).filter(Boolean);
    var pins=[];
    for(var k=0;k<tokens.length;k++){
      var t=tokens[k];
      if(/^params:$/i.test(t))break;
      if(t.indexOf('=')>=0)break;
      pins.push(t);
    }
    return {name:name,pins:pins};
  }
  return null;
}

// Prefers the name declared by the attached model's own .subckt header (the
// X-line must call that exact name) over the editor's cosmetic "Name" field.
function customSubcktName(def){
  var parsed=def&&def._model?parseSubcktHeader(def._model):null;
  return (parsed&&parsed.name)||(def&&(def._name||def.lbl))||'';
}

function createCustomCompDef(providedKey,config){
  var name=config.name||'Custom';
  var prefix=config.prefix||'U';
  var leftPins=config.leftPins||[];
  var rightPins=config.rightPins||[];
  var desc=config.description||'';
  var model=config.model||'';
  var key=providedKey||('custom_'+name.replace(/[^a-zA-Z0-9]/g,'_').toLowerCase());
  var maxLeftLen=0, maxRightLen=0;
  for(var i=0;i<leftPins.length;i++)if(leftPins[i]&&leftPins[i].trim())maxLeftLen=Math.max(maxLeftLen,leftPins[i].length);
  for(var i=0;i<rightPins.length;i++)if(rightPins[i]&&rightPins[i].trim())maxRightLen=Math.max(maxRightLen,rightPins[i].length);
  var textWidth=Math.max(maxLeftLen,maxRightLen)*12;
  var bodyW=Math.max(80,textWidth+100);
  var bodyH=Math.max(60,(Math.max(leftPins.length,rightPins.length)-1)*20+50);
  var pinStartY=Math.round((-bodyH/2+30)/20)*20;
  if(pinStartY<-bodyH/2+20)pinStartY=-bodyH/2+20;
  var leftX=-Math.round((bodyW/2+20)/20)*20;
  var rightX=Math.round((bodyW/2+20)/20)*20;
  var pins=[];
  for(var i=0;i<leftPins.length;i++){
    if(leftPins[i]!==undefined){
      pins.push({x:leftX,y:pinStartY+i*20,n:leftPins[i]});
    }
  }
  for(var i=0;i<rightPins.length;i++){
    if(rightPins[i]!==undefined){
      pins.push({x:rightX,y:pinStartY+i*20,n:rightPins[i]});
    }
  }
  var partCount=0;
  for(var ckey in CD)if(CD[ckey].lbl===prefix)partCount++;
  var def={
    lbl:prefix,val:desc,hitW:bodyW+40,hitH:bodyH,
    props:{label:{l:'Reference'}},
    _desc:desc,_model:model,_name:name,
    pins:pins,
    draw:function(g,v){
      R(g,-bodyW/2,-bodyH/2,bodyW,bodyH,'comp-body');
      T(g,0,-bodyH/2-8,v.label||prefix+(partCount+1),'comp-label');
      T(g,0,bodyH/2+22,name,'comp-value');
      for(var i=0;i<pins.length;i++){
        var pin=pins[i];
        if(!pin.n)continue;
        var isLeft=pin.x<0;
        var frameX=isLeft?-bodyW/2:bodyW/2;
        L(g,frameX,pin.y,pin.x,pin.y,'comp-pin');
        var textEl=el('text',{x:isLeft?frameX+8:frameX-8,y:pin.y+4});
        textEl.textContent=pin.n;
        textEl.setAttribute('class','comp-label');
        textEl.setAttribute('text-anchor',mSide(v,isLeft?'start':'end'));
        g.appendChild(textEl);
      }
    }
  };
  // Pure builder: does NOT assign into any registry. The caller decides
  // whether this def becomes an inline (customComponents), library
  // (libraryComponents) or throwaway/preview definition.
  return {key:key,def:def};
}

const CD={
  resistor:{
    lbl:'R',val:'1k',hitW:100,hitH:40,
    props:{label:{l:'Reference'},value:{l:'Value'}},
    pins:[{x:-40,y:0,n:'A'},{x:40,y:0,n:'B'}],
    draw(g,v){
      L(g,-40,0,-17,0,'comp-pin');R(g,-17,-8,34,16,'comp-body');L(g,17,0,40,0,'comp-pin');
      // Horizontal: value sits inside the body, centered, reference above.
      // Vertical: both move outside, stacked to the right and left-aligned
      // (reference above value) — same convention as capacitor/inductor.
      // worldAnchor() (see its doc comment) keeps each pinned to that side
      // regardless of rot/mirror.
      var vert=(v.rot===90||v.rot===270);
      if(vert){
        var pRef=worldAnchor(v,26,-12),pVal=worldAnchor(v,26,12);
        var rt=T(g,pRef.x,pRef.y,v.label||'R','comp-label');rt.setAttribute('text-anchor','start');
        var vt=T(g,pVal.x,pVal.y,v.value||'','comp-value');vt.setAttribute('text-anchor','start');
      } else {
        var valEl=TA(g,0,0,v.value||'','comp-value');valEl.style.fontSize='11px';
        var p=worldAnchor(v,0,-17);
        T(g,p.x,p.y,v.label||'R','comp-label');
      }
    }
  },
  capacitor:{
    lbl:'C',val:'100n',hitW:100,hitH:50,
    props:{label:{l:'Reference'},value:{l:'Value'}},
    pins:[{x:0,y:-40,n:'A'},{x:0,y:40,n:'B'}],
    draw(g,v){
      const ig=el('g',{transform:'rotate(90)'});g.appendChild(ig);
      L(ig,-40,0,-7,0,'comp-pin');
      LE(ig,-7,-14,-7,14,'comp-body');LE(ig,7,-14,7,14,'comp-body');
      L(ig,7,0,40,0,'comp-pin');
      // Native orientation (rot 0/180, via the ig rotate above) draws the
      // pins vertically: reference above value, stacked and left-aligned, to
      // the right of the plates. Rotated to horizontal (rot 90/270) they go
      // back to the usual above/below, close to the body. worldAnchor() (see
      // its doc comment) pins each to a fixed world position regardless of
      // rot/mirror, so no per-orientation branching is needed beyond this.
      var vertNative=(v.rot===0||v.rot===180);
      if(vertNative){
        var pRef=worldAnchor(v,20,-12),pVal=worldAnchor(v,20,12);
        var rt=T(g,pRef.x,pRef.y,v.label||'C','comp-label');rt.setAttribute('text-anchor','start');
        var vt=T(g,pVal.x,pVal.y,v.value||'','comp-value');vt.setAttribute('text-anchor','start');
      } else {
        var pRef=worldAnchor(v,0,-24),pVal=worldAnchor(v,0,28);
        T(g,pRef.x,pRef.y,v.label||'C','comp-label');
        T(g,pVal.x,pVal.y,v.value||'','comp-value');
      }
    }
  },
  inductor:{
    lbl:'L',val:'10µH',hitW:100,hitH:40,
    props:{label:{l:'Reference'},value:{l:'Value'}},
    pins:[{x:-40,y:0,n:'A'},{x:40,y:0,n:'B'}],
    draw(g,v){
      L(g,-40,0,-20,0,'comp-pin');
      PE(g,'M-20,0 Q-15,-12 -10,0 Q-5,-12 0,0 Q5,-12 10,0 Q15,-12 20,0','comp-body');
      L(g,20,0,40,0,'comp-pin');
      // Native orientation (rot 0/180) is horizontal: reference above, value
      // below, close to the body. Rotated to vertical (rot 90/270), stack
      // both to the right instead — see capacitor's identical convention
      // and worldAnchor()'s doc comment.
      var vert=(v.rot===90||v.rot===270);
      if(vert){
        var pRef=worldAnchor(v,20,-12),pVal=worldAnchor(v,20,12);
        var rt=T(g,pRef.x,pRef.y,v.label||'L','comp-label');rt.setAttribute('text-anchor','start');
        var vt=T(g,pVal.x,pVal.y,v.value||'','comp-value');vt.setAttribute('text-anchor','start');
      } else {
        var pRef=worldAnchor(v,0,-20),pVal=worldAnchor(v,0,20);
        T(g,pRef.x,pRef.y,v.label||'L','comp-label');
        T(g,pVal.x,pVal.y,v.value||'','comp-value');
      }
    }
  },
  // Ideal transformer, modeled the standard SPICE way as two coupled
  // inductors: a primary L, a secondary L, and a K (mutual coupling)
  // statement between them (see generateNetlist()'s 'transformer' branch).
  // Secondary inductance is derived from primary*u^2 (u = turns ratio) as a
  // SPICE {…} expression, not computed numerically here, so it keeps working
  // even when the primary value or u reference a .param.
  transformer:{
    lbl:'TR',val:'1m',hitW:170,hitH:160,
    props:{
      label:{l:'Reference'},
      value:{l:'Primary L',def:'1m'},
      u:{l:'Turns ratio (u)',def:'1'},
      k:{l:'Coupling (k)',def:'1'}
    },
    pins:[{x:-60,y:-40,n:'P1'},{x:-60,y:40,n:'P2'},{x:60,y:-40,n:'S1'},{x:60,y:40,n:'S2'}],
    draw(g,v){
      L(g,-60,-40,-20,-40,'comp-pin');L(g,-60,40,-20,40,'comp-pin');
      L(g,60,-40,20,-40,'comp-pin');L(g,60,40,20,40,'comp-pin');
      PE(g,'M-20,-40 Q-32,-30 -20,-20 Q-32,-10 -20,0 Q-32,10 -20,20 Q-32,30 -20,40','comp-body');
      PE(g,'M20,-40 Q32,-30 20,-20 Q32,-10 20,0 Q32,10 20,20 Q32,30 20,40','comp-body');
      LE(g,-6,-36,-6,36,'comp-body');LE(g,6,-36,6,36,'comp-body');
      // Dot convention marking each coil's start (the winding sense SPICE
      // actually sees): generateNetlist() (js/netlist.js) emits
      // "Lp P1 P2 …" / "Ls S1 S2 …" then couples them with a plain (signless)
      // K statement, so SPICE's own dot convention puts the polarity dot on
      // each inductor's *first* node — P1 and S1 here, both pins[0]/pins[2].
      CE(g,-16,-38,2.5,'pin-dot');CE(g,16,-38,2.5,'pin-dot');
      // Three stacked text lines: a naive (0,off) placement keeps them nicely
      // stacked at rot 0/180 but bunches them side by side at rot 90/270
      // (xfPin swaps which axis carries the offset) — placing the offset on
      // whichever local axis xfPin will swap into "perpendicular, world x=0"
      // keeps all three on that one line, correctly spaced, in every
      // rotation (see vOff()'s doc comment for the general issue).
      var vert=(v.rot===90||v.rot===270);
      function place(off,text,cls){ if(vert) T(g,off,0,text,cls); else T(g,0,off,text,cls); }
      place(-54,v.label||'TR','comp-label');
      place(60,'L='+(v.value||'1m'),'comp-value');
      place(84,'u='+(v.u||'1')+'  k='+(v.k||'1'),'comp-value');
    }
  },
  diode:{
    lbl:'D',val:'default',hitW:100,hitH:40,
    props:{label:{l:'Reference'},value:{l:'Part'}},
    pins:[{x:40,y:0,n:'A'},{x:-40,y:0,n:'K'}],
    draw(g,v){
      const ig=el('g',{transform:'rotate(180)'});g.appendChild(ig);
      L(ig,-40,0,-12,0,'comp-pin');
      PY(ig,'12,0 -12,-12 -12,12','comp-body');LE(ig,12,-12,12,12,'comp-body');
      L(ig,12,0,40,0,'comp-pin');
        T(g,0,-vOff(v,28,40),v.label||'D','comp-label');T(g,0,vOff(v,36,48),v.value||'','comp-value');
    }
  },
  led:{
    lbl:'D',val:'RED',hitW:100,hitH:40,
    props:{label:{l:'Reference'},value:{l:'Color'}},
    pins:[{x:-40,y:0,n:'A'},{x:40,y:0,n:'K'}],
    draw(g,v){
      L(g,-40,0,-12,0,'comp-pin');
      const t=PY(g,'12,0 -12,-12 -12,12','comp-body');t.style.stroke='#ff9040';t.style.fill='#1a0800';
      const b=LE(g,12,-12,12,12,'comp-body');b.style.stroke='#ff9040';
      L(g,12,0,40,0,'comp-pin');
      const a1=LE(g,16,-10,24,-20,'comp-pin');a1.style.stroke='#ff9040';
      const a2=LE(g,22,-7,30,-17,'comp-pin');a2.style.stroke='#ff9040';
      T(g,0,-vOff(v,38,44),v.label||'D','comp-label');
    }
  },
  zener:{
    // Z-diode: the breakdown voltage is a per-instance property; the netlist
    // generator emits a matching `.model … D(BV=…)` card for each one.
    lbl:'D',val:'default',hitW:100,hitH:40,
    props:{
      label:{l:'Reference'},
      value:{l:'Part'},
      bv:{l:'Breakdown Vz (V)',def:'5.1'},
      rs:{l:'Series R (Ω)',def:'1'},
      iz:{l:'Knee current Iz (A)',def:'5m'},
      model:{l:'Model override (opt.)'}
    },
    pins:[{x:-40,y:0,n:'A'},{x:40,y:0,n:'K'}],
    draw(g,v){
      L(g,-40,0,-12,0,'comp-pin');
      PY(g,'-12,-12 -12,12 12,0','comp-body');
      // cathode bar with the characteristic Z-shaped flags
      var bar=PE(g,'M4,-16 L12,-12 L12,12 L20,16','comp-body');bar.style.fill='none';
      L(g,12,0,40,0,'comp-pin');
      T(g,0,-vOff(v,30,40),v.label||'D','comp-label');
      T(g,0,vOff(v,38,48),(v.bv||'')?((v.bv||'')+'V'):(v.value||''),'comp-value');
    }
  },
  scr:{
    // Thyristor (SCR). Simulated with the classic two-transistor macro model,
    // emitted as the `scr_default` subcircuit by the netlist generator.
    lbl:'SCR',val:'',hitW:100,hitH:100,
    props:{
      label:{l:'Reference'},
      value:{l:'Part'},
      vgt:{l:'Gate trigger Vgt (V)',def:'0.7'},
      ih:{l:'Holding current Ih (A)',def:'5m'},
      ron:{l:'On resistance (Ω)',def:'0.1'},
      model:{l:'Subcircuit override (opt.)'}
    },
    pins:[{x:-40,y:0,n:'A'},{x:40,y:0,n:'K'},{x:20,y:40,n:'G'}],
    draw(g,v){
      L(g,-40,0,-12,0,'comp-pin');
      PY(g,'-12,-12 -12,12 12,0','comp-body');
      LE(g,12,-14,12,14,'comp-body');
      L(g,12,0,40,0,'comp-pin');
      L(g,12,7,20,20,'comp-pin');L(g,20,20,20,40,'comp-pin');
      T(g,0,-vOff(v,30,40),v.label||'SCR','comp-label');
      if(v.value)T(g,0,vOff(v,52,52),v.value,'comp-value');
    }
  },
  pwmgen:{
    // PWM generator with half-bridge gate-drive outputs (behavioural subcircuit).
    // IN sets the duty cycle (0 … Range maps to 0 … 100 %) and is always
    // referenced to real ground (node 0). Each output has its own return:
    // OUTH/COMH is the high-side pair, OUTL/COML the low-side one.
    lbl:'PWM',val:'',hitW:180,hitH:200,
    props:{
      label:{l:'Reference'},
      pwm_freq:{l:'Frequency (Hz)',def:'10k'},
      pwm_range:{l:'Input range for 100 % (V)',def:'1'},
      pwm_vhigh:{l:'Output high (V)',def:'12'},
      pwm_vlow:{l:'Output low (V)',def:'0'},
      pwm_deadtime:{l:'Dead time (s)',def:'0'}
    },
    pins:[{x:-80,y:0,n:'IN'},
          {x:80,y:-60,n:'OUTH'},{x:80,y:-20,n:'COMH'},
          {x:80,y:20,n:'OUTL'},{x:80,y:60,n:'COML'}],
    draw(g,v){
      R(g,-60,-80,120,160,'comp-body');
      L(g,-80,0,-60,0,'comp-pin');
      L(g,60,-60,80,-60,'comp-pin');L(g,60,-20,80,-20,'comp-pin');
      L(g,60,20,80,20,'comp-pin');L(g,60,60,80,60,'comp-pin');
      var names=[['IN',-52,4,'start'],
                 ['OUTH',52,-56,'end'],['COMH',52,-16,'end'],
                 ['OUTL',52,24,'end'],['COML',52,64,'end']];
      for(var i=0;i<names.length;i++){
        var t=el('text',{x:names[i][1],y:names[i][2],class:'comp-label'});
        t.textContent=names[i][0];t.setAttribute('text-anchor',mSide(v,names[i][3]));
        t.style.fontSize='12px';g.appendChild(t);
      }
      // separator between the high- and the low-side half (galvanic isolation);
      // only drawn on the output-pin side (right half) — the IN pin enters
      // on the left, exactly on this line, so drawing it there too would
      // run the dash straight through that pin's wire.
      var sep=LE(g,0,0,60,0,'comp-pin');sep.style.strokeDasharray='4 4';sep.style.opacity='.45';
      // duty-cycle icon
      PE(g,'M-24,-30 L-24,-46 L-10,-46 L-10,-30 L2,-30 L2,-46 L16,-46 L16,-30',
        'comp-body').style.fill='none';
      T(g,-2,-90,v.label||'PWM','comp-label');
      T(g,-2,48,(v.pwm_freq||'')?((v.pwm_freq||'')+'Hz'):'','comp-value');
    }
  },
  npn:{
    lbl:'Q',val:'default',hitW:100,hitH:100,
    props:{label:{l:'Reference'},value:{l:'Part'}},
    pins:[{x:-40,y:0,n:'B'},{x:20,y:-40,n:'C'},{x:20,y:40,n:'E'}],
    draw(g,v){
      L(g,-40,0,-8,0,'comp-pin');
      LE(g,-8,-20,-8,20,'comp-body');
      LE(g,-8,-14,12,-26,'comp-body');LE(g,-8,14,12,26,'comp-body');
      L(g,12,-26,20,-40,'comp-pin');L(g,12,26,20,40,'comp-pin');
      AH(g,12,26,20,40);
      drawTransistorLabels(g,v,'Q');
    }
  },
  pnp:{
    lbl:'Q',val:'default',hitW:100,hitH:100,
    props:{label:{l:'Reference'},value:{l:'Part'}},
    pins:[{x:-40,y:0,n:'B'},{x:20,y:-40,n:'C'},{x:20,y:40,n:'E'}],
    draw(g,v){
      L(g,-40,0,-8,0,'comp-pin');
      LE(g,-8,-20,-8,20,'comp-body');
      LE(g,-8,-14,12,-26,'comp-body');LE(g,-8,14,12,26,'comp-body');
      L(g,12,-26,20,-40,'comp-pin');L(g,12,26,20,40,'comp-pin');
      AH(g,20,-40,12,-26);
      drawTransistorLabels(g,v,'Q');
    }
  },
  nmos:{
    lbl:'M',val:'default',hitW:100,hitH:100,
    props:{label:{l:'Reference'},value:{l:'Part'},rdson:{l:'Rds(on) (Ω)',def:'1m'}},
    pins:[{x:-40,y:0,n:'G'},{x:20,y:-40,n:'D'},{x:20,y:40,n:'S'}],
    draw(g,v){
      L(g,-40,0,-12,0,'comp-pin');
      LE(g,-12,-20,-12,20,'comp-body');LE(g,-4,-16,-4,16,'comp-body');
      LE(g,-4,-12,12,-12,'comp-body');LE(g,-4,0,12,0,'comp-body');LE(g,-4,12,12,12,'comp-body');
      L(g,12,-12,20,-40,'comp-pin');L(g,12,12,20,40,'comp-pin');
      AH(g,4,0,-4,0);
      drawTransistorLabels(g,v,'M');
    }
  },
  source:{
    lbl:'SRC',val:'5V',hitW:100,hitH:60,
    props:{
      mode:{l:'Mode',type:'enum',options:[{v:'DC',l:'DC'},{v:'AC',l:'AC'},{v:'PULSE',l:'Pulse'},{v:'BEHAV',l:'Behavioural'}]},
      meas:{l:'Show',type:'enum',options:[{v:'V',l:'Voltage'},{v:'I',l:'Current'}]},
      label:{l:'Reference'},
      // Small-signal AC excitation for a .ac analysis. Independent of Mode above
      // (which shapes the transient waveform) — SPICE sources carry both at
      // once, e.g. "V1 n1 n2 DC 0 AC 1 SIN(...)".
      ac_mag:{l:'.ac magnitude (opt.)'},
      ac_phase:{l:'.ac phase (deg, opt.)'},
      // DC
      value:{l:'Voltage (V)',modes:['DC']},
      // AC params
      ac_offset:{l:'Offset (V)',modes:['AC']},
      ac_amplitude:{l:'Amplitude (V)',modes:['AC']},
      ac_frequency:{l:'Frequency (Hz)',modes:['AC']},
      ac_tdelay:{l:'TDelay (s)',modes:['AC']},
      ac_theta:{l:'Theta (1/s)',modes:['AC']},
      ac_phi:{l:'Phi (deg)',modes:['AC']},
      ac_ncycles:{l:'Ncycles',modes:['AC']},
      // Pulse params
      pulse_vinit:{l:'Vinitial (V)',modes:['PULSE']},
      pulse_von:{l:'Von (V)',modes:['PULSE']},
      pulse_tdelay:{l:'TDelay (s)',modes:['PULSE']},
      pulse_trise:{l:'Trise (s)',modes:['PULSE']},
      pulse_tfall:{l:'Tfall (s)',modes:['PULSE']},
      pulse_ton:{l:'Ton (s)',modes:['PULSE']},
      pulse_tperiod:{l:'Tperiod (s)',modes:['PULSE']},
      pulse_ncycles:{l:'Ncycles',modes:['PULSE']},
      // Behavioural
      beh_eq:{l:'Equation',modes:['BEHAV']}
    },
    pins:[{x:0,y:-40,n:'+'},{x:0,y:40,n:'-'}],
    draw(g,v){
      const mode=(v.mode||'DC');
      const meas=(v.meas||'V');
      const ig=el('g',{transform:'rotate(90)'});g.appendChild(ig);
      CE(ig,0,0,20,'comp-body');
      L(ig,-40,0,-20,0,'comp-pin');L(ig,20,0,40,0,'comp-pin');
      // Mode is a single Unicode character (no separate geometric icon
      // anymore — that was redundant with this): DC:'⎓' AC:'⏦' Pulse:'⎍'
      // Behavioural:'B'. Both this and the V/I line below it are sized to
      // fit inside the r=20 circle.
      var symChar=mode==='AC'?'⏦':(mode==='PULSE'?'⎍':(mode==='BEHAV'?'B':'⎓'));
      var t1=TA(g,0,-9,symChar,'comp-label');t1.style.fontSize='12px';
      var t2=TA(g,0,11,meas,'comp-value');t2.style.fontSize='12px';
      // Small "+" outside the circle, close beside the + pin (pins[0], local
      // (0,-40) before the ig rotate) rather than straight out along it —
      // sitting on that line would put a wire drawn along the pin right
      // through the "+". The sideways offset (local x=14) has to be large
      // enough that the "+" glyph's own ascent clears the pin once it's
      // rotated onto the perpendicular axis (see vOff()'s doc comment for
      // why a naive small offset only survives some rotations); the
      // along-pin offset (local y=-22) just keeps it close to the circle.
      var plus=TA(g,16,-25,'+','comp-label');plus.style.fontSize='11px';
      // Reference: above (centered) when horizontal, or to the right
      // (left-aligned) when vertical — same convention as resistor/opamp.
      // Native orientation (rot 0/180, via the ig rotate above) is vertical.
      if(v.rot===0||v.rot===180){
        var p=worldAnchor(v,28,0);
        var lbl=T(g,p.x,p.y,v.label||'SRC','comp-label');lbl.setAttribute('text-anchor','start');lbl.setAttribute('dominant-baseline','middle');
      } else {
        var p=worldAnchor(v,0,-30);
        T(g,p.x,p.y,v.label||'SRC','comp-label');
      }
    }
  },
  gnd:{
    lbl:'GND',val:'',hitW:40,hitH:60,
    props:{label:{l:'Net Name'}},
    pins:[{x:0,y:0,n:'GND'}],
    draw(g,v){
      L(g,0,0,0,10,'comp-pin');
      LE(g,-20,10,20,10,'comp-body');
      LE(g,-13,18,13,18,'comp-body');
      LE(g,-5,26,5,26,'comp-body');
    }
  },
  vcc:{
    lbl:'VCC',val:'+5V',hitW:60,hitH:40,
    props:{label:{l:'Net Name'},value:{l:'Voltage'}},
    pins:[{x:0,y:0,n:'VCC'}],
    draw(g,v){
      L(g,0,0,0,-10,'comp-pin');
      LE(g,-20,-10,20,-10,'comp-body');
      var text=v.value||v.label||'VCC';
      if(v.rot===0||v.rot===180){
        // Vertical (native): centered, close above the rail bar. At rot 180
        // this flips below the (also flipped) bar — needs enough margin for
        // the 18px font's ascent to clear it there too, not just above.
        var t=TE(g,0,-30,text,'comp-label');
        t.style.fill='#00c8ff';t.style.fontSize='18px';
      } else {
        // Horizontal: edge-anchored (start at rot 90, end at rot 270 — the
        // two rotations swap which side of the rail bar this offset lands
        // on) so the text always grows away from the bar, whatever its
        // length — a centered anchor would need to know the string width to
        // stay clear at both ends.
        var t=T(g,0,-24,text,'comp-label');
        t.setAttribute('text-anchor',v.rot===90?'start':'end');
        t.style.fill='#00c8ff';t.style.fontSize='18px';
      }
    }
  },
  opamp:{
    lbl:'U',val:'TL071',hitW:140,hitH:100,
    props:{label:{l:'Reference'},value:{l:'Part'}},
    pins:[{x:-60,y:-20,n:'IN-'},{x:-60,y:20,n:'IN+'},{x:60,y:0,n:'OUT'}],
    draw(g,v){
      PY(g,'-40,-40 -40,40 40,0','comp-body');
      L(g,-60,-20,-40,-20,'comp-pin');L(g,-60,20,-40,20,'comp-pin');L(g,40,0,60,0,'comp-pin');
      TA(g,-28,-20,'−','comp-label');TA(g,-28,20,'+','comp-label');
      // Horizontal (rot 0/180): reference above, value below, centered.
      // Vertical (rot 90/270): both stacked to the right, left-aligned —
      // worldAnchor() (see its doc comment) pins them to that side
      // regardless of rot/mirror.
      var vert=(v.rot===90||v.rot===270);
      if(vert){
        var pRef=worldAnchor(v,48,-10);
        var rt=T(g,pRef.x,pRef.y,v.label||'U','comp-label');rt.setAttribute('text-anchor','start');
      } else {
        T(g,0,-46,v.label||'U','comp-label');
      }
      // place component value under the name; value shown if present
      if(v.value){
        var valEl;
        if(vert){
          var pVal=worldAnchor(v,48,10);
          valEl=el('text',{x:pVal.x,y:pVal.y});valEl.setAttribute('text-anchor','start');
        } else {
          valEl=el('text',{x:0,y:50});valEl.setAttribute('text-anchor','middle');
        }
        valEl.textContent = v.value; valEl.setAttribute('class','comp-value'); g.appendChild(valEl);
      }
    }
  },
  sw:{
    lbl:'SW',val:'SW1',hitW:100,hitH:80,
    props:{label:{l:'Reference'},model:{l:'Model'}},
    pins:[{x:-40,y:0,n:'A'},{x:40,y:0,n:'B'},{x:-40,y:32,n:'+'},{x:40,y:32,n:'-'}],
    draw(g,v){
      L(g,-40,0,-14,0,'comp-pin');
      CE(g,-14,0,4,'pin-dot');CE(g,14,0,4,'pin-dot');
      LE(g,-14,0,12,-16,'comp-body');
      L(g,14,0,40,0,'comp-pin');
      R(g,-19,18,38,28,'comp-body');
      var plusMinusStyle=function(t){t.style.fontSize='10px';return t;};
      plusMinusStyle(TA(g,-8,32,'+','comp-label'));
      plusMinusStyle(TA(g,8,32,'-','comp-label'));
      L(g,-19,32,-40,32,'comp-pin');
      L(g,19,32,40,32,'comp-pin');
      T(g,0,-vOff(v,30,40),v.label||'SW','comp-label');
    }
  },
  netconn:{
    lbl:'NET',val:'',hitW:260,hitH:40,
    props:{label:{l:'Net Name'}},
    pins:[{x:-20,y:0,n:'~'}],
    draw(g,v){
      var nm=v.label||'?';
      // Flag arrow pointing right: pin on left
      L(g,-20,0,0,0,'comp-pin');
      PE(g,'M0,-14 L60,-14 L80,0 L60,14 L0,14 Z','comp-body');
      var t=TA(g,40,0,nm,'comp-label');
      t.style.fill='#00c8ff';t.style.fontSize='18px';t.style.fontWeight='bold';
    }
  },
  // A pure directive, not a real device: no pins, no net, contributes a single
  // ".param name=value" line to the netlist (see generateNetlist()). Any other
  // component's value field can then reference it as "{name}" — SPICE resolves
  // that expansion itself, nothing extra is needed on this end. Dashed body
  // marks it visually as "not a physical part" like gnd/vcc/netconn are.
  param:{
    lbl:'PARAM',val:'1',hitW:120,hitH:50,
    props:{label:{l:'Parameter name'},value:{l:'Value',def:'1'}},
    pins:[],
    draw(g,v){
      var name=(v.label||'PARAM').trim();
      var val=(v.value!=null&&v.value!=='')?v.value:'0';
      R(g,-55,-20,110,40,'comp-body param-body');
      // ".PARAM" sits above the box, clear of it — axis-swapped like place()
      // in the transformer, since a fixed (0,off) offset would land back
      // *inside* the box at rot 90/270 (the box's short/tall sides swap).
      var titleOff=vOff(v,30,65);
      if(v.rot===90||v.rot===270) T(g,-titleOff,0,'.PARAM','comp-label');
      else T(g,0,-titleOff,'.PARAM','comp-label');
      TA(g,0,4,name+' = '+val,'comp-value');
    }
  },
  // ═══ PURE UI ANNOTATION ELEMENTS ═══
  // These four types are never referenced by netlist.js (no pins, no
  // type-specific handling there), so they are invisible to the simulation.
  // Anchor convention: unlike electrical components (anchored at their
  // center), blanket/image/note are anchored at their TOP-LEFT corner
  // (x,y), with explicit w/h — this makes corner-resize math a plain
  // w+=dx/h+=dy instead of having to also shift the center.
  blanket:{
    lbl:'BLK',val:'',hitW:400,hitH:300,
    props:{
      label:{l:'Title',def:'Group'},
      w:{l:'Width',def:'400'},h:{l:'Height',def:'300'},
      // Note: placeComp() defaults an enum prop to options[0] (it ignores
      // `def` for enums), so the intended default is expressed via ordering.
      halign:{l:'Title H-Align',type:'enum',options:[{v:'center',l:'Center'},{v:'left',l:'Left'},{v:'right',l:'Right'}]},
      valign:{l:'Title V-Align',type:'enum',options:[{v:'top',l:'Top'},{v:'bottom',l:'Bottom'}]}
    },
    pins:[],
    draw(g,v){
      var w=parseFloat(v.w)||400,h=parseFloat(v.h)||300;
      R(g,0,0,w,h,'blanket-frame');
      var halign=v.halign||'center',valign=v.valign||'top';
      var tx=halign==='left'?10:(halign==='right'?w-10:w/2);
      var anchor=halign==='left'?'start':(halign==='right'?'end':'middle');
      var ty=valign==='bottom'?h-10:18;
      var t=el('text',{x:tx,y:ty,'text-anchor':anchor,class:'blanket-title'});
      t.textContent=v.label||'Group';
      g.appendChild(t);
    }
  },
  image:{
    lbl:'IMG',val:'',hitW:200,hitH:150,
    props:{label:{l:'Name',def:'Image'}},
    pins:[],
    draw(g,v){
      var w=parseFloat(v.w)||200,h=parseFloat(v.h)||150;
      var natW=v.natW||w,natH=v.natH||h;
      var crop=v.crop||{x:0,y:0,w:natW,h:natH};
      if(v.src){
        var inner=el('svg',{x:0,y:0,width:w,height:h,viewBox:crop.x+' '+crop.y+' '+crop.w+' '+crop.h,preserveAspectRatio:'none'});
        var imgEl=document.createElementNS('http://www.w3.org/2000/svg','image');
        // Plain `href` only (SVG2) — an `xlink:href` fallback would need the
        // schematic-svg root to declare xmlns:xlink, which it doesn't, and
        // adding the attribute without that declaration breaks exportSVG()'s
        // XML re-parse on import ("Namespace prefix xlink ... not defined").
        imgEl.setAttribute('href',v.src);
        imgEl.setAttribute('x','0');imgEl.setAttribute('y','0');
        imgEl.setAttribute('width',String(natW));imgEl.setAttribute('height',String(natH));
        imgEl.setAttribute('preserveAspectRatio','none');
        inner.appendChild(imgEl);
        g.appendChild(inner);
      }
      R(g,0,0,w,h,'image-frame');
    }
  },
  textlabel:{
    lbl:'TXT',val:'',hitW:80,hitH:24,
    props:{
      label:{l:'Text',def:'Label'},
      fontSize:{l:'Size',def:'36'},
      bold:{l:'Bold',type:'bool',def:true},
      italic:{l:'Italic',type:'bool',def:false},
      strike:{l:'Strikethrough',type:'bool',def:false}
    },
    pins:[],
    draw(g,v){
      var t=el('text',{x:0,y:0,class:'text-label'});
      t.textContent=v.label||'Label';
      var fs=parseFloat(v.fontSize)||36;
      t.style.fontSize=fs+'px';
      t.style.fontWeight=v.bold?'bold':'normal';
      t.style.fontStyle=v.italic?'italic':'normal';
      t.style.textDecoration=v.strike?'line-through':'none';
      g.appendChild(t);
    }
  },
  note:{
    lbl:'NOTE',val:'',hitW:220,hitH:160,
    props:{
      text:{l:'Text (Markdown)',type:'textarea',def:'Notiz'},
      w:{l:'Width',def:'220'},h:{l:'Height',def:'160'}
    },
    pins:[],
    draw(g,v){
      var w=parseFloat(v.w)||220,h=parseFloat(v.h)||160;
      R(g,0,0,w,h,'note-body');
      var fo=el('foreignObject',{x:6,y:6,width:Math.max(0,w-12),height:Math.max(0,h-12)});
      var div=document.createElement('div');
      // Explicit xmlns so exportSVG()'s serialized SVG re-parses correctly as
      // strict XML on import (importSVG() uses DOMParser in 'image/svg+xml'
      // mode, which requires HTML content inside <foreignObject> to declare
      // its namespace explicitly).
      div.setAttribute('xmlns','http://www.w3.org/1999/xhtml');
      div.className='note-text';
      div.innerHTML=renderMiniMarkdown(v.text||'');
      fo.appendChild(div);
      g.appendChild(fo);
    }
  }
};
