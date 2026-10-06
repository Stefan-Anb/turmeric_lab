// ═══════════════════════════════════════════════════
// PARAMETERS — dialog and "insert parameter" button
//
// The data model (S.params), the step-value maths and the netlist output live
// in js/netlist.js (paramStepValues, buildParamLines, buildStepPlan). This file
// is only the UI on top of it:
//   - the modal opened by the PARAMS button in the header bar, where static
//     parameters and swept ("step") parameters are created, and
//   - the ƒ button next to every text value field of the properties panel,
//     which inserts "{name}" for a chosen parameter (see renderProps()).
// Everything is edited live; there is no Apply button.
// ═══════════════════════════════════════════════════

var PARAM_STEP_TYPES=[
  {v:'lin',l:'Linear'},
  {v:'dec',l:'Decade'},
  {v:'oct',l:'Octave'},
  {v:'list',l:'List'}
];

function newParamDef(){
  var used=paramDefNames(),n=1;
  while(used['p'+n])n++;
  return {id:'p'+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36),
    name:'p'+n,value:'1k',
    step:{on:false,type:'lin',start:'100',stop:'1k',inc:'100',pts:'3',list:'100 220 470 1k'}};
}

function paramsChanged(){
  if(typeof saveSchematic==='function')saveSchematic();
}

// Every parameter a value field may reference: the dialog's own plus those
// declared by PARAM components on the sheet (those are edited on the sheet).
function paramListAll(){
  var out=[],seen={};
  paramDefs().forEach(function(p){
    var n=String(p.name||'').trim();
    if(!n||!PARAM_NAME_RE.test(n)||seen[n.toLowerCase()])return;
    seen[n.toLowerCase()]=true;
    out.push({name:n,swept:!!(p.step&&p.step.on),text:paramNominal(p)});
  });
  S.components.forEach(function(c){
    if(c.type!=='param')return;
    var n=String(c.label||'').trim();
    if(!n||!PARAM_NAME_RE.test(n)||seen[n.toLowerCase()])return;
    seen[n.toLowerCase()]=true;
    out.push({name:n,swept:false,text:(c.value!=null&&c.value!=='')?String(c.value):'0',comp:true});
  });
  return out;
}

// ═══ DIALOG ═══
function showParamsDialog(){
  var modal=document.getElementById('params-modal');
  if(!modal)return;
  closeParamMenu();
  renderParamsDialog();
  modal.style.display='flex';
  modal.onclick=function(e){if(e.target===modal)closeParamsDialog();};
}
function closeParamsDialog(){
  var modal=document.getElementById('params-modal');
  if(modal)modal.style.display='none';
}
function paramsDialogOpen(){
  var m=document.getElementById('params-modal');
  return !!m&&m.style.display!=='none';
}
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    if(paramMenuEl)closeParamMenu();
    else if(paramsDialogOpen())closeParamsDialog();
  }
});

function addParam(){
  if(!Array.isArray(S.params))S.params=[];
  S.params.push(newParamDef());
  paramsChanged();
  renderParamsDialog();
  var rows=document.querySelectorAll('#params-body .param-name');
  if(rows.length){var last=rows[rows.length-1];last.focus();last.select();}
}
function removeParam(i){
  S.params.splice(i,1);
  paramsChanged();
  renderParamsDialog();
}

