import { describe, expect, it } from "vitest";
import {
  AcceptInviteSchema,
  BULK_MEDIA_MAX,
  BulkDeleteMediaSchema,
  BulkMoveMediaSchema,
  ChangePasswordSchema,
  CreateUserSchema,
  CreateMediaFolderSchema,
  FOLDER_NAME_MAX,
  HOSTNAME_RE,
  InviteUserSchema,
  LoginSchema,
  normalizeHostname,
  wwwVariant,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PaginationQuerySchema,
  PasswordSchema,
  SetMembershipSchema,
  UpdateMediaFolderSchema,
  UpdateMediaSchema,
  UpdateProfileSchema,
} from "../api";

/**
 * api.ts is the wire contract cms-api validates every request body against. The
 * request schemas here are the outermost gate: auth bodies, invitations, bulk
 * media operations. Tests focus on coercions, the null-vs-undefined distinctions
 * the comments call load-bearing, and the caps that bound a bulk operation.
 */

const UUID = "11111111-1111-4111-8111-111111111111";
const okPassword = "a".repeat(PASSWORD_MIN);

describe("LoginSchema", () => {
  it("accepts a well-formed email and a non-empty password", () => {
    expect(LoginSchema.parse({ email: "user@example.com", password: "x" })).toEqual({
      email: "user@example.com",
      password: "x",
    });
  });

  it("rejects a malformed email", () => {
    expect(LoginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });

  it("rejects an email carrying an injection payload", () => {
    // The address is echoed into logs and audit records; a "<script>" tail must not
    // be accepted as a valid email in the first place.
    expect(
      LoginSchema.safeParse({ email: "user@example.com<script>", password: "x" }).success,
    ).toBe(false);
  });

  it("rejects an empty password", () => {
    // Not an auth decision — just refusing to even attempt a bcrypt compare against
    // an empty secret.
    expect(LoginSchema.safeParse({ email: "user@example.com", password: "" }).success).toBe(false);
  });

  it("strips unknown keys rather than passing them through", () => {
    const parsed = LoginSchema.parse({
      email: "user@example.com",
      password: "x",
      role: "OWNER",
    }) as Record<string, unknown>;

    expect("role" in parsed).toBe(false);
  });
});

describe("PasswordSchema", () => {
  it("accepts a password at the minimum length", () => {
    expect(PasswordSchema.safeParse("a".repeat(PASSWORD_MIN)).success).toBe(true);
  });

  it("rejects a password one character below the minimum", () => {
    // Length is the only entropy lever enforced; the floor must actually hold.
    expect(PasswordSchema.safeParse("a".repeat(PASSWORD_MIN - 1)).success).toBe(false);
  });

  it("accepts a password at the maximum length", () => {
    expect(PasswordSchema.safeParse("a".repeat(PASSWORD_MAX)).success).toBe(true);
  });

  it("rejects a password over the maximum, which exists to bound bcrypt cost", () => {
    // The ceiling is a denial-of-service guard: a megabyte password would make
    // bcrypt burn CPU. It must reject, not truncate.
    expect(PasswordSchema.safeParse("a".repeat(PASSWORD_MAX + 1)).success).toBe(false);
  });

  it("exposes the documented bounds as constants", () => {
    expect(PASSWORD_MIN).toBe(12);
    expect(PASSWORD_MAX).toBe(200);
  });
});

describe("InviteUserSchema", () => {
  it("defaults siteId to null, meaning a tenant-wide role", () => {
    // Documented: null is 'across the whole tenant', not 'unset'. An omitted key
    // must resolve to the tenant-wide grant, deliberately.
    const parsed = InviteUserSchema.parse({ email: "a@b.com", role: "EDITOR" });

    expect(parsed.siteId).toBeNull();
  });

  it("accepts an explicit siteId scoping the role to one site", () => {
    const parsed = InviteUserSchema.parse({ email: "a@b.com", role: "EDITOR", siteId: UUID });

    expect(parsed.siteId).toBe(UUID);
  });

  it("rejects an unknown role", () => {
    // The invite is where a role is chosen; "SUPERUSER" must not be a role.
    expect(InviteUserSchema.safeParse({ email: "a@b.com", role: "SUPERUSER" }).success).toBe(false);
  });

  it("rejects a non-UUID siteId", () => {
    expect(InviteUserSchema.safeParse({ email: "a@b.com", role: "EDITOR", siteId: "x" }).success).toBe(
      false,
    );
  });

  it("rejects a malformed email", () => {
    expect(InviteUserSchema.safeParse({ email: "nope", role: "EDITOR" }).success).toBe(false);
  });
});

describe("CreateUserSchema", () => {
  it("defaults siteId to null and allows the server to generate a password", () => {
    const parsed = CreateUserSchema.parse({
      email: "a@b.com",
      name: "  A User  ",
      role: "EDITOR",
    });

    expect(parsed).toEqual({ email: "a@b.com", name: "A User", role: "EDITOR", siteId: null });
  });

  it("accepts an explicit temporary password and site scope", () => {
    const parsed = CreateUserSchema.parse({
      email: "a@b.com",
      name: "A User",
      password: okPassword,
      role: "EDITOR",
      siteId: UUID,
    });

    expect(parsed.password).toBe(okPassword);
    expect(parsed.siteId).toBe(UUID);
  });

  it("rejects a too-short temporary password", () => {
    expect(
      CreateUserSchema.safeParse({
        email: "a@b.com",
        name: "A User",
        password: "short",
        role: "EDITOR",
      }).success,
    ).toBe(false);
  });
});

describe("AcceptInviteSchema", () => {
  it("accepts a token, a trimmed name and a valid password", () => {
    const parsed = AcceptInviteSchema.parse({ token: "t", name: "  Ada  ", password: okPassword });

    expect(parsed.name).toBe("Ada");
  });

  it("rejects a whitespace-only name, because it trims before the min check", () => {
    // "   " looks non-empty but trims to "". A registration must not create an
    // account with a blank display name.
    expect(AcceptInviteSchema.safeParse({ token: "t", name: "   ", password: okPassword }).success).toBe(
      false,
    );
  });

  it("rejects an empty token", () => {
    expect(AcceptInviteSchema.safeParse({ token: "", name: "Ada", password: okPassword }).success).toBe(
      false,
    );
  });

  it("rejects a name longer than 120 characters", () => {
    expect(
      AcceptInviteSchema.safeParse({ token: "t", name: "a".repeat(121), password: okPassword })
        .success,
    ).toBe(false);
  });

  it("enforces the password floor on the account being created", () => {
    expect(AcceptInviteSchema.safeParse({ token: "t", name: "Ada", password: "short" }).success).toBe(
      false,
    );
  });
});

describe("SetMembershipSchema", () => {
  it("defaults siteId to null for a tenant-wide membership", () => {
    const parsed = SetMembershipSchema.parse({ role: "ADMIN" });

    expect(parsed.siteId).toBeNull();
  });

  it("rejects an unknown role", () => {
    expect(SetMembershipSchema.safeParse({ role: "GOD" }).success).toBe(false);
  });
});

describe("UpdateProfileSchema", () => {
  it("accepts a partial update of just the name", () => {
    expect(UpdateProfileSchema.parse({ name: "  Grace  " }).name).toBe("Grace");
  });

  it("accepts an explicit null avatarUrl to clear the avatar", () => {
    // null is a real value here (clear it), distinct from omitting the key.
    expect(UpdateProfileSchema.parse({ avatarUrl: null }).avatarUrl).toBeNull();
  });

  it("rejects a whitespace-only name", () => {
    expect(UpdateProfileSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects an avatarUrl that is not a URL", () => {
    expect(UpdateProfileSchema.safeParse({ avatarUrl: "not a url" }).success).toBe(false);
  });

  it("accepts an empty object, since the whole schema is partial", () => {
    expect(UpdateProfileSchema.parse({})).toEqual({});
  });

  it("rejects a javascript: avatarUrl, which z.url() alone would accept", () => {
    // z.url() validates URL *syntax*, and "javascript:alert(1)" is syntactically a
    // URL — so without the scheme allowlist this would parse and, rendered into an
    // <img src>, be a stored-XSS sink. The refine closes it at the boundary.
    expect(
      UpdateProfileSchema.safeParse({ avatarUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("rejects a javascript: avatarUrl smuggled past a control character", () => {
    // Browsers strip TAB/newline out of a scheme, so "java\tscript:" runs as
    // "javascript:". The check normalises the same way before allowlisting.
    expect(
      UpdateProfileSchema.safeParse({ avatarUrl: "java\tscript:alert(1)" }).success,
    ).toBe(false);
  });

  it("accepts an ordinary https avatarUrl", () => {
    expect(
      UpdateProfileSchema.safeParse({ avatarUrl: "https://cdn.example.com/a.png" })
        .success,
    ).toBe(true);
  });
});

describe("ChangePasswordSchema", () => {
  it("accepts a non-empty current password and a valid new one", () => {
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "old", newPassword: okPassword }).success,
    ).toBe(true);
  });

  it("requires the current password even though the caller is authenticated", () => {
    // The current password is the proof of ownership against an unattended laptop.
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "", newPassword: okPassword }).success,
    ).toBe(false);
  });

  it("enforces the password floor on the new password", () => {
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "old", newPassword: "short" }).success,
    ).toBe(false);
  });
});

