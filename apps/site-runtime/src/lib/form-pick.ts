/**
 * "Add to basket" for a plugin-declared form — the runtime's half of a theme's
 * Add button.
 *
 * WHY THIS EXISTS. A theme renders on the server and ships no JavaScript, so a
 * card in a live list (`plugin-query`) can do nothing but link somewhere. The
 * cafe theme's menu card said "Thêm" and was an anchor to the pre-order form: it
 * scrolled, and nothing was added. Core commerce's cart is no answer either —
 * that cart prices core catalogue products, and a shop plugin's menu is not in the
 * catalogue.
 *
 * So the basket for a form-driven shop is the FORM, and this is the piece that
 * carries a choice to it:
 *
 *   - this inline script owns the pick STORE (localStorage, per form id), the
 *     click contract and the badge, so an Add button works on any page — including
 *     a menu page where the form itself is not rendered;
 *   - `FormIsland` reads the store when it mounts (and when this script says it
 *     changed) and fills the form's own item/quantity slots, because the form is a
 *     controlled React island that a DOM script cannot poke values into.
 *
 * THE CONTRACT (what a theme opts in with):
 *   - `[data-zc-pick="<formId>"]` — the Add control. `data-zc-pick-value` is the
 *     option value to choose (normally written by the query enhancer from a row
 *     column, see `data-zc-attr`); `data-zc-pick-qty` how many (default 1);
 *     `data-zc-pick-max` how many DISTINCT entries the form can take, which the
 *     theme derives from the form definition it was handed.
 *   - `[data-zc-pick-count="<formId>"]` — a badge; gets the total quantity as
 *     text and is `hidden` while the basket is empty.
 *
 * HYDRATION — the one rule a theme must not get wrong. This is an inline
 * `<script>`: it runs while the HTML is still being parsed, long before React's
 * bundle has downloaded, so every element it writes into is one React later
 * hydrates against markup that has already changed underneath it. That is a
 * hydration failure (React #418 — the whole tree is thrown away and re-rendered on
 * the client), and it is not hypothetical: it shipped, and it fired on every page
 * of coffee.z-cms.org because an empty basket wrote "0" into a badge the server had
 * rendered empty. So EVERY element this script paints must:
 *
 *   1. be rendered by the theme WITH its number already in it (`<b …>0</b>`, never
 *      `<b …/>`) — React treats a text node appearing inside an element it rendered
 *      childless as a structural mismatch, which nothing can suppress; and
 *   2. carry `suppressHydrationWarning`, which is how React is told an element's
 *      content and attributes belong to a script rather than to the tree.
 *
 * Both, or neither works. `form-pick-hydration.test.tsx` hydrates the real markup
 * after running the real script and holds this.
 *   - `[data-zc-pick-allow="a|b|c"]` on any ancestor — the values the form will
 *     actually accept. Optional, and the theme reads them off the form definition
 *     it was handed: a live list can offer a row the form's own options do not
 *     (a drink added to the menu after the form was written), and refusing it here
 *     is the difference between "we cannot take that one online" and a basket that
 *     quietly loses a line on the next page.
 *   - the control keeps its `href`: with no JavaScript the anchor still takes the
 *     visitor to the form, exactly as before.
 *
 * Feedback is left to the theme: the clicked control gets `data-zc-picked="added"`
 * (or `"full"` when the form has no slot left) for a moment, and the theme styles
 * what that looks like.
 *
 * THE DRAWER (optional, the second half of the contract).
 *
 * Counting a basket into a badge and then sending the visitor to a form to see
 * what is in it is half a shop. Core commerce answers this with a drawer the
 * runtime renders itself (`Storefront`), but that drawer prices catalogue products
 * and a form-driven shop has none — so here the runtime renders NOTHING. The theme
 * renders the drawer, in its own markup and its own words, listing every value the
 * form accepts once; this script decides which of those lines the basket currently
 * holds, what number sits on each, and whether the drawer is open. Markup is the
 * theme's, state is the runtime's — the same split as the badge, and the reason a
 * server-rendered theme can have a live cart without shipping a line of JavaScript.
 *
 *   - `[data-zc-pick-drawer="<formId>"]` — the drawer root. Carries `data-zc-open`
 *     and loses `aria-hidden` while open; the theme decides what open looks like.
 *   - `[data-zc-pick-open="<formId>"]` — opens it. Keeps its `href`, so with no
 *     JavaScript the button still goes to the form.
 *   - `[data-zc-pick-close]` — closes the drawer it is in (scrim, ✕, or the link on
 *     to the form, which closes as it navigates).
 *   - `[data-zc-pick-line="<formId>"][data-zc-pick-value="<value>"]` — one line,
 *     rendered for every value the form takes and `hidden` unless the basket holds
 *     it. `[data-zc-pick-line-qty]` inside it gets the number.
 *   - `[data-zc-pick-step="1|-1"]` / `[data-zc-pick-drop]` inside a line — more,
 *     fewer, gone. Stepping the last one off a line removes it, because a line of
 *     zero is not a line.
 *   - `[data-zc-pick-empty="<formId>"]` / `[data-zc-pick-filled="<formId>"]` — the
 *     two halves of an empty basket, one `hidden` at a time.
 *
 * The hydration rule above applies to every one of these too.
 *
 * The drawer stays shut on a page with no JavaScript, where it is also unreachable:
 * the theme hides it in CSS, the opener is still a link, and the form is still the
 * place the basket is filled in.
 */

