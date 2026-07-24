import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MfaService } from "./mfa.service";
import { RevocationService } from "./revocation.service";
import { RateLimitGuard } from "../common/rate-limit.guard";

/**
 * Sessions: issuing them, rotating them, and ending them.
 *
 * These providers used to sit loose in AppModule, which was fine while nothing
 * but AuthGuard needed them. User management does: removing a user, demoting
 * them, or changing their password all have to *end their sessions*, and a
 * second RevocationService would mean a second Redis connection writing the same
 * denylist — working by coincidence rather than by design. Exported, there is one
 * of each.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, MfaService, RevocationService, RateLimitGuard],
  exports: [AuthService, MfaService, RevocationService, RateLimitGuard],
})
export class AuthModule {}
