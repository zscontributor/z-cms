import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportMailDeadLetter, runMailSend } from "../mail-send";

const JOB = {
  tenantId: "t1",
  siteId: "s1",
  pluginKey: "newsletter",
  message: { to: ["reader@example.com"], subject: "Hello", text: "Hi" },
};

function mockFetch(responses: { ok: boolean; status: number; body?: string }[]) {
  const fetchMock = vi.fn();
  for (const res of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: res.ok,
      status: res.status,
      text: async () => res.body ?? "{}",
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("runMailSend", () => {
  beforeEach(() => {
    vi.stubEnv("CMS_API_URL", "http://api.test");
    vi.stubEnv("CMS_INTERNAL_TOKEN", "internal-token");
  });

  it("asks cms-api to send rather than opening SMTP itself", async () => {
    // The worker holds no MAIL_ENCRYPTION_KEY and no SMTP credential, and this is
    // what keeps it that way: it triggers a send, it does not perform one.
    const fetchMock = mockFetch([{ ok: true, status: 200, body: '{"ok":true}' }]);

    await runMailSend(JOB);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/v1/mail/deliver");
    expect(init.headers["x-internal-token"]).toBe("internal-token");
    expect(JSON.parse(init.body)).toEqual(JOB);
  });

  it("throws on a rejected delivery, so BullMQ retries it with backoff", async () => {
    // A mail server that is down at 09:00 is usually up at 09:05. Swallowing this
    // would turn a late email into a lost one.
    mockFetch([{ ok: false, status: 502, body: "smtp unreachable" }]);

    await expect(runMailSend(JOB)).rejects.toThrow(/502/);
  });
});

describe("reportMailDeadLetter", () => {
  beforeEach(() => {
    vi.stubEnv("CMS_API_URL", "http://api.test");
    vi.stubEnv("CMS_INTERNAL_TOKEN", "internal-token");
  });

  it("reports the final failure so cms-api can fire mail.failed", async () => {
    const fetchMock = mockFetch([{ ok: true, status: 200 }]);

    await reportMailDeadLetter(JOB, "535 authentication failed");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/v1/mail/dead-letter");
    expect(JSON.parse(init.body).error).toBe("535 authentication failed");
  });

  it("does not throw when the report itself fails", async () => {
    // This runs BECAUSE something already failed. A dead letter that cannot be
    // reported must not take the worker's failure handler down with it.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("api is down too")),
    );

    await expect(reportMailDeadLetter(JOB, "boom")).resolves.toBeUndefined();
  });
});
