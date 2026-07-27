import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { getSystemDb } from "@zcmsorg/database";
import { FORM_ID_RE, buildFormSchema } from "@zcmsorg/schemas";
import { t } from "../common/i18n";
import { PluginsService } from "../plugins/plugins.service";

/**
 * The generic public-form endpoint's brain.
 *
 * A plugin declares a form (`manifest.forms`) and a handler (`calls["forms.submit"]`);
 * this turns a visitor's POST into a validated, dispatched submission. It is the
 * counterpart of the contact feature made general: the recipient/handler is NOT in
 * the request — the site, the form definition, and which plugin owns it are all
 * resolved on this side, from installed manifests, exactly as the plugin gateway
 * resolves a plugin's tables. The visitor only supplies field values, validated
 * against the SAME schema (`buildFormSchema`) the runtime validates client-side.
 */
@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);

  constructor(private readonly plugins: PluginsService) {}

  async submit(
    hostname: string,
    formId: string,
    rawValues: unknown,
  ): Promise<{ ok: boolean }> {
    if (!hostname) throw new BadRequestException(t()("errors.forms.hostnameRequired"));
    if (!FORM_ID_RE.test(formId)) throw new NotFoundException(t()("errors.forms.notFound"));

    const domain = await getSystemDb().domain.findUnique({
      where: { hostname: hostname.toLowerCase() },
      include: { site: true },
    });
    if (!domain || domain.site.status !== "PUBLISHED") {
      throw new NotFoundException(t()("errors.forms.siteNotFound"));
    }
    const site = domain.site;

    // Which plugin declared this form, and its field list — read from the installed
    // manifest, never from the request. Absent => the form isn't offered here.
    const found = await this.plugins.findForm(site.tenantId, site.id, formId);
    if (!found) throw new NotFoundException(t()("errors.forms.notFound"));

    const parsed = buildFormSchema(found.form.fields).safeParse(rawValues);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
        .join("; ");
      throw new BadRequestException(t()("errors.forms.invalidSubmission", { detail }));
    }

    // Hand the validated values to the plugin's own handler, in the sandbox, under
    // its scoped token. What it does with them — store, email, forward — is the
    // plugin's business and its declared scopes'. A handler that returns
    // `{ ok: false }` is a handled rejection (e.g. "already subscribed"), reported
    // to the visitor as a normal error; a thrown handler is a 502 (it broke).
    const result = (await this.plugins.callPlugin(
      site.tenantId,
      site.id,
      found.pluginKey,
      "forms.submit",
      { formId, values: parsed.data },
    )) as { ok?: boolean } | null | undefined;

    return { ok: !result || result.ok !== false };
  }
}
