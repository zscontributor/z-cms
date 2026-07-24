import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { withTenant } from "@zcmsorg/database";
import { from, lastValueFrom, Observable } from "rxjs";
import type { AuthedRequest } from "./request-context";

/**
 * Opens the tenant-scoped database transaction for the whole request.
 *
 * Everything downstream — controller, services, repositories — runs inside
 * `withTenant()`, so `db()` resolves to a connection with `app.tenant_id` set
 * and Row-Level Security applied. No service has to remember to pass a tenant
 * id around, and none of them *can* reach another tenant's rows even if they
 * try.
 *
 * A side effect worth knowing: because the request body runs inside one
 * transaction, a handler that throws rolls back every write it made. That is
 * the behaviour we want for content operations, which are rarely single-row.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const tenantId = req.actor?.tenantId;

    // Public and internal routes (login, /render/resolve) have no actor. They
    // open their own tenant scope once they know which tenant they are serving.
    if (!tenantId) return next.handle();

    return from(withTenant(tenantId, () => lastValueFrom(next.handle())));
  }
}