/** One chosen line: an option value and how many of it. */
export interface FormPick {
  value: string;
  qty: number;
}

/** Where a form's basket lives, and the event that says it moved. */
const PICK_PREFIX = "zcms.pick.";
export const PICK_EVENT = "zcms:pick";

/** A basket is small by nature — this is a guard against a doctored store. */
const MAX_QTY = 99;
const MAX_ENTRIES = 20;

function pickKey(formId: string): string {
  return PICK_PREFIX + formId;
}

/**
 * The basket as it stands, or empty.
 *
 * Everything is re-checked: the store is a string in a browser the visitor owns,
 * and a quantity of `-1` or a value of `{}` must not reach a form field.
 */
export function readPicks(formId: string): FormPick[] {
  try {
    const raw = window.localStorage.getItem(pickKey(formId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: FormPick[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const value = (entry as FormPick).value;
      if (typeof value !== "string" || !value) continue;
      const qty = Math.round(Number((entry as FormPick).qty));
      out.push({ value, qty: qty > 0 ? Math.min(MAX_QTY, qty) : 1 });
      if (out.length >= MAX_ENTRIES) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Writes the basket, repaints what shows it, and tells the page it changed. */
export function writePicks(formId: string, picks: FormPick[]): void {
  try {
    window.localStorage.setItem(pickKey(formId), JSON.stringify(picks));
  } catch {
    // A browser with no storage still gets a working page; the basket just does
    // not survive the next navigation.
  }
  paintPicks(formId, picks);
  try {
    document.dispatchEvent(new CustomEvent(PICK_EVENT, { detail: { formId } }));
  } catch {
    // An environment without CustomEvent still has a correct store.
  }
}

/**
 * The basket as the page shows it: the badge, and the theme's drawer lines.
 *
 * The island writes picks too (it prunes what the form refused, and empties the
 * basket on a successful order), so painting lives here rather than only in the
 * inline script — otherwise a submitted order would leave the drawer still
 * listing what was just bought.
 */
export function paintPicks(formId: string, picks: FormPick[]): void {
  const total = picks.reduce((sum, pick) => sum + pick.qty, 0);
  const quantities = new Map(picks.map((pick) => [pick.value, pick.qty]));

  // Read by attribute rather than by an interpolated selector: a form id is a
  // plugin's string, and it has no business inside a CSS selector.
  const forThisForm = (selector: string, attribute: string): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (el) => el.getAttribute(attribute) === formId,
    );

  forThisForm("[data-zc-pick-count]", "data-zc-pick-count").forEach((el) => {
    el.textContent = String(total);
    el.toggleAttribute("hidden", total === 0);
  });

  forThisForm("[data-zc-pick-line]", "data-zc-pick-line").forEach((line) => {
    const qty = quantities.get(line.getAttribute("data-zc-pick-value") ?? "") ?? 0;
    line.toggleAttribute("hidden", qty === 0);
    line
      .querySelectorAll<HTMLElement>("[data-zc-pick-line-qty]")
      .forEach((el) => (el.textContent = String(qty)));
  });

  forThisForm("[data-zc-pick-empty]", "data-zc-pick-empty").forEach((el) =>
    el.toggleAttribute("hidden", total > 0),
  );
  forThisForm("[data-zc-pick-filled]", "data-zc-pick-filled").forEach((el) =>
    el.toggleAttribute("hidden", total === 0),
  );
}

export function formPickScript(): string {
  // Static, no interpolation — safe to inline verbatim under the CSP nonce.
  return `(function(){
  var PREFIX=${JSON.stringify(PICK_PREFIX)},EVENT=${JSON.stringify(PICK_EVENT)};
  var MAXQ=${MAX_QTY},MAXN=${MAX_ENTRIES};
  function read(id){
    try{
      var raw=window.localStorage.getItem(PREFIX+id);
      if(!raw)return [];
      var parsed=JSON.parse(raw);
      if(!(parsed instanceof Array))return [];
      var out=[];
      for(var i=0;i<parsed.length&&out.length<MAXN;i++){
        var e=parsed[i];
        if(!e||typeof e!=="object"||typeof e.value!=="string"||!e.value)continue;
        var q=Math.round(Number(e.qty));
        out.push({value:e.value,qty:q>0?Math.min(MAXQ,q):1});
      }
      return out;
    }catch(err){return [];}
  }
  function total(items){var n=0;for(var i=0;i<items.length;i++)n+=items[i].qty;return n;}
  function mine(selector,attr,id){
    var all=document.querySelectorAll(selector),out=[];
    for(var i=0;i<all.length;i++)if(all[i].getAttribute(attr)===id)out.push(all[i]);
    return out;
  }
  function show(el,on){if(on)el.removeAttribute("hidden");else el.setAttribute("hidden","");}
  function paint(id,items){
    var n=total(items),i,j;
    var els=mine("[data-zc-pick-count]","data-zc-pick-count",id);
    for(i=0;i<els.length;i++){els[i].textContent=""+n;show(els[i],n>0);}
    /* The theme's drawer lists every value the form takes; the basket decides
       which of those lines exist right now and what number sits on each. */
    var lines=mine("[data-zc-pick-line]","data-zc-pick-line",id);
    for(i=0;i<lines.length;i++){
      var value=lines[i].getAttribute("data-zc-pick-value"),qty=0;
      for(j=0;j<items.length;j++)if(items[j].value===value)qty=items[j].qty;
      show(lines[i],qty>0);
      var qs=lines[i].querySelectorAll("[data-zc-pick-line-qty]");
      for(j=0;j<qs.length;j++)qs[j].textContent=""+qty;
    }
    var empty=mine("[data-zc-pick-empty]","data-zc-pick-empty",id);
    for(i=0;i<empty.length;i++)show(empty[i],n===0);
    var filled=mine("[data-zc-pick-filled]","data-zc-pick-filled",id);
    for(i=0;i<filled.length;i++)show(filled[i],n>0);
  }
  function write(id,items){
    try{window.localStorage.setItem(PREFIX+id,JSON.stringify(items));}catch(err){}
    paint(id,items);
    try{document.dispatchEvent(new CustomEvent(EVENT,{detail:{formId:id}}));}catch(err){}
  }
  /* A moment of "added" on the control the visitor pressed; the theme styles it. */
  function flash(el,state){
    if(el.__zcPickT)clearTimeout(el.__zcPickT);
    el.setAttribute("data-zc-picked",state);
    el.__zcPickT=setTimeout(function(){el.removeAttribute("data-zc-picked");el.__zcPickT=null;},1600);
  }
  function num(el,name){var n=Math.round(Number(el.getAttribute(name)));return n>0?n:0;}
  /* ---- the theme's drawer: the runtime opens it, the theme draws it ---- */
  function openDrawer(id){
    var drawers=mine("[data-zc-pick-drawer]","data-zc-pick-drawer",id);
    if(!drawers.length)return false;
    /* Repainted on the way open: another tab may have moved the basket since. */
    paint(id,read(id));
    for(var i=0;i<drawers.length;i++){
      drawers[i].setAttribute("data-zc-open","");
      drawers[i].removeAttribute("aria-hidden");
      var panel=drawers[i].querySelector("[data-zc-pick-panel]")||drawers[i];
      try{panel.focus();}catch(err){}
    }
    return true;
  }
  function closeDrawer(el){
    var drawers=el?[el]:document.querySelectorAll("[data-zc-pick-drawer][data-zc-open]");
    for(var i=0;i<drawers.length;i++){
      drawers[i].removeAttribute("data-zc-open");
      drawers[i].setAttribute("aria-hidden","true");
    }
  }
  /* One line, more or fewer. Stepping the last one off removes the line: a
     basket entry of zero is not an entry, and the form has a slot back. */
  function step(line,delta){
    var id=line.getAttribute("data-zc-pick-line"),value=line.getAttribute("data-zc-pick-value");
    if(!id||!value)return;
    var items=read(id),out=[];
    for(var i=0;i<items.length;i++){
      if(items[i].value!==value){out.push(items[i]);continue;}
      var qty=delta===0?0:Math.min(MAXQ,items[i].qty+delta);
      if(qty>0)out.push({value:value,qty:qty});
    }
    write(id,out);
  }
  function onClick(ev){
    var t=ev.target;
    if(!t||!t.closest)return;

    var opener=t.closest("[data-zc-pick-open]");
    if(opener){
      /* Only swallow the click if there IS a drawer to open; otherwise the
         opener stays the link to the form it is without JavaScript. */
      if(openDrawer(opener.getAttribute("data-zc-pick-open")))ev.preventDefault();
      return;
    }
    var closer=t.closest("[data-zc-pick-close]");
    if(closer){
      closeDrawer(closer.closest("[data-zc-pick-drawer]"));
      /* A link out of the drawer (on to the form) closes AND goes; a button
         that only closes must not follow an empty href. */
      if(!closer.getAttribute("href"))ev.preventDefault();
      return;
    }
    var stepper=t.closest("[data-zc-pick-step]");
    if(stepper){
      ev.preventDefault();
      var line=stepper.closest("[data-zc-pick-line]");
      if(line)step(line,Math.round(Number(stepper.getAttribute("data-zc-pick-step")))||0);
      return;
    }
    var dropper=t.closest("[data-zc-pick-drop]");
    if(dropper){
      ev.preventDefault();
      var dropLine=dropper.closest("[data-zc-pick-line]");
      if(dropLine)step(dropLine,0);
      return;
    }

    var el=t.closest("[data-zc-pick]");
    if(!el)return;
    var id=el.getAttribute("data-zc-pick"),value=el.getAttribute("data-zc-pick-value");
    /* No id or no value means the row carried none — leave the anchor alone so it
       still takes the visitor to the form rather than swallowing the click. */
    if(!id||!value)return;
    ev.preventDefault();
    var scope=el.closest("[data-zc-pick-allow]");
    if(scope&&("|"+scope.getAttribute("data-zc-pick-allow")+"|").indexOf("|"+value+"|")<0){
      flash(el,"missing");
      return;
    }
    var qty=num(el,"data-zc-pick-qty")||1,max=num(el,"data-zc-pick-max");
    var items=read(id),hit=null;
    for(var i=0;i<items.length;i++)if(items[i].value===value)hit=items[i];
    if(hit){hit.qty=Math.min(MAXQ,hit.qty+qty);}
    else if(items.length<(max||MAXN)&&items.length<MAXN){items.push({value:value,qty:Math.min(MAXQ,qty)});}
    else{flash(el,"full");return;}
    write(id,items);
    flash(el,"added");
  }
  function onKey(ev){
    if(ev.key!=="Escape"&&ev.key!=="Esc")return;
    if(!document.querySelector("[data-zc-pick-drawer][data-zc-open]"))return;
    closeDrawer(null);
  }
  function boot(){
    /* Every badge and every drawer on the page starts from the store, so a basket
       filled on the menu page is already counted in the header of the next one —
       and already listed in a drawer that has never been opened. */
    var seen={},els=document.querySelectorAll("[data-zc-pick-count],[data-zc-pick-drawer]");
    for(var i=0;i<els.length;i++){
      var id=els[i].getAttribute("data-zc-pick-count")||els[i].getAttribute("data-zc-pick-drawer");
      /* Prefixed, because a form id is free text and "constructor" is a key an
         empty object already answers to. */
      if(!id||seen["#"+id])continue;
      seen["#"+id]=1;
      paint(id,read(id));
    }
  }
  /* Evaluated twice, still ONE listener: a second copy of this script would
     otherwise count every press of every Add button twice. */
  if(window.__zcPick)document.removeEventListener("click",window.__zcPick);
  window.__zcPick=onClick;
  document.addEventListener("click",onClick);
  if(window.__zcPickKey)document.removeEventListener("keydown",window.__zcPickKey);
  window.__zcPickKey=onKey;
  document.addEventListener("keydown",onKey);
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot);}
  else{boot();}
})();`;
}
