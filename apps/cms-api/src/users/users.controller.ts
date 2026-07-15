import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import {
  ChangePasswordSchema,
  CreateUserSchema,
  DisableTotpSchema,
  EnableTotpSchema,
  InviteUserSchema,
  RegenerateRecoveryCodesSchema,
  SetMembershipSchema,
  UpdateProfileSchema,
  type ChangePasswordInput,
  type CreateUserInput,
  type DisableTotpInput,
  type EnableTotpInput,
  type InvitationCreatedDto,
  type InvitationDto,
  type InviteUserInput,
  type RecoveryCodesDto,
  type RegenerateRecoveryCodesInput,
  type SetMembershipInput,
  type TotpSetupDto,
  type UpdateProfileInput,
  type UserDto,
  type UserCreatedDto,
} from "@zcmsorg/schemas";
import { Actor, RequirePermissions } from "../auth/decorators";
import { AuthService } from "../auth/auth.service";
import { MfaService } from "../auth/mfa.service";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  ApiAuthed,
  ApiNoContent,
  ApiNotFound,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import type { RequestActor } from "../common/request-context";
import { UsersService } from "./users.service";

/**
 * People, and what they may do.
 *
 * Not site-scoped. A person is a member of a *tenant* — possibly with different
 * roles on different sites — so a screen that could only ever show you the users
 * of whichever site you last clicked would be lying about who has access.
 *
 * Route order matters: `me` is declared before `:id`, or Express would happily
 * route GET /users/me into `findOne("me")` and answer 404 for the one user who
 * is definitely there.
 */