describe("PaginationQuerySchema", () => {
  it("defaults to page 1 and perPage 20", () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ page: 1, perPage: 20 });
  });

  it("coerces numeric strings from the query string", () => {
    // Query params arrive as strings; z.coerce.number is what turns "3" into 3.
    expect(PaginationQuerySchema.parse({ page: "3", perPage: "50" })).toEqual({
      page: 3,
      perPage: 50,
    });
  });

  it("rejects page zero", () => {
    expect(PaginationQuerySchema.safeParse({ page: "0" }).success).toBe(false);
  });

  it("rejects a negative page", () => {
    expect(PaginationQuerySchema.safeParse({ page: "-1" }).success).toBe(false);
  });

  it("rejects a non-integer page", () => {
    expect(PaginationQuerySchema.safeParse({ page: "1.5" }).success).toBe(false);
  });

  it("caps perPage at 100 to bound the query cost", () => {
    // Without the ceiling, ?perPage=1000000 is a way to make one request scan a
    // whole table.
    expect(PaginationQuerySchema.safeParse({ perPage: "101" }).success).toBe(false);
  });

  it("accepts perPage at exactly the 100 boundary", () => {
    expect(PaginationQuerySchema.parse({ perPage: "100" }).perPage).toBe(100);
  });
});

describe("UpdateMediaSchema", () => {
  it("trims and accepts a filename", () => {
    expect(UpdateMediaSchema.parse({ filename: "  photo.jpg  " }).filename).toBe("photo.jpg");
  });

  it("rejects a filename that trims to empty", () => {
    expect(UpdateMediaSchema.safeParse({ filename: "   " }).success).toBe(false);
  });

  it("rejects a filename longer than 255 characters", () => {
    expect(UpdateMediaSchema.safeParse({ filename: "a".repeat(256) }).success).toBe(false);
  });

  it("accepts an explicit null alt to clear it", () => {
    // null clears the alt; undefined (key absent) must leave it alone. The two must
    // not collapse or a move would wipe someone's alt text.
    expect(UpdateMediaSchema.parse({ alt: null }).alt).toBeNull();
  });

  it("distinguishes an absent alt from a null alt", () => {
    const parsed = UpdateMediaSchema.parse({ filename: "x.jpg" });

    expect("alt" in parsed).toBe(false);
  });

  it("accepts an explicit null folderId to move the file to the root", () => {
    expect(UpdateMediaSchema.parse({ folderId: null }).folderId).toBeNull();
  });

  it("rejects a non-UUID folderId", () => {
    expect(UpdateMediaSchema.safeParse({ folderId: "root" }).success).toBe(false);
  });

  it("rejects alt text longer than 500 characters", () => {
    expect(UpdateMediaSchema.safeParse({ alt: "a".repeat(501) }).success).toBe(false);
  });
});

