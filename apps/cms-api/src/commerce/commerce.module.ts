import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  CheckoutRequestSchema,
  CommerceSettingsSchema,
  ORDER_STATUSES,
  QuoteRequestSchema,
  UpdateOrderStatusSchema,
  type CommerceSettingsDto,
  type CreateOrderResultDto,
  type OrderDto,
  type OrderStatus,
  type OrderSummaryDto,
  type Paginated,
  type QuoteResultDto,
} from "@zcmsorg/schemas";
import { Actor, Internal, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import { RateLimit } from "../common/rate-limit.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CommerceService } from "./commerce.service";

/**
 * The storefront's public endpoints, reached by site-runtime on an anonymous
 * shopper's behalf. `@Internal("render")` is the same trust the AI chat runs at:
 * the visitor has no session, so the caller is site-runtime with its render token,
 * and every body is untrusted and rate-limited. Nothing here is authoritative
 * about money — see CommerceService.
 */
@Controller("commerce")
@UseGuards(RateLimitGuard)
export class CommerceStorefrontController {
  constructor(private readonly commerce: CommerceService) {}

  @Internal("render")
  @Post("quote")
  @RateLimit({ by: "ip", points: 60, windowSec: 60 })
  quote(
    @Query("hostname") hostname: string,
    @Body(new ZodValidationPipe(QuoteRequestSchema)) body: unknown,
  ): Promise<QuoteResultDto> {
    if (!hostname) throw new BadRequestException("hostname is required.");
    return this.commerce.quote(hostname, body as never);
  }

  @Internal("render")
  @Post("checkout")
  @RateLimit({ by: "ip", points: 15, windowSec: 60 })
  checkout(
    @Query("hostname") hostname: string,
    @Body(new ZodValidationPipe(CheckoutRequestSchema)) body: unknown,
  ): Promise<CreateOrderResultDto> {
    if (!hostname) throw new BadRequestException("hostname is required.");
    return this.commerce.createOrder(hostname, body as never);
  }

  @Internal("render")
  @Get("orders/:token")
  @RateLimit({ by: "ip", points: 60, windowSec: 60 })
  order(
    @Query("hostname") hostname: string,
    @Param("token") token: string,
  ): Promise<OrderDto> {
    if (!hostname) throw new BadRequestException("hostname is required.");
    return this.commerce.getOrderByToken(hostname, token);
  }
}

/** Order management for the admin. Site-scoped, permission-gated, session-authed. */
@Controller("orders")
@SiteScoped()
@UseGuards(RateLimitGuard)
export class OrdersController {
  constructor(private readonly commerce: CommerceService) {}

  @Get()
  @RequirePermissions("order:read")
  list(
    @SiteId() siteId: string,
    @Query("status") status?: string,
    @Query("q") search?: string,
    @Query("page") page?: string,
    @Query("perPage") perPage?: string,
  ): Promise<Paginated<OrderSummaryDto>> {
    const parsedStatus =
      status && (ORDER_STATUSES as readonly string[]).includes(status)
        ? (status as OrderStatus)
        : undefined;
    return this.commerce.listOrders(siteId, {
      status: parsedStatus,
      search: search?.trim() || undefined,
      page: Math.max(1, Number(page) || 1),
      perPage: Math.min(100, Math.max(1, Number(perPage) || 20)),
    });
  }

  @Get(":id")
  @RequirePermissions("order:read")
  get(@SiteId() siteId: string, @Param("id") id: string): Promise<OrderDto> {
    return this.commerce.getOrder(siteId, id);
  }

  @Patch(":id/status")
  @RequirePermissions("order:manage")
  updateStatus(
    @SiteId() siteId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateOrderStatusSchema)) body: { status: OrderStatus },
  ): Promise<OrderDto> {
    return this.commerce.updateStatus(siteId, id, body.status);
  }
}

/** The storefront configuration screen: currency, shipping, payment methods. */
@Controller("settings/commerce")
@SiteScoped()
@UseGuards(RateLimitGuard)
export class CommerceSettingsController {
  constructor(private readonly commerce: CommerceService) {}

  @Get()
  @RequirePermissions("order:read")
  read(@SiteId() siteId: string): Promise<CommerceSettingsDto> {
    return this.commerce.readSettingsDto(siteId);
  }

  @Put()
  @RequirePermissions("commerce:configure")
  save(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(CommerceSettingsSchema))
    body: Parameters<CommerceService["saveSettings"]>[2],
  ): Promise<CommerceSettingsDto> {
    return this.commerce.saveSettings(actor.tenantId, siteId, body);
  }
}

@Module({
  controllers: [
    CommerceStorefrontController,
    OrdersController,
    CommerceSettingsController,
  ],
  providers: [CommerceService],
  exports: [CommerceService],
})
export class CommerceModule {}
