import type { SessionUser } from "@zcmsorg/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ApiError, apiFetchMock, canMock, getSessionMock, revalidateMock } = vi.hoisted(() => {
  /**
   * The action decides whether to show the API's own words with `instanceof`, so
   * a rejection has to be an instance of the very class the mocked module exports.
   * Declared here, where both the factory below and the tests can reach it.
   */
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
  return {
    ApiError,
    apiFetchMock: vi.fn(),
    canMock: vi.fn(),
    getSessionMock: vi.fn(),
    revalidateMock: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: async () => ({ delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/locale", () => ({ getT: async () => (key: string) => key }));
vi.mock("@/lib/api", () => ({
  ApiError,
  apiFetch: apiFetchMock,
  can: canMock,
  getSession: getSessionMock,
}));

import { createUserAction } from "../user";

const USER = { id: "u1", permissions: ["user:invite"] } as unknown as SessionUser;

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields = {
    name: "New User",
    email: "new@example.test",
    password: "",
    siteId: "site-a",
    role: "EDITOR",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(USER);
  canMock.mockReturnValue(true);
});

/**
 * React resets an uncontrolled form once its action resolves. Without the values
 * coming back with the error, a rejected create empties the drawer and the person
 * retypes all five fields to fix the one that was wrong.
 */
describe("createUserAction — what it hands back on a failure", () => {
  it("echoes every field when the API rejects the create", async () => {
    apiFetchMock.mockRejectedValue(new ApiError(409, "that address is taken"));

    const state = await createUserAction({}, form({ password: "a long enough password" }));

    expect(state.error).toBe("that address is taken");
    expect(state.values).toEqual({
      name: "New User",
      email: "new@example.test",
      password: "a long enough password",
      siteId: "site-a",
      role: "EDITOR",
    });
  });

  it("echoes them when the address is rejected before the API is called", async () => {
    const state = await createUserAction({}, form({ email: "not-an-address" }));

    expect(state.error).toBe("admin.users.invite.emailInvalid");
    expect(state.values?.name).toBe("New User");
    expect(state.values?.siteId).toBe("site-a");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("echoes them when the password is too short", async () => {
    const state = await createUserAction({}, form({ password: "short" }));

    expect(state.error).toBe("auth.acceptInvite.passwordHint");
    expect(state.values?.password).toBe("short");
  });

  it("echoes them when the permission check refuses", async () => {
    canMock.mockReturnValue(false);

    const state = await createUserAction({}, form());

    expect(state.error).toBe("admin.users.denied");
    expect(state.values?.email).toBe("new@example.test");
  });

  it("carries nothing back on success — the drawer switches to the credentials", async () => {
    apiFetchMock.mockResolvedValue({ user: { id: "u2" }, password: "p", loginUrl: "x" });

    const state = await createUserAction({}, form());

    expect(state.created).toBeTruthy();
    expect(state.values).toBeUndefined();
  });

  it("sends the tenant-wide scope as null, not as an empty string", async () => {
    apiFetchMock.mockResolvedValue({ user: { id: "u2" }, password: "p", loginUrl: "x" });

    await createUserAction({}, form({ siteId: "" }));

    expect(apiFetchMock.mock.calls[0]![1].body.siteId).toBeNull();
  });
});
