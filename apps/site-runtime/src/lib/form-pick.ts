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

/** Writes the basket, repaints every badge, and tells the page it changed. */
export function writePicks(formId: string, picks: FormPick[]): void {
  try {
    window.localStorage.setItem(pickKey(formId), JSON.stringify(picks));
  } catch {
    // A browser with no storage still gets a working page; the basket just does
    // not survive the next navigation.
  }
  paintBadges(formId, picks);
  try {
    document.dispatchEvent(new CustomEvent(PICK_EVENT, { detail: { formId } }));
  } catch {
    // An environment without CustomEvent still has a correct store.
  }
}

function paintBadges(formId: string, picks: FormPick[]): void {
  const total = picks.reduce((sum, pick) => sum + pick.qty, 0);
  // Read by attribute rather than by an interpolated selector: a form id is a
  // plugin's string, and it has no business inside a CSS selector.
  document.querySelectorAll<HTMLElement>("[data-zc-pick-count]").forEach((el) => {
    if (el.getAttribute("data-zc-pick-count") !== formId) return;
    el.textContent = String(total);
    el.toggleAttribute("hidden", total === 0);
  });
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
  function paint(id,items){
    var n=total(items),els=document.querySelectorAll("[data-zc-pick-count]");
    for(var i=0;i<els.length;i++){
      if(els[i].getAttribute("data-zc-pick-count")!==id)continue;
      els[i].textContent=""+n;
      if(n===0)els[i].setAttribute("hidden","");else els[i].removeAttribute("hidden");
    }
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
  function onClick(ev){
    var t=ev.target;
    if(!t||!t.closest)return;
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
  function boot(){
    /* Every badge on the page starts from the store, so a basket filled on the
       menu page is already counted in the header of the next one. */
    var els=document.querySelectorAll("[data-zc-pick-count]");
    for(var i=0;i<els.length;i++){
      var id=els[i].getAttribute("data-zc-pick-count");
      if(id)paint(id,read(id));
    }
  }
  /* Evaluated twice, still ONE listener: a second copy of this script would
     otherwise count every press of every Add button twice. */
  if(window.__zcPick)document.removeEventListener("click",window.__zcPick);
  window.__zcPick=onClick;
  document.addEventListener("click",onClick);
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot);}
  else{boot();}
})();`;
}
