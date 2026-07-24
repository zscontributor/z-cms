import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";

// Only real external I/O is mocked. nodemailer would open a socket to an SMTP
// server; ioredis would open one to Redis. Everything the service actually
// decides — what reaches the wire, when a send is refused — is left real.
const holder = vi.hoisted(() => ({
  sendMail: vi.fn(),
  close: vi.fn(),
  transportOptions: null as any,
  redis: null as any,
}));

vi.mock("nodemailer", () => ({
  createTransport: (options: unknown) => {
    holder.transportOptions = options;
    return { sendMail: holder.sendMail, close: holder.close };
  },
}));

vi.mock("ioredis", () => ({
  default: class {
    incrby = (...args: unknown[]) => holder.redis.incrby(...args);
    expire = (...args: unknown[]) => holder.redis.expire(...args);
    ttl = (...args: unknown[]) => holder.redis.ttl(...args);
    on = () => this;
    quit = () => holder.redis.quit();
  },
}));

import { MailService } from "../mail.service";

const CONFIG = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  auth: { user: "postmaster", pass: "hunter2" },
  from: { name: "Example", address: "no-reply@example.com" },
  replyTo: null as string | null,
};

const MESSAGE = { to: ["reader@example.com"], subject: "Hello", text: "Hi there" };

function make(over: { config?: unknown; limit?: number } = {}) {
  const settings = {
    resolve: vi.fn().mockResolvedValue(over.config === undefined ? CONFIG : over.config),
  };
  const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const plugins = {
    // The default filter is the identity: pass the value straight through.
    applyFilter: vi.fn().mockImplementation((_t, _s, _f, value) => Promise.resolve(value)),
    dispatchAction: vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: (key: string) =>
      key === "MAIL_PLUGIN_HOURLY_LIMIT" ? String(over.limit ?? 200) : undefined,
  };

  const service = new MailService(config as any, settings as any, queue as any, plugins as any);
  return { service, settings, queue, plugins };
}

