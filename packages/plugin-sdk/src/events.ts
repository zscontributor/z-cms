/**
 * The typed event vocabulary: the familiar actions-and-filters shape, but with a
 * compile-time contract instead of a string and a prayer.
 *
 * Two kinds, and the distinction is a performance decision as much as a design
 * one:
 *
 *   ACTIONS  — fired after something happened. Dispatched asynchronously; the
 *              CMS does not wait for the plugin. A slow plugin cannot slow down
 *              a publish.
 *
 *   FILTERS  — transform a value in-flight. These DO block the caller, so they
 *              are only allowed where a wrong-but-fast answer is unacceptable
 *              (page metadata, for instance) and are hard-capped by a timeout in
 *              the runtime. A filter that times out is skipped, not fatal.
 *
 * A public page render must never fan out into a synchronous HTTP call per
 * plugin — that is exactly how a plugin marketplace turns into an outage.
 */

export interface PluginActions {
  "content.created": {
    siteId: string;
    contentId: string;
    contentType: string;
    title: string;
  };
  "content.updated": {
    siteId: string;
    contentId: string;
    contentType: string;
    title: string;
  };
  "content.published": {
    siteId: string;
    contentId: string;
    contentType: string;
    title: string;
    path: string;
    publishedAt: string;
  };
  "content.unpublished": {
    siteId: string;
    contentId: string;
    contentType: string;
  };
  "content.deleted": {
    siteId: string;
    contentId: string;
  };
  "theme.activated": {
    siteId: string;
    themeKey: string;
  };
  "plugin.activated": {
    siteId: string;
    pluginId: string;
  };
  /**
   * An email left the building. Fired for EVERY send on the site — the plugin's
   * own, another plugin's, and the CMS's — because the plugins that care about
   * this are the ones logging deliverability, and a log with only its own mail in
   * it answers nothing.
   *
   * Carries no body: `mail.sent` is a receipt, not a copy. A plugin holding
   * `mail:send` is not thereby entitled to read what every other plugin wrote.
   */
  "mail.sent": {
    siteId: string;
    /** Set when a plugin asked for this mail. Null for the CMS's own. */
    pluginKey: string | null;
    to: string[];
    subject: string;
    /** The SMTP server's accept id, when it gave one. */
    messageId: string | null;
    sentAt: string;
  };
  /** Delivery failed after the queue exhausted its retries. Same receipt, plus why. */
  "mail.failed": {
    siteId: string;
    pluginKey: string | null;
    to: string[];
    subject: string;
    error: string;
    failedAt: string;
  };
}

export type ActionName = keyof PluginActions;

export interface PluginFilters {
  /** SEO/meta of a page, just before the theme renders it. */
  "content.seo": {
    value: {
      title?: string;
      description?: string;
      ogImage?: string;
      noindex?: boolean;
      canonical?: string;
    };
    context: {
      siteId: string;
      contentId: string;
      path: string;
      title: string;
    };
  };

  /**
   * An outgoing email, immediately before it is handed to the SMTP server.
   *
   * The hook a mail plugin actually wants: append an unsubscribe footer, wrap the
   * html in the site's template, tag the subject, drop the message entirely. It
   * runs on every send on the site, whoever asked for it.
   *
   * Filters are blocking and capped by the runtime's timeout, but this one runs
   * on the worker's delivery path rather than a page render — the cost of a slow
   * plugin here is a late email, not a slow site.
   *
   * A returned `send: false` cancels delivery. That is real power (a plugin can
   * silently swallow the CMS's own mail), which is why the value passed to the
   * filter carries no `to` field it could rewrite: a plugin may edit the letter
   * and refuse to post it, but it may not readdress it to somewhere else.
   */
  "mail.sending": {
    value: {
      subject: string;
      text?: string;
      html?: string;
      replyTo?: string;
      /** Set false to cancel this delivery. Recorded, not silent. */
      send: boolean;
    };
    context: {
      siteId: string;
      /** Who asked for the mail. Null for the CMS's own. */
      pluginKey: string | null;
      to: string[];
    };
  };
}

export type FilterName = keyof PluginFilters;
