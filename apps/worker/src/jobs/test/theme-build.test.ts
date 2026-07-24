import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The build job is where a drawing becomes an artifact the platform signs, so what
 * is pinned here is the division of labour and the refusals — not esbuild, which
 * @zcmsorg/theme-codegen already proves builds and loads a real bundle.
 *
 * The load-bearing case: the worker must NOT register the theme itself. It hands
 * the bytes to cms-api's sideload gate, which owns the policy (verify against the
 * pinned key, refuse an impersonating id, scan, quarantine). A second registration
 * path here would be a second door, and the one that forgot a check is the one that
 * gets used.
 */

const { dbMock, generateAndBuild, buildPackage, packDirectory, sha256, rmSync, fetchMock, s3Send } =
  vi.hoisted(() => ({
    dbMock: { themeDraft: { findFirst: vi.fn(), update: vi.fn() } },
    generateAndBuild: vi.fn(),
    buildPackage: vi.fn(),
    packDirectory: vi.fn(),
    sha256: vi.fn(),
    rmSync: vi.fn(),
    fetchMock: vi.fn(),
    s3Send: vi.fn(),
  }));

vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => dbMock }));
vi.mock("@zcmsorg/theme-codegen", () => ({ generateAndBuild }));
vi.mock("@zcmsorg/package", () => ({ buildPackage, packDirectory, sha256 }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3Send;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    default: { ...actual, mkdtempSync: () => "/tmp/fake-build", realpathSync: () => "/tmp", rmSync },
  };
});

import { runThemeBuild } from "../theme-build";

const job = { tenantId: "t1", siteId: "s1", draftId: "d1", actorId: "u1" };

const draft = {
  id: "d1",
  key: "com.acme.theme.shop",
  name: "Acme Shop",
  version: "1.0.0",
  description: null,
  document: { version: 1, tokens: {}, templates: { page: [] } },
  author: { name: "Dana" },
};

function ok(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.OPERATOR_PRIVATE_KEY = "priv";
  process.env.OPERATOR_PUBLIC_KEY = "pub";
  process.env.CMS_API_URL = "http://api:4100";
  process.env.CMS_INTERNAL_TOKEN = "tok";
  process.env.S3_BUCKET = "bucket";
  packDirectory.mockResolvedValue(Buffer.from("payload"));
  sha256.mockReturnValue("deadbeef".repeat(8));
  s3Send.mockResolvedValue({});
  dbMock.themeDraft.findFirst.mockResolvedValue(draft);
  dbMock.themeDraft.update.mockResolvedValue({});
  generateAndBuild.mockResolvedValue({ manifest: { id: draft.key } });
  buildPackage.mockResolvedValue({ file: Buffer.from("zcms"), envelope: {} });
  fetchMock.mockResolvedValue(
    ok({ key: draft.key, version: "1.0.0", reviewStatus: "QUARANTINED" }),
  );
});

describe("runThemeBuild", () => {
  it("builds, signs, installs through cms-api, then marks the draft BUILT", async () => {
    const result = (await runThemeBuild(job)) as { reviewStatus: string };

    expect(result.reviewStatus).toBe("QUARANTINED");
    expect(dbMock.themeDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "BUILT" }) }),
    );
  });

  it("records the digest the author will sign, so publishing has something to sign", async () => {
    await runThemeBuild(job);
    // Staged unconditionally: an operator who never enabled local installs must
    // still be able to draw a theme and publish it.
    expect(s3Send).toHaveBeenCalled();
    expect(dbMock.themeDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payloadChecksum: "deadbeef".repeat(8),
          payloadRef: "staging/theme-payload/d1.tgz",
        }),
      }),
    );
  });

  it("installs through the sideload gate, authenticated as our own worker", async () => {
    await runThemeBuild(job);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api:4100/api/v1/sideload/internal/built");
    // The body names any tenant it likes — only our worker may say that, which is
    // what the internal token is for.
    expect((init as RequestInit).headers).toMatchObject({ "x-internal-token": "tok" });
  });

  it("signs with the operator key as both publisher and operator", async () => {
    await runThemeBuild(job);
    // A locally built theme speaks only for itself — the same call packFromZip
    // makes on the sideload path.
    expect(buildPackage).toHaveBeenCalledWith("/tmp/fake-build", "theme", "priv", "pub", {
      operatorPrivateKey: "priv",
    });
  });

  it("credits the person who drew it, not the tenant", async () => {
    await runThemeBuild(job);
    expect(generateAndBuild).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ authorName: "Dana" }) }),
    );
  });

  it("reads the document from the row, never from the job payload", async () => {
    await runThemeBuild(job);
    // A copy of the design in Redis would be stale the moment somebody saved again.
    expect(generateAndBuild).toHaveBeenCalledWith(
      expect.objectContaining({ document: draft.document }),
    );
  });

  it("surfaces cms-api's refusal on the draft", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "id impersonates a built-in theme",
    });

    await expect(runThemeBuild(job)).rejects.toThrow(/impersonates a built-in/);
    expect(dbMock.themeDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          buildError: expect.stringContaining("impersonates"),
        }),
      }),
    );
  });

  it("puts the reason on the row when the build itself fails", async () => {
    generateAndBuild.mockRejectedValue(new Error("widget nope/nope cannot be built"));

    await expect(runThemeBuild(job)).rejects.toThrow();
    expect(dbMock.themeDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it("never installs a package the build did not produce", async () => {
    generateAndBuild.mockRejectedValue(new Error("boom"));
    await expect(runThemeBuild(job)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes the temp tree even when the build fails", async () => {
    generateAndBuild.mockRejectedValue(new Error("boom"));
    await expect(runThemeBuild(job)).rejects.toThrow();
    expect(rmSync).toHaveBeenCalledWith("/tmp/fake-build", { recursive: true, force: true });
  });

  it("says which switch is off when the instance signs offline", async () => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    // Not a bug — the operator deliberately kept the key off the server. The error
    // has to name that posture rather than read as a crash.
    await expect(runThemeBuild(job)).rejects.toThrow(/OPERATOR_PRIVATE_KEY/);
  });

  it("fails cleanly when the draft is gone", async () => {
    dbMock.themeDraft.findFirst.mockResolvedValue(null);
    await expect(runThemeBuild(job)).rejects.toThrow(/gone/);
  });
});
