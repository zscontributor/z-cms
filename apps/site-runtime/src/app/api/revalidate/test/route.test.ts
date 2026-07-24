import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A publicly-reachable cache-purge endpoint. If it accepted an unauthenticated
 * request it would be a free denial-of-service lever against the origin (purge
 * everything, force every page to re-render on every hit). The tests hammer the
 * auth gate from the outside, then confirm an authorised call purges exactly the
 * tags the renderer tagged its fetch with — no more, no less.
 */

const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({
  revalidateTag: (...args: unknown[]) => revalidateTag(...args),
}));

import { pageTag, siteTag } from "@/lib/cache-tags";
import { POST } from "../route";

const TOKEN = "s3cret-internal-token";

/** Builds the request cms-api would send, with an overridable token header. */
function post(body: unknown, token: string | null = TOKEN) {
  return POST(
    new Request("http://site.test/api/revalidate", {
      method: "POST",
      headers: token === null ? {} : { "x-internal-token": token },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  revalidateTag.mockClear();
  vi.stubEnv("CMS_INTERNAL_TOKEN", TOKEN);
});

describe("POST", () => {
  it("refuses a request that carries no internal token", async () => {
    // No token header at all: an anonymous internet client. Must be 401.
    const res = await post({ hostname: "site.test" }, null);

    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("refuses a request whose token does not match the configured one", async () => {
    const res = await post({ hostname: "site.test" }, "wrong-token");

    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("refuses every request when no internal token is configured, rather than allowing all", async () => {
    // An empty CMS_INTERNAL_TOKEN must fail closed: it must not become a shared
    // "" that any caller sending no token would match.
    vi.stubEnv("CMS_INTERNAL_TOKEN", "");

    const res = await post({ hostname: "site.test" }, "");

    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("purges the whole-site tag when a hostname is given with no paths", async () => {
    const res = await post({ hostname: "Site.Test" });

    expect(res.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith(siteTag("Site.Test"), { expire: 0 });
  });

  it("purges one page tag per path, scoped to the hostname", async () => {
    const res = await post({ hostname: "site.test", paths: ["/", "/blog/hello"] });

    expect(res.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith(pageTag("site.test", "/"), { expire: 0 });
    expect(revalidateTag).toHaveBeenCalledWith(
      pageTag("site.test", "/blog/hello"),
      { expire: 0 },
    );
    // The whole-site tag is NOT purged when specific paths were named.
    expect(revalidateTag).not.toHaveBeenCalledWith(siteTag("site.test"), { expire: 0 });
  });

  it("accepts raw tags passed straight through", async () => {
    const res = await post({ tags: ["custom:tag"] });

    expect(res.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith("custom:tag", { expire: 0 });
  });

  it("rejects a malformed JSON body without touching the cache", async () => {
    const res = await POST(
      new Request("http://site.test/api/revalidate", {
        method: "POST",
        headers: { "x-internal-token": TOKEN },
        body: "not json{",
      }),
    );

    expect(res.status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("refuses an authorised request that names nothing to purge", async () => {
    // A valid token but an empty instruction must not silently purge the world.
    const res = await post({});

    expect(res.status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
