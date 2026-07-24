import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Post,
  UseGuards,
  UsePipes,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  AcceptInviteSchema,
  LoginSchema,
  MfaVerifySchema,
  type AcceptInviteInput,
  type AuthResult,
  type LoginInput,
  type LoginResult,
  type MfaVerifyInput,
  type SessionUser,
} from "@zcmsorg/schemas";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RateLimit } from "../common/rate-limit.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import {
  ApiAuthed,
  ApiLoginResponse,
  ApiNoContent,
  ApiRateLimited,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import { RefreshTokenSchema as RefreshSchema } from "../openapi/registry";
import { AuthService } from "./auth.service";
import { Actor, Public } from "./decorators";
import type { RequestActor } from "../common/request-context";

@ApiTags("Auth")
@Controller("auth")
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Two independent budgets over 15 minutes: 5 per email, 30 per IP. They stop
   * different attacks — the email limit slows guessing one account, the IP limit
   * slows one host spraying many accounts — so they get different numbers rather
   * than sharing one.
   */
  @Public()
  @Post("login")
  @HttpCode(200)
  @ApiOperation({
    summary: "Exchange credentials for a token pair",
    description:
      "Rate limited twice over 15 minutes: 5 attempts per email, 30 per IP. " +
      "Wrong email and wrong password are the same 401 — the difference would " +
      "tell an attacker which addresses have accounts.",
  })
  @ApiZodBody("LoginInput")
  @ApiLoginResponse()
  @ApiZodResponse("Error", { status: 401, description: "Email or password is wrong." })
  @ApiRateLimited("Too many attempts for this email or from this IP.")
  @RateLimit(
    { by: "email", points: 5, windowSec: 900 },
    { by: "ip", points: 30, windowSec: 900 },
  )
  @UsePipes(new ZodValidationPipe(LoginSchema))
  login(
    @Body() body: LoginInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent?: string,
  ): Promise<LoginResult> {
    return this.auth.login(body, { ip, userAgent });
  }

  /**
   * The second step, for accounts with a second factor.
   *
   * Rate limited by IP here, and per-account inside MfaService — the two stop
   * different attacks. An IP budget slows one host; a per-account budget is what
   * actually protects a six-digit code from a distributed guessing run, because
   * the thing being guessed belongs to an account, not to a network.
   */
  @Public()
  @Post("mfa/verify")
  @HttpCode(200)
  @ApiOperation({
    summary: "Complete a login with a second factor",
    description:
      "Exchanges the `challengeToken` from `/auth/login` plus a six-digit code " +
      "(or a recovery code) for a real token pair. The challenge names the " +
      "account, so a code can only ever be tried against the account whose " +
      "password was just checked. Five wrong codes in fifteen minutes and the " +
      "account stops accepting them for the rest of the window.",
  })
  @ApiZodBody("MfaVerifyInput")
  @ApiZodResponse("AuthResult", { description: "Signed in. Store both tokens." })
  @ApiZodResponse("Error", {
    status: 401,
    description: "Wrong code, or the challenge has expired — sign in again.",
  })
  @ApiZodResponse("Error", {
    status: 403,
    description: "Too many wrong codes for this account. Wait out the window.",
  })
  @ApiRateLimited("Too many attempts from this IP.")
  @RateLimit({ by: "ip", points: 30, windowSec: 900 })
  @UsePipes(new ZodValidationPipe(MfaVerifySchema))
  verifyMfa(
    @Body() body: MfaVerifyInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent?: string,
  ): Promise<AuthResult> {
    return this.auth.verifyMfa(body, { ip, userAgent });
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  @ApiOperation({
    summary: "Rotate the token pair",
    description:
      "Returns a new access *and* refresh token; the one you sent is spent. " +
      "Presenting a spent token is how a stolen one announces itself, so it " +
      "revokes the entire rotation family rather than issuing a pair.",
  })
  @ApiZodBody("RefreshTokenInput")
  @ApiZodResponse("AuthResult", { description: "A fresh pair. Store both." })
  @ApiZodResponse("Error", { status: 401, description: "Unknown, expired, or already-spent refresh token." })
  @ApiRateLimited("Too many refreshes from this IP.")
  @RateLimit({ by: "ip", points: 60, windowSec: 900 })
  @UsePipes(new ZodValidationPipe(RefreshSchema))
  refresh(
    @Body() body: { refreshToken: string },
    @Ip() ip: string,
    @Headers("user-agent") userAgent?: string,
  ): Promise<AuthResult> {
    return this.auth.refresh(body.refreshToken, { ip, userAgent });
  }

  /**
   * Redeems an invitation into an account, and signs the new user straight in.
   *
   * Public, because the whole point of an invitation is that the person holding
   * it has no session yet. The token stands in for one: single-use, expiring,
   * matched by hash. Rate limited by IP — the token is 32 random bytes and will
   * not be guessed, but an endpoint that creates accounts should not also be a
   * free oracle for how fast this server can compute bcrypt.
   */
  @Public()
  @Post("accept-invite")
  @HttpCode(201)
  @ApiOperation({
    summary: "Accept an invitation",
    description:
      "Creates the account and returns a token pair — you are signed in. The " +
      "tenant, the site and the role all come from the stored invitation, never " +
      "from this body. An unknown, spent, withdrawn or expired token is one 400: " +
      "telling them apart would help someone with a list of guesses.",
  })
  @ApiZodBody("AcceptInviteInput")
  @ApiZodResponse("AuthResult", { status: 201, description: "Account created, and signed in." })
  @ApiZodResponse("Error", { status: 400, description: "The invitation is not usable." })
  @ApiZodResponse("Error", { status: 409, description: "That address already has an account." })
  @ApiRateLimited("Too many attempts from this IP.")
  @RateLimit({ by: "ip", points: 10, windowSec: 900 })
  @UsePipes(new ZodValidationPipe(AcceptInviteSchema))
  acceptInvite(
    @Body() body: AcceptInviteInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent?: string,
  ): Promise<AuthResult> {
    return this.auth.acceptInvite(body, { ip, userAgent });
  }

  /** Revokes the whole rotation family. Public: a valid session is not required. */
  @Public()
  @Post("logout")
  @HttpCode(204)
  @ApiOperation({
    summary: "End the session",
    description:
      "Revokes the whole rotation family, so access tokens already in flight " +
      "stop working too. Deliberately takes no session: logging out must work " +
      "even when the access token has expired.",
  })
  @ApiZodBody("RefreshTokenInput")
  @ApiNoContent("Session revoked. Unknown tokens are not an error.")
  async logout(@Body() body: { refreshToken: string }): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get("me")
  @ApiOperation({
    summary: "The signed-in user",
    description: "Identity, role, and the permissions that role grants — what the admin UI gates on.",
  })
  @ApiAuthed()
  @ApiZodResponse("SessionUser")
  me(@Actor() actor: RequestActor): Promise<SessionUser> {
    return this.auth.sessionUser(actor.userId, actor.tenantId);
  }
}
