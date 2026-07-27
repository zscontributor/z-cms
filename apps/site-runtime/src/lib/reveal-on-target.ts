/**
 * A framework primitive for no-JavaScript themes: reliably reveal the element a
 * URL fragment points at, even when that fragment arrived via an HTTP redirect.
 *
 * WHY THE RUNTIME OWNS THIS. Themes ship no client JavaScript and render on the
 * server, so the only tool they have for "show a message after a form submit" is
 * the post/redirect/get pattern plus a CSS `:target` rule on the fragment the
 * redirect lands on. That works on a normal in-page fragment navigation — but NOT
 * after a redirect in Blink (Chrome/Edge): the browser scrolls to the fragment yet
 * never activates `:target`, so the element stays hidden until the URL is
 * re-entered. It is a browser bug a theme cannot work around without JS, and JS is
 * exactly what a theme does not have. So the platform fixes it once, here, for
 * every theme — rather than each theme reinventing (and failing at) it.
 *
 * THE CONTRACT (documented for theme authors in @zcmsorg/theme-sdk):
 *   - Give the element an `id` and mark it `data-reveal-on-target`.
 *   - Style both states to show it, e.g.
 *       .flash { display: none }
 *       .flash:target, .flash[data-revealed] { display: block }
 *   - Send the visitor to `…/page#that-id`. On load this script marks the matching
 *     element `data-revealed` and scrolls it into view.
 *
 * It is deliberately generic: it knows nothing about contact forms, newsletters or
 * any specific feature. Any theme or block that opts in with the attribute gets
 * reliable post-redirect reveal. And it is bounded — it only ever touches elements
 * the theme itself opted in with `data-reveal-on-target`, so a crafted `#id` can
 * never coax it into unhiding something a theme did not mark as revealable.
 */
export const REVEAL_ON_TARGET_ATTR = "data-reveal-on-target";

export function revealOnTargetScript(): string {
  // Static, no interpolation — safe to inline verbatim under the CSP nonce.
  return `(function(){
  function reveal(){
    var id=(location.hash||"").slice(1);
    if(!id)return;
    var el=document.getElementById(id);
    if(!el||!el.hasAttribute("data-reveal-on-target"))return;
    el.setAttribute("data-revealed","");
    try{el.scrollIntoView({block:"center"});}catch(e){el.scrollIntoView();}
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",reveal);
  else reveal();
  window.addEventListener("hashchange",reveal);
})();`;
}