describe("MailService", () => {
  beforeEach(() => {
    holder.sendMail.mockReset().mockResolvedValue({ messageId: "<abc@example.com>" });
    holder.close.mockReset();
    holder.transportOptions = null;
    holder.redis = {
      incrby: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      ttl: vi.fn().mockResolvedValue(3600),
      quit: vi.fn().mockResolvedValue("OK"),
    };
  });

  describe("deliver", () => {
    it("sends from the site's configured address, never the caller's", async () => {
      // THE test of this feature. A plugin that could set `from` could send as
      // billing@ the site's own domain, under the operator's SPF record.
      const { service } = make();

      await service.deliver("t1", "s1", { ...MESSAGE, replyTo: "plugin@evil.test" }, "evil-plugin");

      const sent = holder.sendMail.mock.calls[0][0];
      expect(sent.from).toEqual({ name: "Example", address: "no-reply@example.com" });
      // replyTo IS the plugin's to set — that is the honest escape hatch.
      expect(sent.replyTo).toBe("plugin@evil.test");
      expect(sent).not.toHaveProperty("sender");
    });

    it("refuses to send when the site has no mail server", async () => {
      const { service } = make({ config: null });

      await expect(service.deliver("t1", "s1", MESSAGE, null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(holder.sendMail).not.toHaveBeenCalled();
    });

    it("lets a mail.sending filter rewrite the letter", async () => {
      const { service, plugins } = make();
      plugins.applyFilter.mockResolvedValue({
        subject: "[Example] Hello",
        text: "Hi there\n\n— unsubscribe: https://example.com/u",
        send: true,
      });

      await service.deliver("t1", "s1", MESSAGE, null);

      const sent = holder.sendMail.mock.calls[0][0];
      expect(sent.subject).toBe("[Example] Hello");
      expect(sent.text).toContain("unsubscribe");
    });

    it("does not let a filter readdress the mail", async () => {
      // `to` is in the filter's CONTEXT, not its value — a plugin may edit the
      // letter and refuse to post it, but it may not send it somewhere else.
      const { service, plugins } = make();
      plugins.applyFilter.mockResolvedValue({
        subject: "Hello",
        text: "Hi there",
        to: ["attacker@evil.test"],
        send: true,
      });

      await service.deliver("t1", "s1", MESSAGE, null);

      expect(holder.sendMail.mock.calls[0][0].to).toEqual(["reader@example.com"]);
    });

    it("cancels the send when a filter says so, without calling the mail server", async () => {
      const { service, plugins } = make();
      plugins.applyFilter.mockResolvedValue({ subject: "Hello", text: "Hi", send: false });

      const result = await service.deliver("t1", "s1", MESSAGE, null);

      expect(result).toEqual({ ok: true, cancelled: true });
      expect(holder.sendMail).not.toHaveBeenCalled();
    });

    it("falls back to the site's reply-to when neither filter nor message set one", async () => {
      // Precedence is filter → message → site config. Without the last rung, a site
      // that set a support address in Settings would silently stop honouring it.
      const { service } = make({ config: { ...CONFIG, replyTo: "support@example.com" } });

      await service.deliver("t1", "s1", MESSAGE, null);

      expect(holder.sendMail.mock.calls[0][0].replyTo).toBe("support@example.com");
    });

    it("tells the plugins an email went out", async () => {
      const { service, plugins } = make();

      await service.deliver("t1", "s1", MESSAGE, "newsletter");

      const [, , action, payload] = plugins.dispatchAction.mock.calls[0];
      expect(action).toBe("mail.sent");
      expect(payload).toMatchObject({
        pluginKey: "newsletter",
        to: ["reader@example.com"],
        messageId: "<abc@example.com>",
      });
      // A receipt, not a copy: another plugin's message body is not on offer.
      expect(payload).not.toHaveProperty("text");
      expect(payload).not.toHaveProperty("html");
    });

    it("surfaces the SMTP server's own error instead of a generic one", async () => {
      // A configuring operator needs the server's actual words; swallowing "535
      // auth failed" into "could not send" is why mail config is miserable.
      const { service } = make();
      holder.sendMail.mockRejectedValue(new Error("535 authentication failed"));

      await expect(service.deliver("t1", "s1", MESSAGE, null)).rejects.toThrow(/535/);
    });

    it("closes the connection even when the server refuses", async () => {
      const { service } = make();
      holder.sendMail.mockRejectedValue(new Error("535 authentication failed"));

      await expect(service.deliver("t1", "s1", MESSAGE, null)).rejects.toThrow(/535/);
      expect(holder.close).toHaveBeenCalled();
    });
  });

  describe("enqueue", () => {
    it("rejects a message with no body before it can become a poison job", async () => {
      const { service, queue } = make();

      await expect(
        service.enqueue("t1", "s1", "newsletter", { to: "a@b.co", subject: "Hi" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("rejects a recipient carrying a CRLF, closing off SMTP header injection", async () => {
      // A `to` of "victim@x.com\r\nBcc: attacker@evil.com" is how a caller smuggles
      // an extra header. The email schema refuses it here, at the boundary, before
      // it is ever handed to the transport — and before it is even counted.
      const { service, queue } = make();

      await expect(
        service.enqueue("t1", "s1", "newsletter", {
          to: "victim@example.com\r\nBcc: attacker@evil.test",
          subject: "Hi",
          text: "Hi",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(holder.redis.incrby).not.toHaveBeenCalled();
    });

    it("queues rather than sends — a hook has five seconds and SMTP wants thirty", async () => {
      const { service, queue } = make();

      const result = await service.enqueue("t1", "s1", "newsletter", {
        to: "a@b.co",
        subject: "Hi",
        text: "Hi",
      });

      expect(result).toEqual({ queued: true });
      expect(holder.sendMail).not.toHaveBeenCalled();

      const [name, payload, options] = queue.enqueue.mock.calls[0];
      expect(name).toBe("mail.send");
      expect(payload).toMatchObject({ tenantId: "t1", siteId: "s1", pluginKey: "newsletter" });
      // Deduplicated on content, so a hook that fires twice sends once.
      expect(options.jobId).toMatch(/^mail-[0-9a-f]{32}$/);
    });

    it("normalises a single string recipient into the queued array", async () => {
      // The schema accepts a bare string for ergonomics; the queued job must carry
      // the array the worker expects, or delivery reads `to[0]` off a character.
      const { service, queue } = make();

      await service.enqueue("t1", "s1", null, { to: "solo@b.co", subject: "Hi", text: "Hi" });

      expect(queue.enqueue.mock.calls[0][1].message.to).toEqual(["solo@b.co"]);
    });

    it("gives the same message the same job id, and a different one a different id", async () => {
      const { service, queue } = make();
      const message = { to: "a@b.co", subject: "Hi", text: "Hi" };

      await service.enqueue("t1", "s1", "newsletter", message);
      await service.enqueue("t1", "s1", "newsletter", message);
      await service.enqueue("t1", "s1", "newsletter", { ...message, subject: "Different" });

      const [first, second, third] = queue.enqueue.mock.calls.map((call) => call[2].jobId);
      expect(first).toBe(second);
      expect(third).not.toBe(first);
    });

    it("stops a plugin once the site's hourly budget is gone", async () => {
      const { service, queue } = make({ limit: 10 });
      holder.redis.incrby.mockResolvedValue(11);

      await expect(
        service.enqueue("t1", "s1", "spammy", { to: "a@b.co", subject: "Hi", text: "Hi" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("charges the budget per recipient, not per call", async () => {
      // Otherwise "200 sends an hour" means "200 × 50 recipients an hour", and the
      // cap is off by a factor of fifty.
      const { service } = make({ limit: 10 });

      await service.enqueue("t1", "s1", "newsletter", {
        to: ["a@b.co", "c@d.co"],
        bcc: ["e@f.co"],
        subject: "Hi",
        text: "Hi",
      });

      expect(holder.redis.incrby).toHaveBeenCalledWith("mail:quota:s1", 3);
    });

    it("keeps each site's quota separate, so one site cannot spend another's budget", async () => {
      // The counter is keyed by site. If it were global, three noisy tenants would
      // between them lock out every other tenant on the box.
      const { service } = make({ limit: 10 });

      await service.enqueue("t1", "site-a", "p", { to: "a@b.co", subject: "Hi", text: "Hi" });
      await service.enqueue("t1", "site-b", "p", { to: "a@b.co", subject: "Hi", text: "Hi" });

      const keys = holder.redis.incrby.mock.calls.map((call: unknown[]) => call[0]);
      expect(keys).toEqual(["mail:quota:site-a", "mail:quota:site-b"]);
    });

    it("gives the counter a one-hour TTL the first time it opens the window", async () => {
      // The very first increment lands exactly on the recipient count. That is the
      // signal to arm the expiry — without it the key would live forever and the
      // budget would never refill.
      const { service } = make({ limit: 10 });
      holder.redis.incrby.mockResolvedValue(1); // to.length === 1 === the increment

      await service.enqueue("t1", "s1", "p", { to: "a@b.co", subject: "Hi", text: "Hi" });

      expect(holder.redis.expire).toHaveBeenCalledWith("mail:quota:s1", 3600);
    });

    it("does not re-arm the window on a send inside an open hour", async () => {
      // Re-setting the TTL on every send would make the window slide forward and
      // never actually expire under steady traffic — an effectively unbounded cap.
      const { service } = make({ limit: 10 });
      holder.redis.incrby.mockResolvedValue(5); // already past the first increment

      await service.enqueue("t1", "s1", "p", { to: "a@b.co", subject: "Hi", text: "Hi" });

      expect(holder.redis.expire).not.toHaveBeenCalled();
    });

    it("does not charge the CMS's own mail against the plugin budget", async () => {
      // An invitation is a human's action. Rate-limiting it to protect against
      // plugins would break the product to defend against the wrong thing.
      const { service } = make({ limit: 1 });
      holder.redis.incrby.mockResolvedValue(999);

      await expect(
        service.enqueue("t1", "s1", null, { to: "a@b.co", subject: "Hi", text: "Hi" }),
      ).resolves.toEqual({ queued: true });

      expect(holder.redis.incrby).not.toHaveBeenCalled();
    });

    it("fails closed when the quota cannot be counted", async () => {
      // Unlike the login limiter, this one does NOT fail open: an uncounted send is
      // exactly what it exists to prevent.
      const { service, queue } = make();
      holder.redis.incrby.mockRejectedValue(new Error("Redis is down"));

      await expect(
        service.enqueue("t1", "s1", "newsletter", { to: "a@b.co", subject: "Hi", text: "Hi" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("recordFailure", () => {
    it("reports a permanent failure to the plugins as mail.failed", async () => {
      // Only the worker knows a failure was the LAST attempt. Firing this on the
      // first of three retries would teach every plugin to distrust the event.
      const { service, plugins } = make();

      await service.recordFailure(
        "t1",
        "s1",
        { to: ["a@b.co"], subject: "Hi", text: "Hi" } as any,
        "newsletter",
        "connection timed out",
      );

      const [, , action, payload] = plugins.dispatchAction.mock.calls[0];
      expect(action).toBe("mail.failed");
      expect(payload).toMatchObject({ pluginKey: "newsletter", error: "connection timed out" });
    });
  });

  describe("onModuleDestroy", () => {
    it("closes the Redis connection on shutdown", async () => {
      const { service } = make();

      await service.onModuleDestroy();

      expect(holder.redis.quit).toHaveBeenCalled();
    });
  });
});
