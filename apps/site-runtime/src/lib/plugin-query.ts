/**
 * The plugin-query enhancer — the ONE piece of client JS behind a theme's live,
 * filtered list (a product grid, a store finder, a job board), owned by the runtime
 * rather than shipped by a theme.
 *
 * WHY THE RUNTIME OWNS THIS. Themes render on the server and ship no JavaScript, so
 * a theme cannot fetch. It authors a filter `<form>` and a results container with a
 * row `<template>`; this script turns a submit (or, opted in, a keystroke) into a
 * GET to `/plugin-query/:capability`, which cms-api dispatches to the plugin's
 * `query` handler, and renders the returned rows into the template — once, for every
 * theme, the same contract as the slider and color-mode enhancers.
 *
 * THE CONTRACT (what a theme opts in with):
 *   - a filter `<form data-zc-query="capability">`; its `name`d inputs become the
 *     query params. Optional `data-zc-target="#sel"` points at the results container
 *     (defaults to the form's next sibling); `data-zc-auto` fetches as the visitor
 *     types (debounced); `data-zc-initial` fetches once on load.
 *   - inside the container, a `<template data-zc-query-item>` holding one row. Any
 *     element with `data-zc-field="col"` gets that row value as TEXT (never HTML —
 *     plugin data is untrusted); any `data-zc-href="col"` gets a safe href, and any
 *     `data-zc-src="col"` gets a safe src (a product photo, a store front).
 *   - any `data-zc-attr="data-x:col,data-y:col"` writes row values into that
 *     element's own `data-*` attributes — how a row's identity reaches a control
 *     that acts on it later (the Add button's `data-zc-pick-value`).
 *   - any `data-zc-value="col"` puts a row value in the element's `value` — what
 *     makes a row an `<option>` of a real `<select>` rather than a line of text.
 *   - optional `[data-zc-query-empty]` (shown when no rows) and
 *     `[data-zc-query-error]` (shown when the fetch fails).
 *
 * The row template's OWN root counts: `data-zc-field` on the `<option>` that is
 * the whole row is honoured exactly as it is on a child of a card.
 *
 * SCOPE — one choice the whole page is read through.
 *
 * A shop with two branches has one question that is not a filter of any single
 * list: WHICH SHOP. It is chosen once, in the header, and every list on the page
 * (and on the next page) is an answer for that shop — so it cannot live inside a
 * filter form, and it must survive a navigation, which is exactly what a query
 * param typed into one form cannot do.
 *
 *   - `[data-zc-scope="branch"]` — a control (typically a `<select>`) whose value
 *     is appended as `branch=…` to EVERY query form on the page except the one it
 *     sits in. That exception is the point: the form that LISTS the branches is
 *     not filtered by the branch.
 *   - the choice is kept in `localStorage` and restored on the next page, before
 *     the first fetch — so a visitor who picked a shop keeps it while they browse.
 *   - changing it re-runs every form it applies to.
 *
 * The control's options may themselves arrive from a query (a plugin owns the list
 * of branches; a theme cannot know it). So the restored value is authoritative
 * even while the `<select>` is still empty, and is written onto the control once
 * its options land. If the control then REFUSES it — the shop closed, the row is
 * gone — the stored choice is dropped and the lists re-run for what is left,
 * rather than the page filtering forever by something that no longer exists.
 *
 * It is bounded: it only ever touches elements inside a `[data-zc-query]` the theme
 * marked, writes values as text, and refuses any non-http(s), non-relative URL — a
 * row from a plugin cannot inject markup or a `javascript:` link.
 *
 * `data-zc-attr` is fenced the same way, by NAME rather than by value: only an
 * attribute beginning `data-` is ever written. A row column can therefore become
 * `data-zc-pick-value` (which is the point — a basket needs to know WHICH drink
 * was added) and can never become `onclick`, `href`, `src` or `style`.
 *
 * `src` goes through the SAME filter as `href` rather than a looser one, because
 * the dangerous shapes are the same: `javascript:` is inert in an `<img src>` but
 * not in every element that takes one, and a protocol-relative "//evil/x.png"
 * silently leaves the site's origin either way. A row whose column is empty has
 * the attribute REMOVED, so a themed `img:not([src])` rule can hide the slot
 * instead of the browser drawing a broken-image glyph — the same contract
 * `data-zc-href` already has for a link with no destination.
 */
