/**
 * The admin-side twin of site-runtime's `sliderScript` (apps/site-runtime/src/lib/
 * slider.ts). The runtime script only runs on the live site, so inside the editor's
 * Preview overlay a slider's arrows are just static anchors — "next" always points at
 * slide 1, never at the slide AFTER the current one. This wires the same behaviour
 * over a DOM subtree so Preview actually advances: arrows relative to the current
 * slide, dot sync, and autoplay honouring the same data attributes.
 *
 * It mirrors slider.ts deliberately — same class names, same `data-*` — so the two
 * cannot drift in what they expect from the widget markup. Returns a cleanup that
 * removes every listener and timer it added.
 */
export function enhanceSliders(root: HTMLElement): () => void {
  const cleanups: Array<() => void> = [];
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  root.querySelectorAll<HTMLElement>("[data-zw-slider]").forEach((slider) => {
    const track = slider.querySelector<HTMLElement>(".zw-slider-track");
    if (!track) return;
    const slides = Array.from(track.children) as HTMLElement[];
    if (slides.length < 2) return;
    const dots = Array.from(slider.querySelectorAll<HTMLElement>(".zw-slider-dot"));

    const currentIndex = () => {
      let best = 0;
      let bestDist = Infinity;
      slides.forEach((slide, i) => {
        const dist = Math.abs(slide.offsetLeft - track.scrollLeft);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    };

    const go = (i: number) => {
      const idx = ((i % slides.length) + slides.length) % slides.length;
      track.scrollTo({ left: slides[idx]!.offsetLeft, behavior: reduce ? "auto" : "smooth" });
    };

    const syncDots = () => {
      const idx = currentIndex();
      dots.forEach((dot, i) => {
        const on = i === idx;
        dot.classList.toggle("is-active", on);
        if (on) dot.setAttribute("aria-current", "true");
        else dot.removeAttribute("aria-current");
      });
    };

    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("[data-zw-slider-nav]") as HTMLElement | null;
      if (!anchor || !slider.contains(anchor)) return;
      event.preventDefault();
      if (anchor.classList.contains("zw-slider-prev")) go(currentIndex() - 1);
      else if (anchor.classList.contains("zw-slider-next")) go(currentIndex() + 1);
      else {
        const idx = dots.indexOf(anchor);
        if (idx >= 0) go(idx);
      }
    };
    slider.addEventListener("click", onClick);
    cleanups.push(() => slider.removeEventListener("click", onClick));

    let scrollTimer: number | undefined;
    const onScroll = () => {
      if (scrollTimer) return;
      scrollTimer = window.setTimeout(() => {
        scrollTimer = undefined;
        syncDots();
      }, 120);
    };
    track.addEventListener("scroll", onScroll);
    cleanups.push(() => track.removeEventListener("scroll", onScroll));
    syncDots();

    if (slider.hasAttribute("data-autoplay") && !reduce) {
      let interval = parseInt(slider.getAttribute("data-interval") ?? "", 10);
      if (!Number.isFinite(interval)) interval = 5000;
      interval = Math.max(2000, Math.min(15000, interval));
      let paused = false;
      const timer = window.setInterval(() => {
        if (!paused) go(currentIndex() + 1);
      }, interval);
      const enter = () => {
        paused = true;
      };
      const leave = () => {
        paused = false;
      };
      slider.addEventListener("pointerenter", enter);
      slider.addEventListener("pointerleave", leave);
      cleanups.push(() => {
        clearInterval(timer);
        slider.removeEventListener("pointerenter", enter);
        slider.removeEventListener("pointerleave", leave);
      });
    }
  });

  return () => cleanups.forEach((cleanup) => cleanup());
}
