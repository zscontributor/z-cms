import { describe, expect, it } from "vitest";
import { toInvitationDto, toMembershipDto, toUserDto } from "../users.mappers";

/**
 * The single most important property of these mappers: the password hash never
 * leaves the building. UserDto has no field for it, and this mapper is what makes
 * that guarantee hold the first time someone adds an `include` to the query.
 */

describe("toUserDto", () => {
  it("never includes the password hash in its output", () => {
    // Leaking a bcrypt hash in an API response is a real breach: it hands an
    // attacker an offline cracking target for every account.
    const row: any = {
      id: "u1",
      email: "a@x.com",
      name: "Ann",
      avatarUrl: null,
      lastLoginAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      passwordHash: "$2a$10$supersecrethash",
      memberships: [],
    };

    const dto = toUserDto(row);

    expect(dto).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(dto)).not.toContain("supersecrethash");
  });

  it("maps memberships and serialises dates to ISO strings", () => {
    const dto = toUserDto({
      id: "u1",
      email: "a@x.com",
      name: "Ann",
      avatarUrl: null,
      lastLoginAt: new Date("2024-02-01T00:00:00.000Z"),
      totpEnabledAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      memberships: [{ id: "m1", role: "ADMIN", siteId: "s1", site: { name: "Main" } }],
    });

    expect(dto.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(dto.lastLoginAt).toBe("2024-02-01T00:00:00.000Z");
    expect(dto.memberships[0]).toMatchObject({ role: "ADMIN", siteName: "Main" });
  });

  /**
   * The encrypted TOTP secret sits in the same row as the fields this mapper does
   * copy, so "the mapper is what keeps it out" is a claim worth a test rather than
   * a comment. The DTO reports only WHETHER a second factor exists.
   */
  it("reports two-factor as a boolean and never leaks the secret next to it", () => {
    const row: any = {
      id: "u1",
      email: "a@x.com",
      name: "Ann",
      avatarUrl: null,
      lastLoginAt: null,
      totpEnabledAt: new Date("2024-03-01T00:00:00.000Z"),
      totpSecret: "v1.aaa.bbb.ciphertext-of-the-second-factor",
      totpPendingSecret: null,
      totpLastStep: 58000000n,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      memberships: [],
    };

    const dto = toUserDto(row);

    expect(dto.twoFactorEnabled).toBe(true);
    expect(dto).not.toHaveProperty("totpSecret");
    expect(dto).not.toHaveProperty("totpEnabledAt");
    expect(JSON.stringify(dto)).not.toContain("ciphertext-of-the-second-factor");
  });

  it("reports two-factor as off when there is no timestamp", () => {
    const dto = toUserDto({
      id: "u1",
      email: "a@x.com",
      name: "Ann",
      avatarUrl: null,
      lastLoginAt: null,
      totpEnabledAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      memberships: [],
    });

    expect(dto.twoFactorEnabled).toBe(false);
  });
});

describe("toMembershipDto", () => {
  it("reports a null site name for a tenant-wide membership", () => {
    // A null siteId is a tenant-wide role; inventing a label here would ship an
    // untranslatable English string through the API.
    const dto = toMembershipDto({ id: "m1", role: "OWNER", siteId: null, site: null });

    expect(dto.siteId).toBeNull();
    expect(dto.siteName).toBeNull();
  });
});

describe("toInvitationDto", () => {
  it("exposes the invitation without ever exposing its token hash", () => {
    const row: any = {
      id: "i1",
      email: "b@x.com",
      role: "EDITOR",
      siteId: "s1",
      site: { name: "Main" },
      invitedBy: { name: "Ann" },
      tokenHash: "deadbeefhash",
      expiresAt: new Date("2024-03-01T00:00:00.000Z"),
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    const dto = toInvitationDto(row);

    expect(dto).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(dto)).not.toContain("deadbeefhash");
    expect(dto.invitedByName).toBe("Ann");
  });
});