export function queryScript(): string {
  // Static, no interpolation — safe to inline verbatim under the CSP nonce.
  return `(function(){
  var SCOPE="zc-scope:";
  /* The page's current answer to "which one" — the truth the controls reflect. */
  var scope={};
  function controls(){return document.querySelectorAll("[data-zc-scope]");}
  function stored(name){try{return window.localStorage.getItem(SCOPE+name);}catch(e){return null;}}
  function store(name,value){
    try{if(value)window.localStorage.setItem(SCOPE+name,value);else window.localStorage.removeItem(SCOPE+name);}catch(e){}
  }
  /* The row template's root is part of the row, not just its children. */
  function within(node,sel){
    var out=node.matches&&node.matches(sel)?[node]:[];
    var list=node.querySelectorAll(sel);
    for(var i=0;i<list.length;i++)out.push(list[i]);
    return out;
  }
  function collect(form){
    var params=new URLSearchParams();
    var els=form.querySelectorAll("input[name],select[name],textarea[name]");
    for(var i=0;i<els.length;i++){
      var el=els[i],name=el.getAttribute("name");
      if(!name)continue;
      if((el.type==="checkbox"||el.type==="radio")&&!el.checked)continue;
      if(el.value!=null&&el.value!=="")params.append(name,el.value);
    }
    /* Every scope chosen OUTSIDE this form applies to it. A form's own scope
       control is what fills that control — filtering it by itself is circular. */
    var scoped=controls();
    for(var s=0;s<scoped.length;s++){
      var key=scoped[s].getAttribute("data-zc-scope");
      if(!key||form.contains(scoped[s])||params.has(key))continue;
      if(scope[key])params.append(key,scope[key]);
    }
    return params.toString();
  }
  function safeHref(u){
    if(typeof u!=="string"||!u)return null;
    if(/^\\s*[a-z][a-z0-9+.-]*:/i.test(u))return /^\\s*https?:\\/\\//i.test(u)?u:null;
    if(/^\\s*\\/\\//.test(u))return null;
    return u;
  }
  function fmt(v){
    if(typeof v==="number"&&isFinite(v)){
      try{return new Intl.NumberFormat(document.documentElement.lang||undefined).format(v);}catch(e){return ""+v;}
    }
    return v==null?"":""+v;
  }
  function render(container,tpl,items){
    var old=container.querySelectorAll("[data-zc-query-row]");
    for(var i=0;i<old.length;i++)old[i].remove();
    var empty=container.querySelector("[data-zc-query-empty]");
    if(empty)empty.hidden=items.length>0;
    var frag=document.createDocumentFragment();
    for(var i=0;i<items.length;i++){
      var item=items[i]||{},base=tpl.content&&tpl.content.firstElementChild;
      if(!base)break;
      var node=base.cloneNode(true);
      node.setAttribute("data-zc-query-row","");
      var fields=within(node,"[data-zc-field]");
      for(var j=0;j<fields.length;j++){
        fields[j].textContent=fmt(item[fields[j].getAttribute("data-zc-field")]);
      }
      var links=within(node,"[data-zc-href]");
      for(var k=0;k<links.length;k++){
        var href=safeHref(item[links[k].getAttribute("data-zc-href")]);
        if(href)links[k].setAttribute("href",href);else links[k].removeAttribute("href");
      }
      var media=within(node,"[data-zc-src]");
      for(var m=0;m<media.length;m++){
        var src=safeHref(item[media[m].getAttribute("data-zc-src")]);
        if(src)media[m].setAttribute("src",src);else media[m].removeAttribute("src");
      }
      /* Raw, like data-zc-attr and for the same reason: this is a value a later
         request is filtered by, not a number anybody reads. */
      var picked=within(node,"[data-zc-value]");
      for(var q=0;q<picked.length;q++){
        var raw=item[picked[q].getAttribute("data-zc-value")];
        var out=raw==null?"":""+raw;
        picked[q].setAttribute("value",out);
        picked[q].value=out;
      }
      var carriers=within(node,"[data-zc-attr]");
      for(var c=0;c<carriers.length;c++){
        var pairs=(carriers[c].getAttribute("data-zc-attr")||"").split(",");
        for(var p=0;p<pairs.length;p++){
          var at=pairs[p].indexOf(":");
          if(at<1)continue;
          var attr=pairs[p].slice(0,at).trim().toLowerCase(),col=pairs[p].slice(at+1).trim();
          /* Only a data-* attribute, never a handler or a URL one. */
          if(!/^data-[a-z0-9-]+$/.test(attr)||!col)continue;
          var val=item[col];
          /* Raw, not fmt(): this is an identity a later click compares, and a
             thousands separator would make "1500" stop matching itself. */
          if(val==null||val==="")carriers[c].removeAttribute(attr);
          else carriers[c].setAttribute(attr,""+val);
        }
      }
      frag.appendChild(node);
    }
    tpl.parentNode.appendChild(frag);
  }
  /* Puts the page's choice back on a control. \`heal\` is for a control whose
     options have just arrived: if it will not take the value, the value is gone. */
  function reflect(el,heal){
    var key=el.getAttribute("data-zc-scope");
    if(!key)return false;
    var want=scope[key]||"";
    if(el.value===want)return false;
    el.value=want;
    if(el.value===want||!heal)return false;
    scope[key]=el.value||"";
    store(key,scope[key]);
    return true;
  }
  function rerun(el){
    var forms=document.querySelectorAll("form[data-zc-query]");
    for(var i=0;i<forms.length;i++)if(!forms[i].contains(el))run(forms[i]);
  }
  function run(form){
    var cap=form.getAttribute("data-zc-query");
    var sel=form.getAttribute("data-zc-target");
    var container=sel?document.querySelector(sel):form.nextElementSibling;
    if(!cap||!container)return;
    var tpl=container.querySelector("template[data-zc-query-item]");
    if(!tpl)return;
    var errEl=container.querySelector("[data-zc-query-error]");
    form.setAttribute("aria-busy","true");
    fetch("/plugin-query/"+encodeURIComponent(cap)+"?"+collect(form),{headers:{accept:"application/json"}})
      .then(function(r){return r.ok?r.json():{items:[]};})
      .then(function(d){
        if(errEl)errEl.hidden=true;
        render(container,tpl,(d&&d.items)||[]);
        /* The rows may BE the choices — a branch picker filled by its own query. */
        var scoped=within(container,"[data-zc-scope]");
        for(var i=0;i<scoped.length;i++)if(reflect(scoped[i],true))rerun(scoped[i]);
      })
      .catch(function(){if(errEl)errEl.hidden=false;})
      .then(function(){form.removeAttribute("aria-busy");});
  }
  function boot(){
    /* Before any fetch: a list must go out asking for the shop already chosen. */
    var scoped=controls();
    for(var s=0;s<scoped.length;s++){(function(el){
      var key=el.getAttribute("data-zc-scope");
      if(!key)return;
      var saved=stored(key);
      scope[key]=saved!=null?saved:(el.value||"");
      /* No healing yet: a control whose options arrive with the first fetch has
         nothing to take the value, and dropping the visitor's choice because a
         <select> is still empty is the failure this restore exists to prevent. */
      reflect(el,false);
      el.addEventListener("change",function(){
        scope[key]=el.value||"";
        store(key,scope[key]);
        rerun(el);
      });
    })(scoped[s]);}
    var forms=document.querySelectorAll("form[data-zc-query]");
    for(var i=0;i<forms.length;i++){(function(form){
      form.addEventListener("submit",function(e){e.preventDefault();run(form);});
      if(form.hasAttribute("data-zc-auto")){
        var t=null;
        form.addEventListener("input",function(){if(t)clearTimeout(t);t=setTimeout(function(){run(form);},300);});
        form.addEventListener("change",function(){run(form);});
      }
      if(form.hasAttribute("data-zc-initial"))run(form);
    })(forms[i]);}
  }
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot);}
  else{boot();}
})();`;
}
