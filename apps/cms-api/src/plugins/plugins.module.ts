import { Global, Module } from "@nestjs/common";
import { PluginEgressService } from "./plugin-egress.service";
import { PluginGatewayController } from "./plugin-gateway.controller";
import { PluginTokenService } from "./plugin-token.service";
import { PluginsController } from "./plugins.controller";
import { PluginsService } from "./plugins.service";

// Global: ContentsService and RenderService both dispatch hooks, and neither
// should have to import a plugin module to publish a page.
@Global()
@Module({
  controllers: [PluginsController, PluginGatewayController],
  // PluginEgressService is deliberately NOT exported. The only caller that should
  // ever be able to make an outbound request on a plugin's behalf is the gateway,
  // which has a verified token in its hand.
  providers: [PluginsService, PluginTokenService, PluginEgressService],
  exports: [PluginsService, PluginTokenService],
})
export class PluginsModule {}
