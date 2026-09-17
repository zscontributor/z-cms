import type { InvitationDto, MembershipDto, Role, UserDto } from "@zcmsorg/schemas";

/**
 * Prisma row -> wire DTO.
 *
 * The one thing worth saying about these: `passwordHash` is not in UserDto, and
 * the mapper is what guarantees it never becomes so by accident. Returning the
 * row directly would leak the hash the first time someone added an `include`.
 */

interface MembershipRow {
  id: string;
  role: string;
  siteId: string | null;
  site?: { name: string } | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
  /** The presence of a timestamp IS the switch — see the User model. */
  totpEnabledAt: Date | null;
  createdAt: Date;
  memberships: MembershipRow[];
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  siteId: string | null;
  site?: { name: string } | null;
  invitedBy?: { name: string } | null;
  expiresAt: Date;
  createdAt: Date;
}

export function toMembershipDto(row: MembershipRow): MembershipDto {
  return {
    id: row.id,
    role: row.role as Role,
    siteId: row.siteId,
    // Null is the honest answer for a tenant-wide membership: there is no one
    // site to name, and inventing a label like "All sites" here would put an
    // untranslatable English string in the API.
    siteName: row.site?.name ?? null,
  };
}

/**
 * @param visibleSiteIds Sites the *caller* may see, or `null` for all of them.
 *
 * A caller whose reach is a list of sites is shown only the roles this person
 * holds inside it. Without that, the users screen would answer a question the
 * caller is not allowed to ask — "which other sites does this colleague work
 * on?" — and would answer it with site *names*, which is the same leak that
 * GET /sites exists to prevent. Tenant-wide memberships (siteId null) survive
 * the filter: they apply to the caller's own site, so hiding them would
 * misreport who has access to it.
 */
export function toUserDto(row: UserRow, visibleSiteIds: string[] | null = null): UserDto {
  const memberships = visibleSiteIds
    ? row.memberships.filter((m) => m.siteId === null || visibleSiteIds.includes(m.siteId))
    : row.memberships;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    // The timestamp itself stays server-side: when someone turned 2FA on is of no
    // use to the screen, and the encrypted secret sitting next to it in the row is
    // exactly the kind of column a mapper exists to keep out of a response.
    twoFactorEnabled: row.totpEnabledAt !== null,
    createdAt: row.createdAt.toISOString(),
    memberships: memberships.map(toMembershipDto),
  };
}

export function toInvitationDto(row: InvitationRow): InvitationDto {
  return {
    id: row.id,
    email: row.email,
    role: row.role as Role,
    siteId: row.siteId,
    siteName: row.site?.name ?? null,
    invitedByName: row.invitedBy?.name ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
