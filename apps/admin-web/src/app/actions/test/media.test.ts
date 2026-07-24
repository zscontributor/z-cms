import type { SessionUser } from "@zcmsorg/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  bulkMoveMediaAction,
  createFolderAction,
  uploadMediaAction,
} from "../media";

const A_USER = { id: "u1", permissions: [] } as unknown as SessionUser;
const UUID = "22222222-2222-4222-8222-222222222222";
const UUID2 = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  apiFetchMock.mockReset();
  getSessionMock.mockReset().mockResolvedValue(A_USER);
  canMock.mockReset().mockReturnValue(true);
});

describe("uploadMediaAction", () => {
  it("refuses a caller without the upload permission", async () => {
    canMock.mockReturnValue(false);
    const fd = new FormData();
    fd.set("file", new File(["x"], "a.png", { type: "image/png" }));

    const result = await uploadMediaAction(fd);

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no file rather than posting an empty upload", async () => {
    const result = await uploadMediaAction(new FormData());

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a file over the 20MB ceiling before it reaches the API", async () => {
    // The size bound is enforced here, not just in the browser — a scripted client
    // could post a gigabyte otherwise.
    const huge = new File([new Uint8Array(21 * 1024 * 1024)], "big.png", { type: "image/png" });
    const fd = new FormData();
    fd.set("file", huge);

    const result = await uploadMediaAction(fd);

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("uploads a valid file and returns the created media", async () => {
    apiFetchMock.mockResolvedValueOnce({ id: "m1", filename: "a.png" });
    const fd = new FormData();
    fd.set("file", new File(["hello"], "a.png", { type: "image/png" }));

    const result = await uploadMediaAction(fd);

    expect(result).toEqual({ ok: true, media: { id: "m1", filename: "a.png" } });
    expect(apiFetchMock).toHaveBeenCalledWith("/media", expect.objectContaining({ method: "POST" }));
  });
});

describe("bulkMoveMediaAction", () => {
  it("rejects a move with an empty selection", async () => {
    // BulkMoveMediaSchema requires at least one id; an empty `ids` must not become
    // an unbounded server-side operation.
    const fd = new FormData();
    fd.set("folderId", UUID);

    const result = await bulkMoveMediaAction(fd);

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("rejects ids that are not valid uuids", async () => {
    const fd = new FormData();
    fd.append("ids", "; DROP TABLE media");
    fd.set("folderId", "");

    const result = await bulkMoveMediaAction(fd);

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("moves a valid selection and passes the API's moved count straight back", async () => {
    apiFetchMock.mockResolvedValueOnce({ moved: 2 });
    const fd = new FormData();
    fd.append("ids", UUID);
    fd.append("ids", UUID2);
    fd.set("folderId", ""); // empty means move to root

    const result = await bulkMoveMediaAction(fd);

    expect(result).toEqual({ ok: true, data: { moved: 2 } });
  });
});

describe("createFolderAction", () => {
  it("rejects a folder name containing a slash", async () => {
    // A folder name is a label, not a path segment; a "/" would let it masquerade
    // as one. The schema's refinement is the guard, exercised here end to end.
    const fd = new FormData();
    fd.set("name", "a/b");

    const result = await createFolderAction(fd);

    expect(result.ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a folder with a valid name", async () => {
    apiFetchMock.mockResolvedValueOnce({ id: "f1", name: "Photos" });
    const fd = new FormData();
    fd.set("name", "Photos");

    const result = await createFolderAction(fd);

    expect(result).toEqual({ ok: true, data: { id: "f1", name: "Photos" } });
  });
});
