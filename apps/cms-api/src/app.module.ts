import {
  Controller,
  Get,
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import path from "node:path";
import { AuthGuard } from "./auth/auth.guard";
import { AiModule } from "./ai/ai.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { Public } from "./auth/decorators";
import { LocaleMiddleware } from "./common/i18n";
import { TenantInterceptor } from "./common/tenant.interceptor";
import { ContentTypesModule } from "./content-types/content-types.module";
import { ContentsModule } from "./contents/contents.module";
import { JobsModule } from "./jobs/jobs.module";
import { MailModule } from "./mail/mail.module";
import { MediaModule } from "./media/media.module";
import { MenusModule } from "./menus/menus.module";
import { MarketplaceModule } from "./marketplace/marketplace.module";
import { PackagesModule } from "./packages/packages.module";
import { SideloadModule } from "./sideload/sideload.module";
import { PluginsModule } from "./plugins/plugins.module";
import { QueueModule } from "./queue/queue.module";
import { RedisModule } from "./redis/redis.module";
import { RenderModule } from "./render/render.module";
import { SitesModule } from "./sites/sites.module";
import { ThemesModule } from "./themes/themes.module";
import { UsersModule } from "./users/users.module";

@ApiTags("Health")
@Controller()
class HealthController {
  @Public()
  @Get("health")
  @ApiOperation({ summary: "Liveness", description: "No auth. Answers as long as the process is up." })
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      properties: {
        status: { type: "string", example: "ok" },
        service: { type: "string", example: "cms-api" },
      },
    },
  })
  health() {
    return { status: "ok", service: "cms-api" };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // One .env at the repo root drives every workspace package, so the API and
      // the migrations can never disagree about which database they mean.
      envFilePath: [path.resolve(__dirname, "../../../.env")],
    }),
    JwtModule.register({ global: true }),
    RedisModule,
    AuditModule,
    AuthModule,
    AiModule,
    QueueModule,
    SitesModule,
    UsersModule,
    ContentTypesModule,
    ContentsModule,
    MediaModule,
    JobsModule,
    MenusModule,
    // Before PluginsModule: the gateway injects MailService so a plugin can queue
    // a send. Nest resolves @Global providers regardless of order, but the reading
    // order is the dependency order and it should stay that way.
    MailModule,
    PluginsModule,
    PackagesModule,
    MarketplaceModule,
    SideloadModule,
    ThemesModule,
    RenderModule,
  ],
  controllers: [HealthController],
  providers: [
    // Guard first: it decides *who* the caller is and puts the actor on the
    // request. The interceptor then opens the tenant transaction using that
    // actor's tenant, so by the time a controller runs, RLS is already active.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the public ones: an error from /auth/login is as
    // much a message a human reads as one from /contents.
    consumer.apply(LocaleMiddleware).forRoutes("*");
  }
}
