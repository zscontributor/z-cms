/**
 * The slider enhancer — the ONE piece of client JS behind every drawn theme's
 * slider, owned by the runtime rather than shipped by a theme.
 *
 * WHY THE RUNTIME OWNS THIS. Themes render on the server and ship no JavaScript, so
 * a slider is authored as a scroll-snap strip: it already swipes, keyboard-scrolls,
 * and its arrow/dot ANCHORS scroll to a slide id with scripting off. What CSS alone
 * cannot do is autoplay, keep the active dot in sync, pause on hover, or move the
 * arrows relative to the CURRENT slide. This script adds exactly that, once, for
 * every theme — the same contract as reveal-on-target and color-mode.
 *
 * THE CONTRACT (what a widget opts in with):
 *   - a container marked `data-zw-slider`, optionally `data-autoplay` +
 *     `data-interval="ms"`;
 *   - a `.zw-slider-track` scroller whose children are the slides;
 *   - arrow/dot controls marked `data-zw-slider-nav` (`.zw-slider-prev` /
 *     `.zw-slider-next` for arrows, `.zw-slider-dot` for dots).
 *
 * It is bounded: it only ever touches elements inside a `[data-zw-slider]` the theme
 * itself marked, and it never changes the URL — a crafted hash cannot drive it.
 * Respects prefers-reduced-motion (no autoplay, no smooth scroll).
 */
export const ZW_SLIDER_ATTR = "data-zw-slider";

export function sliderScript(): string {
  // Static, no interpolation — safe to inline verbatim under the CSP nonce.
  return `(function(){
  function init(root){
    var track=root.querySelector(".zw-slider-track");
    if(!track)return;
    var slides=Array.prototype.slice.call(track.children);
    if(slides.length<2)return;
    var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var dots=Array.prototype.slice.call(root.querySelectorAll(".zw-slider-dot"));
    function currentIndex(){
      var best=0,bestDist=Infinity;
      for(var i=0;i<slides.length;i++){
        var d=Math.abs(slides[i].offsetLeft-track.scrollLeft);
        if(d<bestDist){bestDist=d;best=i;}
      }
      return best;
    }
    function go(i){
      var idx=((i%slides.length)+slides.length)%slides.length;
      track.scrollTo({left:slides[idx].offsetLeft,behavior:reduce?"auto":"smooth"});
    }
    function syncDots(){
      var idx=currentIndex();
      for(var i=0;i<dots.length;i++){
        var on=i===idx;
        dots[i].classList.toggle("is-active",on);
        if(on){dots[i].setAttribute("aria-current","true");}else{dots[i].removeAttribute("aria-current");}
      }
    }
    root.addEventListener("click",function(e){
      var a=e.target&&e.target.closest?e.target.closest("[data-zw-slider-nav]"):null;
      if(!a||!root.contains(a))return;
      e.preventDefault();
      if(a.classList.contains("zw-slider-prev")){go(currentIndex()-1);}
      else if(a.classList.contains("zw-slider-next")){go(currentIndex()+1);}
      else{var idx=dots.indexOf(a);if(idx>=0){go(idx);}}
    });
    var st;
    track.addEventListener("scroll",function(){
      if(st)return;
      st=setTimeout(function(){st=null;syncDots();},120);
    });
    syncDots();
    if(root.hasAttribute("data-autoplay")&&!reduce){
      var interval=parseInt(root.getAttribute("data-interval"),10);
      if(!isFinite(interval))interval=5000;
      interval=Math.max(2000,Math.min(15000,interval));
      var timer=null,paused=false;
      function tick(){if(!paused){go(currentIndex()+1);}}
      timer=setInterval(tick,interval);
      root.addEventListener("pointerenter",function(){paused=true;});
      root.addEventListener("pointerleave",function(){paused=false;});
      root.addEventListener("focusin",function(){paused=true;});
      root.addEventListener("focusout",function(){paused=false;});
      document.addEventListener("visibilitychange",function(){paused=document.hidden;});
    }
  }
  function boot(){
    var roots=document.querySelectorAll("[data-zw-slider]");
    for(var i=0;i<roots.length;i++){init(roots[i]);}
  }
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot);}
  else{boot();}
})();`;
}
