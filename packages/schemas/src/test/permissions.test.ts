import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PermissionSchema,
  ROLES,
  RoleSchema,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  canGrantRole,
  highestRole,
  permissionsForRole,
  roleHasPermission,
  type Permission,
  type Role,
} from "../permissions";

/**
 * This file is the authorization vocabulary. Every test here is written from the
 * attacker's side, because a permission helper that grants one thing too many is
 * the worst bug this package can ship: it is a silent privilege escalation that no
 * feature test would ever surface.
 */

describe("PermissionSchema", () => {
  it("accepts every permission in the canonical list", () => {
    for (const p of PERMISSIONS) expect(PermissionSchema.parse(p)).toBe(p);
  });

  it("rejects a permission string that is not in the vocabulary", () => {
    // A plugin requesting an unknown permission at install time must be refused,
    // not waved through into a role's grant set.
    expect(PermissionSchema.safeParse("content:destroy").success).toBe(false);
  });

  it("rejects a wildcard permission", () => {
    // "content:*" is exactly the kind of thing an over-broad request would ask for.
    // The vocabulary is enumerated precisely so a wildcard has no meaning.
    expect(PermissionSchema.safeParse("content:*").success).toBe(false);
  });

  it("rejects the resource half of a permission on its own", () => {
    expect(PermissionSchema.safeParse("content").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(PermissionSchema.safeParse("").success).toBe(false);
  });

  it("rejects a case variant of a real permission", () => {
    expect(PermissionSchema.safeParse("Content:Read").success).toBe(false);
  });
});

describe("RoleSchema", () => {
  it("accepts every canonical role", () => {
    for (const r of ROLES) expect(RoleSchema.parse(r)).toBe(r);
  });

  it("rejects a role that does not exist", () => {
    // "SUPERUSER" coming off the wire must never be treated as a role at all.
    expect(RoleSchema.safeParse("SUPERUSER").success).toBe(false);
  });

  it("rejects a lowercase spelling of a real role", () => {
    expect(RoleSchema.safeParse("owner").success).toBe(false);
  });
});

describe("permissionsForRole", () => {
  it("gives VIEWER only read permissions", () => {
    // The read-only role is the blast radius of a leaked low-privilege session.
    // Anything mutating in here is a bug.
    const perms = permissionsForRole("VIEWER");

    expect(perms.every((p) => p.endsWith(":read"))).toBe(true);
  });

  it("does not let an AUTHOR publish", () => {
    // The entire reason AUTHOR and EDITOR are separate roles.
    expect(permissionsForRole("AUTHOR")).not.toContain("content:publish");
  });

  it("does not let an AUTHOR delete content", () => {
    expect(permissionsForRole("AUTHOR")).not.toContain("content:delete");
  });

  it("gives an EDITOR publish and delete but not user management", () => {
    const perms = permissionsForRole("EDITOR");

    expect(perms).toContain("content:publish");
    expect(perms).toContain("content:delete");
    expect(perms).not.toContain("user:invite");
    expect(perms).not.toContain("user:manage");
  });

  it("does not give an ADMIN the owner-only capabilities", () => {
    // site:delete, user:manage and package:review are deliberately withheld from
    // ADMIN. If a refactor of the spread-based composition leaks one in, this fails.
    const perms = permissionsForRole("ADMIN");

    expect(perms).not.toContain("site:delete");
    expect(perms).not.toContain("user:manage");
    expect(perms).not.toContain("package:review");
    // Sideloading introduces unreviewed code; an ADMIN who can install reviewed
    // packages still must not be able to bypass review.
    expect(perms).not.toContain("theme:sideload");
    expect(perms).not.toContain("plugin:sideload");
  });

  it("gives OWNER the owner-only capabilities that ADMIN lacks", () => {
    const perms = permissionsForRole("OWNER");

    expect(perms).toContain("site:delete");
    expect(perms).toContain("user:manage");
    expect(perms).toContain("package:review");
    expect(perms).toContain("theme:sideload");
    expect(perms).toContain("plugin:sideload");
  });

  it("makes each higher role a strict superset of the one below it", () => {
    // The grant sets are built by spreading the lower role into the higher. This
    // asserts that composition holds for the whole ladder, so a future edit that
    // drops a "...LOWER" spread is caught here rather than in production.
    const ladder: Role[] = ["VIEWER", "AUTHOR", "EDITOR", "ADMIN", "OWNER"];
    for (let i = 1; i < ladder.length; i++) {
      const lower = new Set(permissionsForRole(ladder[i - 1]!));
      const higher = new Set(permissionsForRole(ladder[i]!));
      for (const p of lower) expect(higher.has(p)).toBe(true);
    }
  });

  it("grants only permissions that exist in the vocabulary", () => {
    // A typo'd permission in a role array would be a grant that no check could
    // ever match — dead, but also a sign the list drifted from the schema.
    for (const role of ROLES) {
      for (const p of permissionsForRole(role)) {
        expect(PermissionSchema.safeParse(p).success).toBe(true);
      }
    }
  });
});

describe("roleHasPermission", () => {
  it("is true when the role holds the permission", () => {
    expect(roleHasPermission("EDITOR", "content:publish")).toBe(true);
  });

  it("does not let content:read satisfy a request for content:delete", () => {
    // THE ESCALATION TEST. A holder of read must never be treated as a holder of
    // delete. VIEWER has content:read and nothing destructive.
    expect(roleHasPermission("VIEWER", "content:delete")).toBe(false);
  });

  it("refuses an AUTHOR the publish permission through this check", () => {
    expect(roleHasPermission("AUTHOR", "content:publish")).toBe(false);
  });

  it("refuses an ADMIN the owner-only package:review", () => {
    expect(roleHasPermission("ADMIN", "package:review")).toBe(false);
  });

  it("grants a permission only to the exact roles listed for it", () => {
    // Cross-check every (role, permission) pair against the source of truth. If any
    // helper ever starts inferring grants instead of reading them, one of these
    // 155 assertions breaks.
    for (const role of ROLES) {
      const granted = new Set(ROLE_PERMISSIONS[role]);
      for (const p of PERMISSIONS) {
        expect(roleHasPermission(role, p)).toBe(granted.has(p));
      }
    }
  });
});

describe("canGrantRole", () => {
  it("lets a role grant its own rank", () => {
    // Handing out a peer role is allowed; the ranking only forbids granting UP.
    expect(canGrantRole("ADMIN", "ADMIN")).toBe(true);
  });

  it("lets a role grant a strictly lower role", () => {
    expect(canGrantRole("ADMIN", "EDITOR")).toBe(true);
  });

  it("forbids an ADMIN from granting OWNER", () => {
    // THE PROXY-ESCALATION ATTACK the ranking exists to stop: an ADMIN holds
    // user:invite, so without this guard they could invite an OWNER and inherit
    // site:delete / user:manage / package:review by proxy.
    expect(canGrantRole("ADMIN", "OWNER")).toBe(false);
  });

  it("forbids a VIEWER from granting anything above VIEWER", () => {
    expect(canGrantRole("VIEWER", "AUTHOR")).toBe(false);
  });

  it("lets an OWNER grant every role", () => {
    for (const target of ROLES) expect(canGrantRole("OWNER", target)).toBe(true);
  });

  it("agrees with the rank order for every ordered pair of roles", () => {
    for (const granter of ROLES) {
      for (const target of ROLES) {
        expect(canGrantRole(granter, target)).toBe(
          ROLE_RANK[granter] >= ROLE_RANK[target],
        );
      }
    }
  });
});

describe("highestRole", () => {
  it("returns the strongest role in the set", () => {
    expect(highestRole(["VIEWER", "EDITOR", "AUTHOR"])).toBe("EDITOR");
  });

  it("returns OWNER when it is present, regardless of order", () => {
    expect(highestRole(["OWNER", "VIEWER"])).toBe("OWNER");
    expect(highestRole(["VIEWER", "OWNER"])).toBe("OWNER");
  });

  it("falls back to VIEWER for an empty set", () => {
    // A user with no memberships must collapse to the least privilege, never to
    // undefined (which a downstream `>=` check would treat as NaN and mishandle).
    expect(highestRole([])).toBe("VIEWER");
  });

  it("honours an explicit fallback for an empty set", () => {
    expect(highestRole([], "AUTHOR")).toBe("AUTHOR");
  });

  it("does not let a lone low role beat a higher fallback", () => {
    // reduce starts from the fallback; a set weaker than the fallback keeps it.
    expect(highestRole(["VIEWER"], "EDITOR")).toBe("EDITOR");
  });
});

describe("ROLE_RANK", () => {
  it("orders the roles strictly from VIEWER up to OWNER", () => {
    // The whole grant-checking story rests on this being a strict total order.
    const ordered: Role[] = ["VIEWER", "AUTHOR", "EDITOR", "ADMIN", "OWNER"];
    for (let i = 1; i < ordered.length; i++) {
      expect(ROLE_RANK[ordered[i]!]).toBeGreaterThan(ROLE_RANK[ordered[i - 1]!]);
    }
  });

  it("assigns a distinct rank to every role", () => {
    expect(new Set(Object.values(ROLE_RANK)).size).toBe(ROLES.length);
  });
});

describe("PERMISSIONS and ROLES vocabularies", () => {
  it("has no duplicate permission strings", () => {
    // A duplicate would be invisible to includes()-based checks but would corrupt
    // any Map/Set keyed by permission.
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("has no duplicate role names", () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });

  it("shapes every permission as resource:action", () => {
    // The install-time consent screen parses this shape. A permission that is not
    // "resource:action" would render as an unreadable line to the admin approving.
    for (const p of PERMISSIONS as readonly Permission[]) {
      expect(p).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });
});