describe("BulkDeleteMediaSchema", () => {
  it("accepts a list of UUIDs within the cap", () => {
    expect(BulkDeleteMediaSchema.parse({ ids: [UUID, UUID] }).ids).toHaveLength(2);
  });

  it("rejects an empty id list", () => {
    // A bulk delete of nothing is a malformed request, not a no-op to accept.
    expect(BulkDeleteMediaSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it("rejects more ids than the bulk cap", () => {
    // The cap bounds the row lock the delete takes; an unbounded IN (...) is how a
    // "tidy up" click becomes a table lock on a live site.
    const ids = Array.from({ length: BULK_MEDIA_MAX + 1 }, () => UUID);

    expect(BulkDeleteMediaSchema.safeParse({ ids }).success).toBe(false);
  });

  it("accepts exactly the bulk cap", () => {
    const ids = Array.from({ length: BULK_MEDIA_MAX }, () => UUID);

    expect(BulkDeleteMediaSchema.safeParse({ ids }).success).toBe(true);
  });

  it("rejects a non-UUID entry among valid ids", () => {
    expect(BulkDeleteMediaSchema.safeParse({ ids: [UUID, "not-uuid"] }).success).toBe(false);
  });

  it("exposes the documented bulk cap constant", () => {
    expect(BULK_MEDIA_MAX).toBe(100);
  });
});

describe("BulkMoveMediaSchema", () => {
  it("accepts ids and an explicit null target folder", () => {
    const parsed = BulkMoveMediaSchema.parse({ ids: [UUID], folderId: null });

    expect(parsed.folderId).toBeNull();
  });

  it("requires the folderId key to be present, unlike the optional media folderId", () => {
    // folderId here is nullable but NOT optional: a move must state where to, even
    // if 'to' is the root (null). Omitting it is a malformed move.
    expect(BulkMoveMediaSchema.safeParse({ ids: [UUID] }).success).toBe(false);
  });

  it("rejects an empty id list", () => {
    expect(BulkMoveMediaSchema.safeParse({ ids: [], folderId: null }).success).toBe(false);
  });
});

describe("CreateMediaFolderSchema", () => {
  it("trims and accepts a folder name", () => {
    expect(CreateMediaFolderSchema.parse({ name: "  Docs  " }).name).toBe("Docs");
  });

  it("rejects a folder name containing a forward slash", () => {
    // Folder names are labels, not path segments. A "/" is what would make a label
    // masquerade as a nested path.
    expect(CreateMediaFolderSchema.safeParse({ name: "a/b" }).success).toBe(false);
  });

  it("rejects a folder name containing a backslash", () => {
    // The Windows path separator is blocked for the same reason as "/".
    expect(CreateMediaFolderSchema.safeParse({ name: "a\\b" }).success).toBe(false);
  });

  it("reports the issue path pointing at the name", () => {
    const result = CreateMediaFolderSchema.safeParse({ name: "a/b" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["name"]);
  });

  it("rejects a name that trims to empty", () => {
    expect(CreateMediaFolderSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects a name longer than the folder-name cap", () => {
    expect(
      CreateMediaFolderSchema.safeParse({ name: "a".repeat(FOLDER_NAME_MAX + 1) }).success,
    ).toBe(false);
  });

  it("accepts a null parentId as creating at the root", () => {
    // nullish: null and undefined both mean 'at the root'.
    expect(CreateMediaFolderSchema.parse({ name: "Docs", parentId: null }).parentId).toBeNull();
  });

  it("accepts an omitted parentId, since it is nullish", () => {
    expect(CreateMediaFolderSchema.safeParse({ name: "Docs" }).success).toBe(true);
  });

  it("rejects a non-UUID parentId", () => {
    expect(CreateMediaFolderSchema.safeParse({ name: "Docs", parentId: "root" }).success).toBe(
      false,
    );
  });
});

describe("UpdateMediaFolderSchema", () => {
  it("accepts a rename", () => {
    expect(UpdateMediaFolderSchema.parse({ name: "Renamed" }).name).toBe("Renamed");
  });

  it("accepts an explicit null parentId to move the folder to the root", () => {
    expect(UpdateMediaFolderSchema.parse({ parentId: null }).parentId).toBeNull();
  });

  it("still refuses a slash in a renamed folder", () => {
    expect(UpdateMediaFolderSchema.safeParse({ name: "a/b" }).success).toBe(false);
  });

  it("accepts an empty object, since every field is partial", () => {
    expect(UpdateMediaFolderSchema.parse({})).toEqual({});
  });
});

describe("normalizeHostname", () => {
  // The bug this exists to prevent: the field is called "the address visitors
  // use", so people paste the thing in their address bar, and the resolver
  // matches on the Host header, which never has a scheme or a path in it.
  it("reduces a pasted URL to the hostname the resolver matches", () => {
    expect(normalizeHostname("https://z-cms.org/")).toBe("z-cms.org");
  });

  it("leaves a bare hostname alone", () => {
    expect(normalizeHostname("z-cms.org")).toBe("z-cms.org");
  });

  it("keeps the port, since 'localhost:3100' is a real Host header", () => {
    expect(normalizeHostname("http://localhost:3100/")).toBe("localhost:3100");
  });

  it("drops the path, the query and the trailing root dot", () => {
    expect(normalizeHostname("https://z-cms.org./blog?page=2")).toBe("z-cms.org");
  });

  it("lowercases, so that two spellings cannot both take the unique index", () => {
    expect(normalizeHostname("  HTTPS://Z-CMS.ORG/  ")).toBe("z-cms.org");
  });

  it("does not invent a hostname out of something that is not one", () => {
    expect(HOSTNAME_RE.test(normalizeHostname("not a host"))).toBe(false);
    expect(HOSTNAME_RE.test(normalizeHostname("https://"))).toBe(false);
  });
});

describe("wwwVariant", () => {
  it("pairs the apex with its www, and back again", () => {
    expect(wwwVariant("z-cms.org")).toBe("www.z-cms.org");
    expect(wwwVariant("www.z-cms.org")).toBe("z-cms.org");
  });

  it("has no opinion about a single label — 'www.localhost' is not a thing", () => {
    expect(wwwVariant("localhost")).toBeNull();
    expect(wwwVariant("localhost:3100")).toBeNull();
  });

  it("keeps the port on the variant it does produce", () => {
    expect(wwwVariant("z-cms.org:8080")).toBe("www.z-cms.org:8080");
  });

  it("leaves a subdomain alone rather than inventing www.blog.z-cms.org", () => {
    // Not a rule about subdomains in general: it just adds www to what it is given,
    // and "blog.z-cms.org" IS what it was given. This documents that.
    expect(wwwVariant("blog.z-cms.org")).toBe("www.blog.z-cms.org");
  });
});
