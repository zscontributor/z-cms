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
   * Someone edited one of THIS plugin's own rows through the generated admin
   * screens — created, updated or deleted.
   *
   * The one action that is not broadcast. Every other action here describes
   * something that happened to the CMS and is fired at every active plugin; this
   * one carries a plugin's own row, so it is delivered to that plugin and to
   * nobody else. A shop's cost prices are not an event another plugin subscribes to.
   *
   * It exists because `manifest.admin` is a *generic* CRUD screen: core writes the
   * row the form posted and knows nothing about what the row MEANS. Without this,
   * a plugin whose data has consequences — a stock movement that should change a
   * balance, an order line that should change a total — would be correct only when
   * the row came in through its own code, and quietly wrong the moment a human
   * typed it at the counter. The plugin is the authority on its own tables; this is
   * how it hears about a write it did not make.
   *
   * Deliberately NOT fired for the plugin's own `ctx.db` writes. A plugin that
   * inserted a row already knows; re-entering its own handler for its own write is
   * how a stock deduction gets applied twice.
   *
   * It is an action, so the admin does not wait for it and a broken handler cannot
   * fail somebody's save. The consequence is honest and worth stating: the row is
   * saved first and the plugin reacts a moment later.
   */
  "admin.record.changed": {
    siteId: string;
    /** The `key` of the resource in `manifest.admin.resources`. */
    resource: string;
    /** The table it backs onto — the plugin's own, always. */
    table: string;
    operation: "created" | "updated" | "deleted";
    rowId: string;
    /** The row as it now stands. Null for a delete. */
    row: Record<string, unknown> | null;
    /**
     * The row as it stood before. Null for a create.
     *
     * Present because a plugin cannot reverse what it cannot see: correcting a
     * goods-in movement from 10 to 6 is "give back 10, take 6", and a handler
     * holding only the new value would have to guess the old one.
     */
    previous: Record<string, unknown> | null;
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
