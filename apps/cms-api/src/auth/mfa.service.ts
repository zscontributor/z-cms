import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getSystemDb } from "@zcmsorg/database";
import {
  RECOVERY_CODE_COUNT,
  type DisableTotpInput,
  type RecoveryCodesDto,
  type TotpSetupDto,
} from "@zcmsorg/schemas";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import Redis from "ioredis";
import { t } from "../common/i18n";
import { SecurityEventService } from "../audit/security-event.service";
import {
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateSecret,
  otpauthUrl,
  readEncryptionKey,
  verifyCode,
} from "./totp";

/**
 * A six-digit code is a million possibilities, and an attacker who already has
 * the password only needs one. Rate limiting is not a nicety here — it is the
 * difference between a second factor and a speed bump.
 *
 * Five wrong codes inside fifteen minutes and the account stops accepting them,
 * for everyone, until the window passes. Per USER, not per IP: an attacker
 * spraying from a botnet would sail past an IP limit, and the thing being
 * defended is the account.
 *
 * This one FAILS CLOSED. The login limiter fails open on purpose (it mitigates
 * brute force, and the password check behind it is the real gate) — but here
 * there is no gate behind it. A limiter that cannot count is a limiter that
 * cannot stop the attack it exists to stop.
 */
const MFA_MAX_ATTEMPTS = 5;
const MFA_WINDOW_SECONDS = 900;

@Injectable()
export class MfaService implements OnModuleDestroy {
  private readonly logger = new Logger(MfaService.name);
  private readonly redis: Redis;
  private readonly issuer: string;

  constructor(
    private readonly config: ConfigService,
    private readonly events: SecurityEventService,
  ) {
    this.redis = new Redis(config.get<string>("REDIS_URL") ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
    });
    this.redis.on("error", (err) => this.logger.warn(`Redis: ${err.message}`));

