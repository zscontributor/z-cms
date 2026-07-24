import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The interceptor that opens the tenant-scoped DB transaction for a request.
 *
 * The security claim being tested is narrow but load-bearing: the tenant comes
 * from the AUTHENTICATED PRINCIPAL (`req.actor`, set by AuthGuard from the token)
 * and from nowhere else. A client that stuffs `x-tenant-id` or a `tenantId` body
 * field for another tenant must not have it honoured — that would be a
 * cross-tenant read/write, the worst bug a multi-tenant CMS can have.
 *
 * `withTenant` is mocked so we can see exactly which tenant it is opened for.
 */

const withTenantMock = vi.hoisted(() => vi.fn());
vi.mock("@zcmsorg/database", () => ({
  withTenant: (tenantId: string, fn: () => unknown) => withTenantMock(tenantId, fn),
}));

import { TenantInterceptor } from "../tenant.interceptor";

function contextFor(req: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe("TenantInterceptor", () => {
  let interceptor: TenantInterceptor;

  beforeEach(() => {
    interceptor = new TenantInterceptor();
    // By default, run the wrapped handler and report which tenant it opened.
    withTenantMock.mockReset();
    withTenantMock.mockImplementation(async (_tenantId: string, fn: () => unknown) => fn());
  });

  it("opens the transaction for the tenant on the authenticated actor", async () => {
    const req = { actor: { tenantId: "tenant-from-token" }, headers: {}, body: {} };

    await lastValueFrom(interceptor.intercept(contextFor(req), handlerReturning("ok")));

    expect(withTenantMock).toHaveBeenCalledWith("tenant-from-token", expect.any(Function));
  });

  it("ignores an x-tenant-id header that disagrees with the actor's tenant", async () => {
    // CROSS-TENANT BREACH attempt. The header names another tenant; the actor was
    // resolved from the token. Only the actor may decide the scope.
    const req = {
      actor: { tenantId: "my-tenant" },
      headers: { "x-tenant-id": "victim-tenant" },
      body: {},
    };

    await lastValueFrom(interceptor.intercept(contextFor(req), handlerReturning("ok")));

    expect(withTenantMock).toHaveBeenCalledWith("my-tenant", expect.any(Function));
    expect(withTenantMock).not.toHaveBeenCalledWith("victim-tenant", expect.anything());
  });

  it("ignores a tenantId planted in the request body", async () => {
    // Same attack through a different door.
    const req = {
      actor: { tenantId: "my-tenant" },
      headers: {},
      body: { tenantId: "victim-tenant" },
    };

    await lastValueFrom(interceptor.intercept(contextFor(req), handlerReturning("ok")));

    expect(withTenantMock).toHaveBeenCalledWith("my-tenant", expect.any(Function));
    expect(withTenantMock).not.toHaveBeenCalledWith("victim-tenant", expect.anything());
  });

  it("does not open a tenant scope for an unauthenticated request", async () => {
    // Public/internal routes have no actor; they open their own scope once they
    // know which tenant they serve. The interceptor must not invent one — least of
    // all one taken from a client header.
    const req = { headers: { "x-tenant-id": "anything" }, body: {} };

    const result = await lastValueFrom(
      interceptor.intercept(contextFor(req), handlerReturning("public-ok")),
    );

    expect(withTenantMock).not.toHaveBeenCalled();
    expect(result).toBe("public-ok");
  });

  it("rolls the request's writes back by surfacing a handler error through withTenant", async () => {
    // The transaction wraps the whole handler, so a throw must propagate (and, in
    // production, roll back). Here we just prove the error is not swallowed.
    withTenantMock.mockImplementation(async (_t: string, fn: () => unknown) => fn());
    const req = { actor: { tenantId: "tenant-1" }, headers: {}, body: {} };
    const boom: CallHandler = {
      handle: () => {
        throw new Error("handler failed");
      },
    };

    await expect(
      lastValueFrom(interceptor.intercept(contextFor(req), boom)),
    ).rejects.toThrow("handler failed");
  });
});