@ApiTags("Users")
@Controller("users")
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Everyone in your tenant",
    description:
      "With every role they hold and where. A membership with a null `siteId` " +
      "applies across the whole tenant.",
  })
  @ApiAuthed("user:read")
  @ApiZodResponse("UserDto", { isArray: true })
  @RequirePermissions("user:read")
  list(): Promise<UserDto[]> {
    return this.users.list();
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Create a user",
    description:
      "Creates the account immediately, grants the requested role, and queues a " +
      "notification email with the login link and temporary password. The user " +
      "can sign in as soon as this returns; no email activation step is required.",
  })
  @ApiAuthed("user:invite")
  @ApiZodBody("CreateUserInput")
  @ApiZodResponse("UserCreated", {
    status: 201,
    description: "The created user, the temporary password, login URL, and whether email was queued.",
  })
  @ApiZodResponse("Error", { status: 409, description: "That address already has an account." })
  @RequirePermissions("user:invite")
  create(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserInput,
  ): Promise<UserCreatedDto> {
    return this.users.create(actor, body);
  }

  // ---------------------------------------------------------------------------
  // The caller acting on themselves. No permission: a VIEWER who could not
  // change their own password would have to ask an admin to do it for them,
  // which is the opposite of what a password is.
  // ---------------------------------------------------------------------------

  @Patch("me")
  @ApiOperation({ summary: "Update your own profile" })
  @ApiAuthed()
  @ApiZodBody("UpdateProfileInput")
  @ApiZodResponse("UserDto")
  updateProfile(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) body: UpdateProfileInput,
  ): Promise<UserDto> {
    return this.users.updateProfile(actor, body);
  }

  @Post("me/password")
  @HttpCode(204)
  @ApiOperation({
    summary: "Change your own password",
    description:
      "Requires the current password — being signed in proves someone has the " +
      "laptop, not that they are the account holder. Succeeds by signing you out " +
      "of every session, this one included: a password change that leaves an " +
      "intruder's session alive has changed nothing.",
  })
  @ApiAuthed()
  @ApiZodBody("ChangePasswordInput")
  @ApiNoContent("Password changed. Every session, including this one, is now dead.")
  @ApiZodResponse("Error", { status: 401, description: "The current password is wrong." })
  async changePassword(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) body: ChangePasswordInput,
  ): Promise<void> {
    await this.auth.changePassword(actor.userId, actor.tenantId, body);
  }

  // ---------------------------------------------------------------------------
  // Two-factor authentication, on your own account.
  //
  // Under /users/me, not /auth: this is account management, and it needs a
  // session. /auth is where you go when you do not have one yet.
  // ---------------------------------------------------------------------------

  @Post("me/2fa/setup")
  @HttpCode(200)
  @ApiOperation({
    summary: "Begin enrolling an authenticator",
    description:
      "Mints a secret and parks it as *pending* — 2FA is NOT on yet. Scan " +
      "`otpauthUrl`, then prove it with `POST /users/me/2fa/enable`. The two " +
      "steps exist so that a secret which was generated but never actually " +
      "scanned cannot lock you out of your own account.",
  })
  @ApiAuthed()
  @ApiZodResponse("TotpSetup", { description: "The pending secret, and the URI a QR encodes." })
  @ApiZodResponse("Error", { status: 400, description: "2FA is already on. Disable it first." })
  setupTotp(@Actor() actor: RequestActor): Promise<TotpSetupDto> {
    return this.mfa.setup(actor.userId, actor.email);
  }

  @Post("me/2fa/enable")
  @HttpCode(200)
  @ApiOperation({
    summary: "Switch on the second factor",
    description:
      "Proves the authenticator holds the pending secret, then turns 2FA on and " +
      "returns the recovery codes — **once**. Only their hashes are stored, so " +
      "there is no endpoint that can show them again.",
  })
  @ApiAuthed()
  @ApiZodBody("EnableTotpInput")
  @ApiZodResponse("RecoveryCodes", { description: "Save these. They are not retrievable again." })
  @ApiZodResponse("Error", { status: 400, description: "No pending setup, or 2FA is already on." })
  @ApiZodResponse("Error", { status: 401, description: "That code is wrong." })
  enableTotp(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(EnableTotpSchema)) body: EnableTotpInput,
  ): Promise<RecoveryCodesDto> {
    return this.mfa.enable(actor.userId, actor.tenantId, body.code);
  }

  @Post("me/2fa/disable")
  @HttpCode(204)
  @ApiOperation({
    summary: "Switch off the second factor",
    description:
      "Takes the password AND a code. Either alone would be enough to strip the " +
      "very protection that exists because the other one can be stolen.",
  })
  @ApiAuthed()
  @ApiZodBody("DisableTotpInput")
  @ApiNoContent("2FA is off. The secret and every recovery code are gone.")
  @ApiZodResponse("Error", { status: 401, description: "Wrong password, or wrong code." })
  async disableTotp(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(DisableTotpSchema)) body: DisableTotpInput,
  ): Promise<void> {
    await this.mfa.disable(actor.userId, actor.tenantId, body);
  }

  @Post("me/2fa/recovery-codes")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reissue your recovery codes",
    description:
      "The old ones stop working the moment the new ones exist. Takes the " +
      "password: a set of recovery codes IS a way into the account, and handing " +
      "out a fresh one must be as hard as using one.",
  })
  @ApiAuthed()
  @ApiZodBody("RegenerateRecoveryCodesInput")
  @ApiZodResponse("RecoveryCodes", { description: "A fresh set. The previous set is dead." })
  @ApiZodResponse("Error", { status: 401, description: "Wrong password." })
  regenerateRecoveryCodes(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(RegenerateRecoveryCodesSchema))
    body: RegenerateRecoveryCodesInput,
  ): Promise<RecoveryCodesDto> {
    return this.mfa.regenerateRecoveryCodes(actor.userId, actor.tenantId, body.password);
  }

  // ---------------------------------------------------------------------------
  // Invitations
  // ---------------------------------------------------------------------------

  @Get("invitations")
  @ApiOperation({
    summary: "Invitations still awaiting an answer",
    description: "Accepted, withdrawn and expired ones are history, not work, and are not listed.",
  })
  @ApiAuthed("user:read")
  @ApiZodResponse("InvitationDto", { isArray: true })
  @RequirePermissions("user:read")
  listInvitations(): Promise<InvitationDto[]> {
    return this.users.listPendingInvitations();
  }

  @Post("invitations")
  @HttpCode(201)
  @ApiOperation({
    summary: "Invite someone",
    description:
      "Returns the invite token **once**. Only its hash is stored, so there is " +
      "no endpoint that can show it again — deliver the link now, or revoke and " +
      "invite afresh. You may not invite a role above your own, nor onto a site " +
      "you hold no role on.",
  })
  @ApiAuthed("user:invite")
  @ApiZodBody("InviteUserInput")
  @ApiZodResponse("InvitationCreated", {
    status: 201,
    description: "The invitation, and the raw token. The token is not retrievable again.",
  })
  @ApiZodResponse("Error", { status: 409, description: "That address already has an account, or a live invitation." })
  @RequirePermissions("user:invite")
  invite(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(InviteUserSchema)) body: InviteUserInput,
  ): Promise<InvitationCreatedDto> {
    return this.users.invite(actor, body);
  }

  @Delete("invitations/:id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Withdraw an invitation",
    description: "The link stops working. Already-accepted invitations cannot be withdrawn — remove the user instead.",
  })
  @ApiParam({ name: "id", description: "Invitation id." })
  @ApiAuthed("user:invite")
  @ApiNoContent("Withdrawn. The link is dead.")
  @ApiNotFound("No such invitation in this tenant.")
  @RequirePermissions("user:invite")
  async revokeInvitation(@Actor() actor: RequestActor, @Param("id") id: string): Promise<void> {
    await this.users.revokeInvitation(actor, id);
  }

  // ---------------------------------------------------------------------------
  // Managing other people
  // ---------------------------------------------------------------------------

  @Get(":id")
  @ApiOperation({ summary: "One user" })
  @ApiAuthed("user:read")
  @ApiZodResponse("UserDto")
  @ApiNotFound("No such user in this tenant.")
  @RequirePermissions("user:read")
  findOne(@Param("id") id: string): Promise<UserDto> {
    return this.users.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a user's profile fields" })
  @ApiParam({ name: "id", description: "User id." })
  @ApiAuthed("user:manage")
  @ApiZodBody("UpdateProfileInput")
  @ApiZodResponse("UserDto")
  @ApiNotFound("No such user in this tenant.")
  @RequirePermissions("user:manage")
  update(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) body: UpdateProfileInput,
  ): Promise<UserDto> {
    return this.users.update(actor, id, body);
  }

  @Patch(":id/membership")
  @ApiOperation({
    summary: "Set a user's role",
    description:
      "On one site, or across the tenant when `siteId` is null. Replaces any " +
      "role they already held at that scope rather than adding a second one. " +
      "A demotion signs them out everywhere.",
  })
  @ApiParam({ name: "id", description: "User id." })
  @ApiAuthed("user:manage")
  @ApiZodBody("SetMembershipInput")
  @ApiZodResponse("UserDto")
  @ApiNotFound("No such user in this tenant.")
  @RequirePermissions("user:manage")
  setMembership(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetMembershipSchema)) body: SetMembershipInput,
  ): Promise<UserDto> {
    return this.users.setMembership(actor, id, body);
  }

  @Delete(":id/memberships/:membershipId")
  @ApiOperation({
    summary: "Take away one role",
    description:
      "Revokes a user's role on a single site (or their tenant-wide one) without " +
      "removing the account. Signs them out, so the loss of access is immediate.",
  })
  @ApiParam({ name: "id", description: "User id." })
  @ApiParam({ name: "membershipId", description: "Membership id, from the user's `memberships`." })
  @ApiAuthed("user:manage")
  @ApiZodResponse("UserDto")
  @ApiNotFound("No such user, or no such membership on them.")
  @RequirePermissions("user:manage")
  removeMembership(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
    @Param("membershipId") membershipId: string,
  ): Promise<UserDto> {
    return this.users.removeMembership(actor, id, membershipId);
  }

  @Delete(":id/2fa")
  @HttpCode(204)
  @ApiOperation({
    summary: "Reset someone's second factor",
    description:
      "For the colleague whose phone is at the bottom of a river and whose " +
      "recovery codes are in a drawer they no longer have access to. The " +
      "alternative to this endpoint is an account nobody can ever reach again.\n\n" +
      "It is also, unavoidably, a **bypass**: whoever calls it can strip a " +
      "colleague's second factor and then need only their password. That is why " +
      "it needs `user:manage` (OWNER), why it raises a security event rather than " +
      "a quiet audit line, and why it signs the user out — so they are made to " +
      "sign in again and will see, immediately, that their 2FA is gone.",
  })
  @ApiParam({ name: "id", description: "User id." })
  @ApiAuthed("user:manage")
  @ApiNoContent("Their second factor is gone, and so are their sessions.")
  @ApiNotFound("No such user in this tenant.")
  @ApiZodResponse("Error", { status: 400, description: "That account has no second factor." })
  @RequirePermissions("user:manage")
  async resetTwoFactor(@Actor() actor: RequestActor, @Param("id") id: string): Promise<void> {
    await this.users.resetTwoFactor(actor, id);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Remove a user from the tenant",
    description:
      "Their content, uploads and audit trail survive them — an author leaving " +
      "has never been a reason to unpublish their work. Their sessions do not: " +
      "they are revoked before the account is deleted. The last OWNER cannot be " +
      "removed, because a tenant nobody can administer needs `psql` to fix.",
  })
  @ApiParam({ name: "id", description: "User id." })
  @ApiAuthed("user:manage")
  @ApiNoContent("Removed. Their content stays, authored by nobody.")
  @ApiNotFound("No such user in this tenant.")
  @RequirePermissions("user:manage")
  async remove(@Actor() actor: RequestActor, @Param("id") id: string): Promise<void> {
    await this.users.remove(actor, id);
  }
}