    // What the authenticator app shows next to the code. The instance's own name
    // if it has one, so a person running three Z-CMS instances can tell them apart.
    this.issuer = config.get<string>("MFA_ISSUER") ?? "Z-CMS";
  }

  // -------------------------------------------------------------------------
  // Enrollment
  // -------------------------------------------------------------------------

  /**
   * Mints a secret and parks it as *pending*. 2FA is not on yet.
   *
   * Calling this again before enabling replaces the pending secret, which is what
   * you want: a user who abandoned a half-finished setup and started over should
   * not be asked for a code from a QR they closed twenty minutes ago.
   */
  async setup(userId: string, email: string): Promise<TotpSetupDto> {
    const key = this.key();
    const db = getSystemDb();

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException(t()("errors.auth.accountNotFound"));
    if (user.totpEnabledAt) {
      throw new BadRequestException(t()("errors.mfa.alreadyEnabled"));
    }

    const secret = generateSecret();
    await db.user.update({
      where: { id: userId },
      data: { totpPendingSecret: encryptSecret(secret, key) },
    });

    return { secret, otpauthUrl: otpauthUrl(secret, email, this.issuer) };
  }

  /**
   * Proves the authenticator holds the pending secret, then switches 2FA on and
   * issues the recovery codes.
   *
   * The proof is the whole point of the two-step enrollment: a secret that was
   * generated but never actually scanned would, if enabled, demand a code that
   * does not exist anywhere in the world.
   */
  async enable(userId: string, tenantId: string, code: string): Promise<RecoveryCodesDto> {
    const key = this.key();
    const db = getSystemDb();

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException(t()("errors.auth.accountNotFound"));
    if (user.totpEnabledAt) throw new BadRequestException(t()("errors.mfa.alreadyEnabled"));
    if (!user.totpPendingSecret) throw new BadRequestException(t()("errors.mfa.noSetup"));

    await this.throttle(userId);

    const secret = decryptSecret(user.totpPendingSecret, key);
    const step = verifyCode(secret, code);
    if (step === null) throw new UnauthorizedException(t()("errors.mfa.invalidCode"));

    await this.clearThrottle(userId);

    const codes = this.mintRecoveryCodes();

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          totpSecret: user.totpPendingSecret,
          totpPendingSecret: null,
          totpEnabledAt: new Date(),
          totpLastStep: BigInt(step),
        },
      });

      // Any codes from a previous enrollment are dead the moment a new secret is.
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({
        data: codes.map((plain) => ({
          tenantId,
          userId,
          codeHash: hashCode(plain),
        })),
      });
    });

    this.events.record("auth.mfa_enabled", { userId, tenantId });

    return { recoveryCodes: codes };
  }

  /**
   * Turns 2FA off. Takes the password AND a code.
   *
   * Either alone is not enough, and the asymmetry is deliberate: a code alone
   * means an unlocked laptop strips the protection that exists because passwords
   * leak; a password alone means a leaked password strips the protection that
   * exists because passwords leak. Disabling has to be as hard as the thing it
   * removes.
   */
  async disable(userId: string, tenantId: string, input: DisableTotpInput): Promise<void> {
    const db = getSystemDb();

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException(t()("errors.auth.accountNotFound"));
    if (!user.totpEnabledAt || !user.totpSecret) {
      throw new BadRequestException(t()("errors.mfa.notEnabled"));
    }

    await this.throttle(userId);

    if (!(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException(t()("errors.users.wrongPassword"));
    }

    const accepted = await this.consumeSecondFactor(user, input.code);
    if (!accepted) throw new UnauthorizedException(t()("errors.mfa.invalidCode"));

    await this.clearThrottle(userId);

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          totpSecret: null,
          totpPendingSecret: null,
          totpEnabledAt: null,
          totpLastStep: null,
        },
      });
      await tx.recoveryCode.deleteMany({ where: { userId } });
    });

    // Not a routine settings change: an account's protection was removed, and if
    // it was not the account holder who did it, this line is how anyone finds out.
    this.events.record("auth.mfa_disabled", { userId, tenantId, by: "self" });
  }

  /**
   * An administrator turning someone else's 2FA off.
   *
   * This exists because phones get lost and recovery codes get left in the desk
   * drawer of a house someone no longer lives in — and the alternative to an
   * admin reset is an account nobody can ever reach again.
   *
   * It is also, unavoidably, a bypass: whoever holds `user:manage` can strip a
   * colleague's second factor and then need only their password. That is why it
   * is OWNER-only, why it is a security event rather than an audit line, and why
   * the person it happened to is not left to find out on their own — their
   * sessions are killed, so they are made to sign in again and will see 2FA gone.
   */
  async reset(actorId: string, userId: string, tenantId: string): Promise<void> {
    const db = getSystemDb();

    const user = await db.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new UnauthorizedException(t()("errors.users.notFound"));
    if (!user.totpEnabledAt) throw new BadRequestException(t()("errors.mfa.notEnabled"));

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          totpSecret: null,
          totpPendingSecret: null,
          totpEnabledAt: null,
          totpLastStep: null,
        },
      });
      await tx.recoveryCode.deleteMany({ where: { userId } });
    });

    await this.clearThrottle(userId);

    this.events.record("auth.mfa_reset_by_admin", { userId, tenantId, actorId });
  }

  /** Reissues the recovery codes, killing the old ones. Takes the password. */
  async regenerateRecoveryCodes(
    userId: string,
    tenantId: string,
    password: string,
  ): Promise<RecoveryCodesDto> {
    const db = getSystemDb();

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException(t()("errors.auth.accountNotFound"));
    if (!user.totpEnabledAt) throw new BadRequestException(t()("errors.mfa.notEnabled"));

    await this.throttle(userId);
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException(t()("errors.users.wrongPassword"));
    }
    await this.clearThrottle(userId);

    const codes = this.mintRecoveryCodes();

    await db.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({
        data: codes.map((plain) => ({ tenantId, userId, codeHash: hashCode(plain) })),
      });
    });

    this.events.record("auth.mfa_recovery_codes_regenerated", { userId, tenantId });

    return { recoveryCodes: codes };
  }

  /** How many recovery codes are left. Shown on the profile so nobody runs out silently. */
  async remainingRecoveryCodes(userId: string): Promise<number> {
    return getSystemDb().recoveryCode.count({ where: { userId, usedAt: null } });
  }

  // -------------------------------------------------------------------------
  // The login-time check
  // -------------------------------------------------------------------------

  /**
   * The second step of login. Throws unless the code is good.
   *
   * Both kinds of code are accepted here, in one field, because a person reaching
   * for a recovery code has just lost their phone and does not need to be sent
   * looking for the right tab first. They are told apart by shape, and both are
   * consumed on use — the TOTP step is recorded, the recovery code is spent.
   */
  async verifySecondFactor(userId: string, tenantId: string, code: string): Promise<void> {
    const db = getSystemDb();

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user?.totpEnabledAt || !user.totpSecret) {
      // The challenge said this account has 2FA. If it does not, something has
      // changed underneath (an admin reset it mid-login) — do not quietly let
      // them in on a ticket for a check that no longer exists.
      throw new UnauthorizedException(t()("errors.mfa.notEnabled"));
    }

    await this.throttle(userId);

    const accepted = await this.consumeSecondFactor(user, code);
    if (!accepted) {
      this.events.record("auth.mfa_failed", { userId, tenantId });
      throw new UnauthorizedException(t()("errors.mfa.invalidCode"));
    }

    await this.clearThrottle(userId);
  }

  /**
   * Accepts a TOTP code or spends a recovery code, and returns whether either
   * worked. Every path through here consumes what it accepted — nothing is
   * accepted twice.
   */
  private async consumeSecondFactor(
    user: { id: string; totpSecret: string | null; totpLastStep: bigint | null },
    code: string,
  ): Promise<boolean> {
    const db = getSystemDb();
    const cleaned = code.trim();

    if (/^\d{6}$/.test(cleaned)) {
      if (!user.totpSecret) return false;

      const step = verifyCode(decryptSecret(user.totpSecret, this.key()), cleaned, {
        after: user.totpLastStep === null ? null : Number(user.totpLastStep),
      });
      if (step === null) return false;

      // Burn the step. `totpLastStep < step` makes this idempotent under a race:
      // two requests presenting the same code, one wins the update, the other
      // updates zero rows — and zero rows is a replay.
      const consumed = await db.user.updateMany({
        where: {
          id: user.id,
          OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }],
        },
        data: { totpLastStep: BigInt(step) },
      });
      return consumed.count === 1;
    }

    // A recovery code. Spent by the same trick: the update is filtered on
    // `usedAt: null`, so exactly one of two concurrent attempts can win it.
    const spent = await db.recoveryCode.updateMany({
      where: { userId: user.id, codeHash: hashCode(cleaned), usedAt: null },
      data: { usedAt: new Date() },
    });
    return spent.count === 1;
  }

  // -------------------------------------------------------------------------
  // Throttling
  // -------------------------------------------------------------------------

  /** Counts a failed attempt window. Throws 403 once the budget is gone. */
  private async throttle(userId: string): Promise<void> {
    const key = `mfa:attempts:${userId}`;

    let attempts: number;
    try {
      attempts = await this.redis.incr(key);
      if (attempts === 1) await this.redis.expire(key, MFA_WINDOW_SECONDS);
    } catch (err) {
      // Fails CLOSED — see the note at the top. There is no second gate behind
      // this one, so a limiter that cannot count must refuse rather than wave
      // through an unbounded guessing session against a six-digit code.
      this.logger.error(
        `MFA throttle unavailable (${(err as Error).message}) — refusing the attempt. ` +
          `A rate limiter that cannot count cannot protect a six-digit secret.`,
      );
      throw new ForbiddenException(t()("errors.mfa.throttleUnavailable"));
    }

    if (attempts > MFA_MAX_ATTEMPTS) {
      this.events.record("auth.mfa_throttled", { userId, attempts });
      throw new ForbiddenException(t()("errors.mfa.tooManyAttempts"));
    }
  }

  /** A correct code clears the budget — the counter exists to bound guessing, not use. */
  private async clearThrottle(userId: string): Promise<void> {
    try {
      await this.redis.del(`mfa:attempts:${userId}`);
    } catch {
      // The window expires on its own. Nothing to do, and nothing worth failing for.
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Ten codes, 50 bits each, shown as `A3F9K-2M7QX`.
   *
   * Base32 without the ambiguous glyphs the alphabet already lacks (no 0/O, no
   * 1/I), because these get written on paper and read back by a human who is
   * already having a bad day.
   */
  private mintRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = base32Encode(randomBytes(7)).slice(0, 10);
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
  }

  private key(): Buffer {
    return readEncryptionKey(this.config.get<string>("TOTP_ENCRYPTION_KEY"));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Recovery codes are compared case- and hyphen-insensitively, so they are hashed
 * that way too. Normalising at the hash is what makes "a3f9k2m7qx" and
 * "A3F9K-2M7QX" the same code rather than two.
 */
function hashCode(code: string): string {
  const normalised = code.replace(/[\s-]/g, "").toUpperCase();
  return createHash("sha256").update(normalised).digest("hex");
}
