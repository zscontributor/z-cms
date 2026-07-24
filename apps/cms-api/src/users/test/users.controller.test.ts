import { describe, expect, it, vi } from "vitest";
import { UsersController } from "../users.controller";
import type { RequestActor } from "../../common/request-context";

/**
 * The controller is a thin delegator, but two of its wirings are security-shaped:
 * a self-action must carry the caller's OWN id (never a path param), and a
 * password change must be delegated with the caller's real identity.
 */

const users = {
  list: vi.fn(),
  findOne: vi.fn(),
  updateProfile: vi.fn(),
  listPendingInvitations: vi.fn(),
  invite: vi.fn(),
  revokeInvitation: vi.fn().mockResolvedValue(undefined),
  setMembership: vi.fn(),
  removeMembership: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
};
const auth = { changePassword: vi.fn().mockResolvedValue(undefined) };
const mfa = {
  setup: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn().mockResolvedValue(undefined),
  regenerateRecoveryCodes: vi.fn(),
};

function makeController() {
  return new UsersController(users as any, auth as any, mfa as any);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "ADMIN",
  permissions: ["user:manage"],
  siteId: "s1",
};

describe("UsersController", () => {
  it("updates the profile of the caller, taken from the actor not the path", async () => {
    await makeController().updateProfile(actor, { name: "New" } as any);

    expect(users.updateProfile).toHaveBeenCalledWith(actor, { name: "New" });
  });

  it("changes the password using the caller's own id and tenant", async () => {
    // A password change keyed on anything the client sends would be a way to reset
    // another account. It is bound to the authenticated actor.
    await makeController().changePassword(actor, { currentPassword: "a", newPassword: "b" } as any);

    expect(auth.changePassword).toHaveBeenCalledWith("u1", "t1", {
      currentPassword: "a",
      newPassword: "b",
    });
  });

  it("delegates a role change with the acting user, target id and body", async () => {
    await makeController().setMembership(actor, "target", { role: "EDITOR", siteId: "s1" } as any);

    expect(users.setMembership).toHaveBeenCalledWith(actor, "target", {
      role: "EDITOR",
      siteId: "s1",
    });
  });

  it("delegates a user removal with the acting user and the target id", async () => {
    await makeController().remove(actor, "target");

    expect(users.remove).toHaveBeenCalledWith(actor, "target");
  });
});
