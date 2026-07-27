/**
 * Post-redirect "flash" reveal for no-JavaScript themes.
 *
 * Themes render on the server and ship no client JS, so the way to show a message
 * after a form submit is the post/redirect/get pattern: the form POSTs, the server
 * redirects the visitor back to `…/page#some-id`, and CSS reveals the element the
 * fragment names. Plain `:target` is enough on a direct in-page jump — but Blink
 * (Chrome/Edge) does NOT apply `:target` after an HTTP *redirect*: it scrolls to
 * the fragment yet leaves the element hidden until the URL is re-entered. A theme
 * can't fix that itself (it has no JS), so the runtime does it once for everyone:
 * on load it marks the targeted opt-in element `data-revealed` and scrolls to it.
 *
 * A theme opts a flash element in like this — no client JS, works in every browser:
 *
 * ```tsx
 * <div id="contact-sent" data-reveal-on-target role="status" className="flash flash--ok">
 *   {ctx.t("contact.sent")}
 * </div>
 * ```
 * ```css
 * .flash { display: none; scroll-margin-top: 120px; }
 * .flash:target,            // direct navigation / non-Blink
 * .flash[data-revealed] {   // set by the runtime, fires after a redirect too
 *   display: block;
 * }
 * ```
 *
 * Then redirect the visitor to `…/page#contact-sent`. Any element carrying
 * {@link REVEAL_ON_TARGET_ATTR} is handled generically — the mechanism knows
 * nothing about contact forms or any specific feature, and only ever touches
 * elements a theme explicitly opted in, so a crafted fragment cannot unhide
 * anything a theme did not mark as revealable.
 */
export const REVEAL_ON_TARGET_ATTR = "data-reveal-on-target";

/** The attribute the runtime sets on the targeted element once revealed. */
export const REVEALED_ATTR = "data-revealed";
