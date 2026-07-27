import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { getSystemDb } from "@zcmsorg/database";
import { t as translatorFor } from "@zcmsorg/i18n";
import { z } from "zod";
import { t } from "../common/i18n";
import { MailService } from "../mail/mail.service";

/**
 * A visitor's enquiry from a theme's contact form.
 *
 * The recipient is deliberately NOT here. A public form on the open internet must
 * never tell the server who to mail — that is an open relay. The address is the
 * site's own `contactEmail`, read server-side from the active theme's settings,
 * and the visitor's own address rides as `replyTo` (never `from`, never `to`), so
 * the site owner can hit reply and reach them.
 */
const ContactSubmissionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  company: z.string().trim().max(200).optional(),
  email: z.email().max(320),
  need: z.string().trim().max(200).optional(),
  message: z.string().trim().min(1).max(5_000),
});

export type ContactSubmission = z.infer<typeof ContactSubmissionSchema>;

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(private readonly mail: MailService) {}

  /**
   * Turns a contact-form POST into a queued email to the site's own inbox.
   *
   * Resolution mirrors the public AI chat: the hostname (supplied by site-runtime,
   * not the browser) names a published site; everything else — tenant, recipient,
   * SMTP server — is read on this side of the boundary. `pluginKey` is null, so
   * this leaves as the CMS's own mail: no plugin quota, `from` fixed to the site's
   * configured sender, delivery retried in the background by the worker.
   */
  async submit(hostname: string, raw: unknown): Promise<void> {
    if (!hostname) throw new BadRequestException(t()("errors.contact.hostnameRequired"));

    const parsed = ContactSubmissionSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
        .join("; ");
      throw new BadRequestException(t()("errors.contact.invalidSubmission", { detail }));
    }
    const input = parsed.data;

    const domain = await getSystemDb().domain.findUnique({
      where: { hostname: hostname.toLowerCase() },
      include: { site: true },
    });
    if (!domain || domain.site.status !== "PUBLISHED") {
      throw new NotFoundException(t()("errors.contact.siteNotFound"));
    }
    const site = domain.site;

    // Where the enquiry goes, read from the active theme's own settings. Never
    // from the request — the browser does not get a say in who the site emails.
    const themeRow = await getSystemDb().siteTheme.findFirst({
      where: { siteId: site.id, status: "ACTIVE" },
      select: { settings: true },
    });
    const settings = (themeRow?.settings ?? {}) as Record<string, unknown>;
    const rawRecipient = typeof settings.contactEmail === "string" ? settings.contactEmail.trim() : "";
    const recipient = z.email().safeParse(rawRecipient);
    if (!recipient.success) {
      // The theme has no valid contact address configured. This is the operator's
      // to fix (Appearance → theme settings → Contact email), so name it rather
      // than swallow the enquiry silently.
      this.logger.warn(`Contact form on ${hostname} has no valid contactEmail configured.`);
      throw new BadRequestException(t()("errors.contact.noRecipient"));
    }

    const tt = translatorFor(site.defaultLocale);
    const lines = [
      tt("mail.contact.intro", { site: site.name }),
      "",
      `${tt("mail.contact.fields.name")}: ${input.name}`,
      input.company ? `${tt("mail.contact.fields.company")}: ${input.company}` : null,
      `${tt("mail.contact.fields.email")}: ${input.email}`,
      input.need ? `${tt("mail.contact.fields.need")}: ${input.need}` : null,
      "",
      `${tt("mail.contact.fields.message")}:`,
      input.message,
    ].filter((line): line is string => line !== null);

    // Plain text only, on purpose: the body is visitor-supplied, and text carries
    // no markup a visitor could weaponise into the owner's mail client.
    await this.mail.enqueue(site.tenantId, site.id, null, {
      to: [recipient.data],
      subject: tt("mail.contact.subject", { name: input.name }),
      text: lines.join("\n"),
      replyTo: input.email,
    });
  }
}
