import { definePlugin } from "@zcmsorg/plugin-sdk";

/**
 * The reference plugin-provided public form.
 *
 * It ships no browser code and no route. It DECLARES a form in `manifest.forms`
 * (fields + validation); core validates a submission against that declaration —
 * client-side and server-side, from one schema — and dispatches the values here,
 * to `calls["forms.submit"]`, in the sandbox under this plugin's own token. All
 * this handler does is decide what to do with a valid submission: store it. A
 * different plugin might email it, or POST it to a CRM with `ctx.http` — the point
 * is that none of them touch site-runtime or ship a line of client JavaScript.
 */
interface FormSubmitPayload {
  formId: string;
  values: Record<string, unknown>;
}

const STORE_KEY = "submissions";
const KEEP = 500;

export default definePlugin({
  manifest: {
    id: "vn.zsoft.plugin.feedback",
    name: "Feedback",
    version: "0.1.0",
    author: { name: "Z-SOFT Co., Ltd" },
    engine: ">=0.1.0",
    permissions: [],
    forms: [
      {
        id: "feedback",
        title: "Send feedback",
        submitLabel: "Send feedback",
        fields: [
          { name: "name", type: "text", required: true, maxLength: 120, label: "Name" },
          { name: "email", type: "email", maxLength: 320, label: "Email (optional)" },
          { name: "message", type: "textarea", required: true, minLength: 10, maxLength: 2000, label: "Message" },
        ],
      },
    ],
  },

  calls: {
    /**
     * Core calls this with a submission it has already validated against the form's
     * declared fields, so the values can be trusted to match. Returns `{ ok }`;
     * `{ ok: false }` would be a handled rejection the visitor sees as an error.
     */
    "forms.submit": async (payload, ctx) => {
      const { formId, values } = payload as unknown as FormSubmitPayload;
      if (formId !== "feedback") return { ok: false };

      const existing = (await ctx.storage.get<unknown[]>(STORE_KEY)) ?? [];
      const entry = { ...values, at: new Date().toISOString() };
      const next = [...existing, entry].slice(-KEEP);
      await ctx.storage.set(STORE_KEY, next);

      ctx.log.info(`Feedback stored (${next.length} total).`);
      return { ok: true };
    },
  },
});
