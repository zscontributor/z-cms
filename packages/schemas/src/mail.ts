import { z } from "zod";

/**
 * The mail contracts: what an admin configures, and what anyone may ask to send.
 *
 * Two schemas, and the split between them is the security boundary of the whole
 * feature. `MailSettingsSchema` is the envelope — who the mail comes FROM, which
 * server carries it — and only `settings:update` writes it. `MailMessageSchema`
 * is the letter, and anything holding `mail:send` (an admin, a plugin) may write
 * one.
 *
 * A sender therefore cannot choose its own `from`. That field is deliberately
 * absent from the message and present only in the settings: the instant a plugin
 * can set it, the site's mail server becomes an open relay for spoofing any
 * address the operator's SPF record happens to authorise. `replyTo` is the escape
 * hatch, and it is the correct one — it steers the human's reply without lying
 * about who sent the mail.
 */

const Email = z.email().max(320);

/** Addressees. A string or a list, because callers naturally write both. */
const Recipients = z
  .union([Email, z.array(Email).min(1).max(50)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

export const MailMessageSchema = z
  .object({
    to: Recipients,
    cc: Recipients.optional(),
    bcc: Recipients.optional(),
    subject: z.string().min(1).max(500),
    /**
     * At least one body, checked below. A mail with neither is not a mail — it is
     * a delivery that silently arrives blank, which is worse than a rejection.
     */
    text: z.string().max(500_000).optional(),
    html: z.string().max(500_000).optional(),
    replyTo: Email.optional().describe(
      "Where a human's reply goes. The only address the sender controls — `from` is the site's.",
    ),
  })
  .refine((message) => Boolean(message.text ?? message.html), {
    message: "A message needs a text or an html body.",
    path: ["text"],
  });

export type MailMessage = z.infer<typeof MailMessageSchema>;
/** What a caller writes, before Zod normalises `to` into an array. */
export type MailMessageInput = z.input<typeof MailMessageSchema>;

/**
 * What the admin saves. `password` is write-only and optional: omitting it keeps
 * whatever is stored, which is what lets the form round-trip without ever having
 * held the secret. Sending an empty string clears it.
 */
export const MailSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().min(1).max(255),
  port: z.int().min(1).max(65_535).default(587),
  /**
   * Implicit TLS (SMTPS, usually 465) rather than STARTTLS (usually 587).
   *
   * Off does NOT mean plaintext: the transport still issues STARTTLS when the
   * server advertises it. This flag only says whether the connection is wrapped
   * in TLS from the first byte.
   */
  secure: z.boolean().default(false),
  username: z.string().max(255).optional(),
  password: z
    .string()
    .max(500)
    .optional()
    .describe("Write-only. Omit to keep the stored one; send \"\" to clear it."),
  fromName: z.string().min(1).max(120),
  fromEmail: Email,
  replyTo: z.union([Email, z.literal("")]).optional(),
});

/** What a client may send: `port`, `secure` and `enabled` may be omitted. */
export type MailSettingsInput = z.input<typeof MailSettingsSchema>;
/** What the API works with: the same thing, after Zod has applied the defaults. */
export type MailSettings = z.output<typeof MailSettingsSchema>;

/**
 * What the API gives back. The password is not here, in any form — not masked,
 * not truncated, not as a length. `hasPassword` is the entire answer to the only
 * question the form actually needs to ask, which is whether the field should say
 * "leave blank to keep the current one".
 */
export interface MailSettingsDto {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  hasPassword: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  /** Null until someone has pressed "send a test". */
  lastTestAt: string | null;
  /** The SMTP server's own words from the last failed test. Null if it succeeded. */
  lastTestError: string | null;
  /**
   * True when nothing is saved and these values came from SMTP_* in the
   * environment. The dev instance's Mailpit works out of the box because of this,
   * and the screen has to say so rather than imply an admin configured it.
   */
  fromEnv: boolean;
}

export const SendTestMailSchema = z.object({
  to: Email.describe("Where the test goes. The sender's own address, usually."),
});
