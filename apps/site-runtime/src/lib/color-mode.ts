import {
  COLOR_MODE_ATTRIBUTE,
  COLOR_MODE_ICON_ATTRIBUTE,
  COLOR_MODE_STORAGE_KEY,
  COLOR_MODE_TOGGLE_ATTRIBUTE,
  type ColorModeContext,
} from "@zcmsorg/theme-sdk";

/**
 * Dark/light mode — the RUNTIME's half of the contract.
 *
 * The theme's half is in @zcmsorg/theme-sdk: a manifest that declares which modes
 * it can draw, and a `<ColorModeToggle>` that renders a plain button. Everything
 * that button needs in order to *work* is here, and it is here because none of it
 * can be anywhere else:
 *
 *   - a theme is a pure server component and ships no client bundle, so it cannot
 *     attach a handler;
 *   - the preference belongs to the visitor and must outlive the page, so it needs
 *     storage;
 *   - and it must be applied before first paint, or a reader on a dark site gets a
 *     white flash on every navigation. That means an inline script in <head>, and
 *     <head> belongs to the runtime.
 *
 * Event delegation on `document` is what keeps the two halves independent: the
 * runtime never holds a reference to a button, so it does not care that the button
 * was rendered by a theme it has never seen, nor how many of them there are, nor
 * where on the page the theme decided to put them.
 *
 * The script is inline, which costs it Next's automatic nonce — so the layout passes
 * the request's nonce explicitly. Without it the CSP (`script-src 'self' 'nonce-…'
 * 'strict-dynamic'`) refuses to run it, which is exactly what should happen to an
 * inline script nobody vouched for.
 */

export { COLOR_MODE_ATTRIBUTE, COLOR_MODE_STORAGE_KEY, COLOR_MODE_TOGGLE_ATTRIBUTE };

/**
 * The stylesheet for the toggle's icons.
 *
 * Global, and deliberately so: it is keyed off the SDK's own attributes rather than
 * any theme's class names, so every theme's toggle swaps its icon correctly without
 * writing a line of CSS for it — including a theme written a year from now by
 * somebody who never read this file.
 *
 * Both icons are in the markup and CSS picks one, because picking in JavaScript
 * would mean the theme shipping JavaScript, and picking on the server would mean
 * picking before the visitor's mode is known.
 */
export const colorModeIconCss = `
[${COLOR_MODE_ICON_ATTRIBUTE}="dark"] { display: none; }
html[${COLOR_MODE_ATTRIBUTE}="dark"] [${COLOR_MODE_ICON_ATTRIBUTE}="dark"] { display: revert; }
html[${COLOR_MODE_ATTRIBUTE}="dark"] [${COLOR_MODE_ICON_ATTRIBUTE}="light"] { display: none; }
`;

/**
 * The bootstrap script, built for the active theme.
 *
 * `config` is the theme's own declaration, already resolved (see the SDK's
 * `resolveColorModes`). Two things follow from it:
 *
 *   - A SINGLE-MODE theme is FORCED. Aurora is drawn only in the dark; a visitor
 *     whose OS prefers light, or who once chose light on some other Z-CMS site,
 *     must not be handed a half-painted page. The stored preference is not consulted
 *     and the OS is not consulted — there is one mode, and it is applied.
 *
 *   - A DUAL-MODE theme starts from the visitor's stored choice, then the theme's
 *     declared default, then (for "system") the OS.
 *
 * Minified by hand rather than by a bundler, because it is a string in the HTML and
 * never reaches one. Every part of it is wrapped in try/catch: `localStorage` throws
 * outright in a Safari private window and inside a sandboxed iframe, and a site that
 * failed to render because it could not remember a colour preference would have its
 * priorities backwards. It degrades to "the theme's default, and the toggle does
 * nothing" — which is also what a visitor with JavaScript disabled gets, and for
 * them the theme's own `prefers-color-scheme` rule still honours the OS.
 */
export function colorModeScript(config: ColorModeContext): string {
  const forced = config.toggleable ? null : (config.modes[0] ?? "light");

  const source = `(function(){
var K=${JSON.stringify(COLOR_MODE_STORAGE_KEY)},A=${JSON.stringify(COLOR_MODE_ATTRIBUTE)},R=document.documentElement;
var FORCED=${JSON.stringify(forced)},DEF=${JSON.stringify(config.default)};
function apply(m){R.setAttribute(A,m);R.style.colorScheme=m;sync(m)}
function sync(m){try{var b=document.querySelectorAll("["+${JSON.stringify(COLOR_MODE_TOGGLE_ATTRIBUTE)}+"]");for(var i=0;i<b.length;i++){b[i].setAttribute("aria-pressed",String(m==="dark"))}}catch(e){}}
function read(){if(FORCED)return null;try{var v=localStorage.getItem(K);return v==="dark"||v==="light"?v:null}catch(e){return null}}
function os(){try{return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){return "light"}}
function start(){if(FORCED)return FORCED;var s=read();if(s)return s;return DEF==="system"?os():DEF}
apply(start());
document.addEventListener("DOMContentLoaded",function(){sync(R.getAttribute(A)||"light")});
document.addEventListener("click",function(e){
if(FORCED)return;
var t=e.target;if(!t||!t.closest)return;
var btn=t.closest("["+${JSON.stringify(COLOR_MODE_TOGGLE_ATTRIBUTE)}+"]");if(!btn)return;
/* One toggle per click, even if this script somehow ran twice: a second copy of the
   listener would toggle straight back, and the button would look dead. */
if(e.zcmsColorModeHandled)return;e.zcmsColorModeHandled=true;
e.preventDefault();
var next=R.getAttribute(A)==="dark"?"light":"dark";
apply(next);
try{localStorage.setItem(K,next)}catch(_){}
});
/* Follow the OS, but only while the visitor has expressed no preference of their own. */
try{window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(ev){
if(!FORCED&&!read()&&DEF==="system")apply(ev.matches?"dark":"light")})}catch(_){}
})();`;

  return source.replace(/\n/g, "").replace(/\s{2,}/g, " ");
}
