import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the database is mocked — encryption is left REAL. A mocked cipher would
// let a "secret is encrypted" test pass while the code did nothing, so every
// assertion below runs the actual AES-256-GCM box from secret-box.
const holder = vi.hoisted(() => ({ db: null as any, system: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
  getSystemDb: () => holder.system,
}));

import { MailSettingsService } from "../mail-settings.service";
import { decryptSecret, encryptSecret, readKey } from "../../common/secret-box";

const KEY = Buffer.alloc(32, 7).toString("base64");
const keyBuf = () => readKey(KEY, "MAIL_ENCRYPTION_KEY");

function makeConfig(over: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    MAIL_ENCRYPTION_KEY: KEY,
    ...over,
  };
  return { get: (key: string) => values[key] } as any;
}

function makeDb(row: any = null) {
  return {
    siteMailSettings: {
      findFirst: vi.fn().mockResolvedValue(row),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

const SAVED = {
  id: "m1",
  enabled: true,
  host: "smtp.example.com",
  port: 587,
  secure: false,
  username: "postmaster",
  passwordEncrypted: null as string | null,
  fromName: "Example",
  fromEmail: "no-reply@example.com",
  replyTo: null,
  lastTestAt: null,
  lastTestError: null,
};

const INPUT = {
  enabled: true,
  host: "smtp.example.com",
  port: 587,
  secure: false,
  username: "postmaster",
  fromName: "Example",
  fromEmail: "No-Reply@Example.COM",
  replyTo: "",
};

describe("MailSettingsService", () => {
  beforeEach(() => {
    holder.db = makeDb();
    holder.system = makeDb();
  });

  describe("the password", () => {
    it("is encrypted before it reaches the database", async () => {
      const service = new MailSettingsService(makeConfig());

      await service.save("t1", "s1", { ...INPUT, password: "hunter2" });

      const stored = holder.db.siteMailSettings.create.mock.calls[0][0].data
        .passwordEncrypted as string;

      // Not the plaintext, and not merely encoded — it decrypts back under the key.
      expect(stored).not.toContain("hunter2");
      expect(stored.startsWith("v1.")).toBe(true);
      expect(decryptSecret(stored, keyBuf())).toBe("hunter2");
    });

    it("round-trips a stored secret back to exactly what was saved", async () => {
      // save() then resolve() must return the original byte-for-byte; a lossy
      // round-trip would hand the SMTP server a password that silently fails auth.
      const service = new MailSettingsService(makeConfig());
      const secret = "p@ss w/ spaces & unicøde ✉";

      await service.save("t1", "s1", { ...INPUT, password: secret });
      const stored = holder.db.siteMailSettings.create.mock.calls[0][0].data.passwordEncrypted;

      holder.system = makeDb({ ...SAVED, passwordEncrypted: stored });
      const config = await service.resolve("t1", "s1");

      expect(config?.auth?.pass).toBe(secret);
    });

    it("is left alone when the form omits it", async () => {
      // The form cannot pre-fill a password it was never given, so an empty box
      // means "I did not touch it". If this regressed, editing the port would
      // silently wipe the credential.
      holder.db = makeDb({ ...SAVED, passwordEncrypted: "v1.existing" });
      const service = new MailSettingsService(makeConfig());

      await service.save("t1", "s1", INPUT);

      const data = holder.db.siteMailSettings.update.mock.calls[0][0].data;
      expect("passwordEncrypted" in data).toBe(false);
    });

    it("is cleared by an explicit empty string, and only that", async () => {
      holder.db = makeDb({ ...SAVED, passwordEncrypted: "v1.existing" });
      const service = new MailSettingsService(makeConfig());

      await service.save("t1", "s1", { ...INPUT, password: "" });

      expect(holder.db.siteMailSettings.update.mock.calls[0][0].data.passwordEncrypted).toBeNull();
    });

    it("never appears in what the API returns", async () => {
      holder.db = makeDb({ ...SAVED, passwordEncrypted: "v1.iv.tag.ciphertext" });
      const service = new MailSettingsService(makeConfig());

      const dto = await service.read("s1");

      // Not the plaintext, not the ciphertext, not the length — one boolean.
      expect(dto).not.toHaveProperty("password");
      expect(dto).not.toHaveProperty("passwordEncrypted");
      expect(JSON.stringify(dto)).not.toContain("ciphertext");
      expect(dto.hasPassword).toBe(true);
    });
  });

  describe("the encryption key", () => {
    it("fails loudly when it is missing rather than storing a plaintext password", async () => {
      // MAIL_ENCRYPTION_KEY unset. Writing the password anyway — in the clear —
      // is the single outcome this whole subsystem exists to prevent.
      const service = new MailSettingsService(makeConfig({ MAIL_ENCRYPTION_KEY: undefined }));

      await expect(
        service.save("t1", "s1", { ...INPUT, password: "hunter2" }),
      ).rejects.toThrow(/is not set/i);

      expect(holder.db.siteMailSettings.create).not.toHaveBeenCalled();
    });

    it("is not required to save settings that carry no new password", async () => {
      // Read fresh, not at construction: an instance that never touches mail must
      // boot without the key. Saving a port change must not demand it either.
      const service = new MailSettingsService(makeConfig({ MAIL_ENCRYPTION_KEY: undefined }));

      await expect(service.save("t1", "s1", INPUT)).resolves.toBeDefined();
      expect(holder.db.siteMailSettings.create).toHaveBeenCalled();
    });
  });

  describe("resolve", () => {
    it("hands the SMTP client a decrypted password", async () => {
      const service = new MailSettingsService(makeConfig());
      const encrypted = encryptSecret("hunter2", keyBuf());

      holder.system = makeDb({ ...SAVED, passwordEncrypted: encrypted });

      const config = await service.resolve("t1", "s1");

      expect(config?.auth).toEqual({ user: "postmaster", pass: "hunter2" });
      expect(config?.from).toEqual({ name: "Example", address: "no-reply@example.com" });
    });

    it("refuses to send when the site has switched mail off", async () => {
      // Disabled is a kill switch, not an absence. Falling through to the
      // environment here would keep sending the mail the operator just stopped.
      holder.system = makeDb({ ...SAVED, enabled: false });
      const service = new MailSettingsService(
        makeConfig({ SMTP_HOST: "localhost", SMTP_FROM: "Z-CMS <no-reply@z-cms.org>" }),
      );

      expect(await service.resolve("t1", "s1")).toBeNull();
    });

    it("falls back to SMTP_* when the site has no configuration at all", async () => {
      const service = new MailSettingsService(
        makeConfig({
          SMTP_HOST: "localhost",
          SMTP_PORT: "1025",
          SMTP_FROM: "Z-CMS <no-reply@z-cms.org>",
        }),
      );

      const config = await service.resolve("t1", "s1");

      expect(config).toMatchObject({
        host: "localhost",
        port: 1025,
        auth: null,
        from: { name: "Z-CMS", address: "no-reply@z-cms.org" },
      });
    });

    it("is null when nothing is configured anywhere", async () => {
      const service = new MailSettingsService(makeConfig());
      expect(await service.resolve("t1", "s1")).toBeNull();
    });

    it("fails loudly when the stored password will not decrypt", async () => {
      // A rotated MAIL_ENCRYPTION_KEY. Sending anyway would authenticate as nobody
      // and produce an SMTP error that names none of this.
      holder.system = makeDb({ ...SAVED, passwordEncrypted: "v1.aa.bb.cc" });
      const service = new MailSettingsService(makeConfig());

      await expect(service.resolve("t1", "s1")).rejects.toThrow(/could not be decrypted/i);
    });

    it("rejects a tampered ciphertext rather than returning a corrupted secret", async () => {
      // AES-GCM is authenticated: flip one byte of the ciphertext and the tag no
      // longer verifies. The alternative — decrypting to garbage and handing it to
      // the SMTP server — is exactly the silent-failure GCM exists to stop.
      const genuine = encryptSecret("hunter2", keyBuf());
      const [version, iv, tag] = genuine.split(".");
      const tampered = [version, iv, tag, Buffer.from("forged-body").toString("base64url")].join(
        ".",
      );

      holder.system = makeDb({ ...SAVED, passwordEncrypted: tampered });
      const service = new MailSettingsService(makeConfig());

      await expect(service.resolve("t1", "s1")).rejects.toThrow(/could not be decrypted/i);
    });
  });

  describe("read", () => {
    it("says when the values came from the environment rather than an admin", async () => {
      const service = new MailSettingsService(
        makeConfig({ SMTP_HOST: "localhost", SMTP_FROM: "Z-CMS <no-reply@z-cms.org>" }),
      );

      const dto = await service.read("s1");

      expect(dto.fromEnv).toBe(true);
      expect(dto.host).toBe("localhost");
    });

    it("normalises the sender address on save", async () => {
      const service = new MailSettingsService(makeConfig());

      await service.save("t1", "s1", INPUT);

      expect(holder.db.siteMailSettings.create.mock.calls[0][0].data.fromEmail).toBe(
        "no-reply@example.com",
      );
    });
  });
});