// One-line summary under a swept parameter: how many values, from where to where.
function paramStepSummary(p){
  var sv=paramStepValues(p);
  if(!sv.ok)return {ok:false,text:sv.error.replace(/^Parameter "[^"]*": /,'')};
  var v=sv.values,n=v.length;
  var f=(typeof fmtSpiceEng==='function')?function(x){return fmtSpiceEng(x,4)||'0';}:paramNumStr;
  var text=n+' value'+(n===1?'':'s')+': '+(n<=6?v.map(f).join(', '):v.slice(0,3).map(f).join(', ')+' … '+f(v[n-1]));
  return {ok:true,text:text};
}

function renderParamsDialog(){
  var host=document.getElementById('params-body');
  if(!host)return;
  var defs=paramDefs();
  var html='';
  if(!defs.length){
    html+='<div class="params-empty">No parameters yet. A parameter is a named value you can use in any value field as <code>{name}</code>. '+
      'Tick <b>Sweep</b> to simulate once per value and compare the results as a family of curves.</div>';
  }
  defs.forEach(function(p,i){
    var st=p.step||(p.step={on:false,type:'lin'});
    var nm=String(p.name||'').trim();
    var nameBad=!nm||!PARAM_NAME_RE.test(nm)||defs.some(function(q,j){return j!==i&&String(q.name||'').trim().toLowerCase()===nm.toLowerCase();});
    html+='<div class="param-row" data-pi="'+i+'">'+
      '<div class="param-main">'+
        '<input class="prop-input param-name'+(nameBad?' param-bad':'')+'" data-pf="name" type="text" value="'+esc(String(p.name||''))+'" placeholder="name" spellcheck="false" title="Letters, digits and underscore; no leading digit">'+
        '<span class="param-eq">=</span>'+
        '<input class="prop-input param-value" data-pf="value" type="text" value="'+esc(String(p.value||''))+'" placeholder="'+(st.on?'swept':'value, e.g. 4.7k')+'" spellcheck="false"'+(st.on?' disabled':'')+'>'+
        '<label class="param-sweep-lbl"><input type="checkbox" data-pf="step.on"'+(st.on?' checked':'')+'> Sweep</label>'+
        '<button class="param-del" title="Remove this parameter" onclick="removeParam('+i+')">&times;</button>'+
      '</div>';
    if(st.on){
      html+='<div class="param-step">'+
        '<select class="sim-select param-type" data-pf="step.type">'+PARAM_STEP_TYPES.map(function(t){
          return '<option value="'+t.v+'"'+(st.type===t.v?' selected':'')+'>'+t.l+'</option>';}).join('')+'</select>';
      function sf(key,label,val,ph){
        return '<label class="param-sf"><span>'+label+'</span><input class="prop-input" data-pf="step.'+key+'" type="text" value="'+esc(String(val||''))+'" placeholder="'+ph+'" spellcheck="false"></label>';
      }
      if(st.type==='list'){
        html+='<label class="param-sf param-sf-wide"><span>Values</span><input class="prop-input" data-pf="step.list" type="text" value="'+esc(String(st.list||''))+'" placeholder="100 220 470 1k" spellcheck="false"></label>';
      }else{
        html+=sf('start','Start',st.start,'100')+sf('stop','Stop',st.stop,'1k');
        html+=(st.type==='lin')?sf('inc','Step',st.inc,'100'):sf('pts','Points / '+(st.type==='dec'?'decade':'octave'),st.pts,'3');
      }
      var sum=paramStepSummary(p);
      html+='<div class="param-sum'+(sum.ok?'':' param-sum-bad')+'">'+esc(sum.text)+'</div></div>';
    }
    html+='</div>';
  });
  // PARAM components of the sheet, for orientation
  var comps=S.components.filter(function(c){return c.type==='param'&&String(c.label||'').trim();});
  if(comps.length){
    html+='<div class="params-note">Also available from PARAM components on the sheet: '+
      comps.map(function(c){return '<code>'+esc(String(c.label).trim())+'</code>';}).join(', ')+
      '. A parameter of the same name in this dialog takes precedence.</div>';
  }
  host.innerHTML=html;
  host.querySelectorAll('[data-pf]').forEach(function(inp){
    var row=inp.closest('.param-row');
    var pi=parseInt(row.getAttribute('data-pi'),10);
    var path=inp.getAttribute('data-pf');
    var isChoice=(inp.tagName==='SELECT'||inp.type==='checkbox');
    inp.addEventListener(isChoice?'change':'input',function(){
      var p=S.params[pi];if(!p)return;
      var val=inp.type==='checkbox'?inp.checked:inp.value;
      if(path.indexOf('step.')===0){
        if(!p.step)p.step={on:false,type:'lin'};
        p.step[path.slice(5)]=val;
      }else p[path]=val;
      paramsChanged();
      // structural switches rebuild the rows; plain typing only refreshes the summary
      if(path==='step.on'||path==='step.type'){renderParamsDialog();return;}
      if(path==='name')renderParamNameStates();
      var sumEl=row.querySelector('.param-sum');
      if(sumEl){var s=paramStepSummary(p);sumEl.textContent=s.text;sumEl.classList.toggle('param-sum-bad',!s.ok);}
    });
  });
}

// Mark duplicate / invalid names without rebuilding the rows (that would drop
// the focus from the field being typed in).
function renderParamNameStates(){
  var defs=paramDefs();
  document.querySelectorAll('#params-body .param-row').forEach(function(row){
    var i=parseInt(row.getAttribute('data-pi'),10),p=defs[i];if(!p)return;
    var nm=String(p.name||'').trim();
    var bad=!nm||!PARAM_NAME_RE.test(nm)||defs.some(function(q,j){return j!==i&&String(q.name||'').trim().toLowerCase()===nm.toLowerCase();});
    var el=row.querySelector('.param-name');
    if(el)el.classList.toggle('param-bad',bad);
  });
}

// ═══ "INSERT PARAMETER" BUTTON (properties panel value fields) ═══
var paramMenuEl=null;
function closeParamMenu(){
  if(paramMenuEl&&paramMenuEl.parentNode)paramMenuEl.parentNode.removeChild(paramMenuEl);
  paramMenuEl=null;
  document.removeEventListener('mousedown',paramMenuOutside,true);
}
function paramMenuOutside(e){
  if(paramMenuEl&&!paramMenuEl.contains(e.target)&&!(e.target.closest&&e.target.closest('.prop-param-btn')))closeParamMenu();
}

// Insert "{name}" into a field. A selection is replaced; with just a caret the
// text is inserted there if the field already holds an expression (so
// "{a}*" + parameter works), while a plain value like "4.7k" is replaced as a
// whole — the usual intent when picking a parameter for a value field.
function insertParamInto(input,name){
  var tok='{'+name+'}';
  var v=input.value;
  var a=input.selectionStart,b=input.selectionEnd;
  var focused=document.activeElement===input&&a!=null;
  var plainValue=/^[\s\w.+\-µ]*$/.test(v);
  if(focused&&(a!==b||!plainValue)){
    input.value=v.slice(0,a)+tok+v.slice(b);
    var pos=a+tok.length;
    input.setSelectionRange(pos,pos);
  }else{
    input.value=tok;
  }
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.focus();
}

function openParamMenu(btn,input){
  var reopen=paramMenuEl&&paramMenuEl._btn===btn;
  closeParamMenu();
  if(reopen)return;
  var list=paramListAll();
  var menu=document.createElement('div');
  menu.className='param-menu';
  menu._btn=btn;
  // keep the caret in the value field while the menu is used
  menu.addEventListener('mousedown',function(e){e.preventDefault();});
  if(!list.length){
    var none=document.createElement('div');
    none.className='param-menu-empty';
    none.textContent='No parameters defined yet';
    menu.appendChild(none);
  }
  list.forEach(function(p){
    var it=document.createElement('div');
    it.className='param-menu-item';
    it.innerHTML='<span class="param-menu-name">'+esc(p.name)+'</span><span class="param-menu-val">'+
      (p.swept?'⇆ ':'')+esc(p.text)+(p.comp?' · PARAM':'')+'</span>';
    it.addEventListener('click',function(){closeParamMenu();insertParamInto(input,p.name);});
    menu.appendChild(it);
  });
  var mg=document.createElement('div');
  mg.className='param-menu-item param-menu-manage';
  mg.textContent='Manage parameters…';
  mg.addEventListener('click',function(){closeParamMenu();showParamsDialog();});
  menu.appendChild(mg);
  document.body.appendChild(menu);
  var r=btn.getBoundingClientRect();
  var left=Math.max(4,Math.min(r.right-menu.offsetWidth,window.innerWidth-menu.offsetWidth-4));
  var top=r.bottom+2;
  if(top+menu.offsetHeight>window.innerHeight-4)top=Math.max(4,r.top-menu.offsetHeight-2);
  menu.style.left=left+'px';menu.style.top=top+'px';
  paramMenuEl=menu;
  document.addEventListener('mousedown',paramMenuOutside,true);
}
