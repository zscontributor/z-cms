import type { SessionUser } from "@zcmsorg/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A real ApiError class (content.ts branches on `instanceof`), with apiFetch and
// the session helpers stubbed. Mocking the module avoids pulling next/headers and
// React's request cache into these unit tests.
const { apiFetchMock, getSessionMock, canMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  getSessionMock: vi.fn(),
  canMock: vi.fn(),
}));

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  }
  return { ApiError, apiFetch: apiFetchMock, getSession: getSessionMock, can: canMock };
});

// The translator's cookie source; content.ts calls getT for its messages.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { ApiError } from "@/lib/api";
import { type ContentFormPayload, saveContentAction } from "../content";

const A_USER = { id: "u1", permissions: [] } as unknown as SessionUser;

/** A valid create payload; tests override the fields they are probing. */
function payload(overrides: Partial<ContentFormPayload> = {}): ContentFormPayload {
  return {
    contentTypeId: "11111111-1111-4111-8111-111111111111",
    typeKey: "pages",
    title: "About us",
    slug: "about-us",
    locale: "",
    excerpt: "",
    status: "DRAFT",
    data: {},
    blocks: [],
    seo: {},
    ...overrides,
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  getSessionMock.mockReset().mockResolvedValue(A_USER);
  canMock.mockReset().mockReturnValue(true);
});

describe("saveContentAction", () => {
  it("refuses to act when there is no session", async () => {
    getSessionMock.mockResolvedValueOnce(null);

    const result = await saveContentAction(payload());

    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the session lacks the required permission", async () => {
    // A server action is a public HTTP endpoint; the permission is enforced here,
    // not assumed from a hidden UI control.
    canMock.mockReturnValue(false);

    const result = await saveContentAction(payload());

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("validates the payload before calling the API", async () => {
    // An empty title is invalid per CreateContentSchema; the action must catch it
    // rather than forward a bad body to cms-api.
    const result = await saveContentAction(payload({ title: "" }));

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed contentTypeId rather than trusting the caller", async () => {
    const result = await saveContentAction(payload({ contentTypeId: "not-a-uuid" }));

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a valid new document and returns its id and status", async () => {
    apiFetchMock.mockResolvedValueOnce({ id: "c1", status: "DRAFT", updatedAt: "2024-01-01T00:00:00Z" });

    const result = await saveContentAction(payload());

    expect(apiFetchMock).toHaveBeenCalledWith("/contents", expect.objectContaining({ method: "POST" }));
    expect(result).toEqual({ ok: true, id: "c1", status: "DRAFT", updatedAt: "2024-01-01T00:00:00Z" });
  });

  it("PATCHes an existing document when an id is present", async () => {
    apiFetchMock.mockResolvedValueOnce({ id: "c9", status: "DRAFT", updatedAt: "2024-01-01T00:00:00Z" });

    await saveContentAction(payload({ id: "c9" }));

    expect(apiFetchMock).toHaveBeenCalledWith("/contents/c9", expect.objectContaining({ method: "PATCH" }));
  });

  it("returns an API failure as a typed error state, never throwing into the UI", async () => {
    // The editor holds unsaved work; an exception here would blow it away via the
    // error boundary. The failure comes back as data instead.
    apiFetchMock.mockRejectedValueOnce(new ApiError(409, "Slug already exists"));

    const result = await saveContentAction(payload());

    expect(result).toEqual({ ok: false, error: "Slug already exists" });
  });
});
