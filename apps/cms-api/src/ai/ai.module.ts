import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Body,
  Query,
  UseGuards,
  ForbiddenException,
} from "@nestjs/common";
import fs from "node:fs/promises";
import path from "node:path";
import { db, getSystemDb } from "@zcmsorg/database";
import { CreateContentSchema, UpdateContentSchema, type Permission } from "@zcmsorg/schemas";
import { Actor, Internal, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import { RateLimit } from "../common/rate-limit.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import type { RequestActor } from "../common/request-context";
import { ContentsService } from "../contents/contents.service";
import { ContentsModule } from "../contents/contents.module";
import { PluginsService } from "../plugins/plugins.service";

/**
 * The AI capability, as core sees it.
 *
 * There used to be a `const ZAI_KEY = "vn.zsoft.plugin.zai"` here, and three
 * `fetch()` calls to OpenAI, Anthropic and Google below it. Core held the API keys,
 * core made the requests, and the "plugin" was a settings form with a capability
 * string on it — because a plugin had no way to reach the internet, so the only way
 * to ship an AI feature was to put it in core and hard-code the plugin's id.
 *
 * That is gone. The provider calls live in the plugin now, in the sandbox, going out
 * through `ctx.http` under the hosts its manifest declares. What is left here is the
 * part that is genuinely core's business: finding the site, sanitising the messages,
 * and — for the admin operator — deciding whether the actor may do what the model
 * just asked for.
 *
 * Note that no identifier in this file names zAI. Core asks for whichever plugin
 * provides `ai.assistant`; swapping zAI for a different AI plugin is now an install,
 * not a patch.
 */
const AI_CAPABILITY = "ai.assistant";
const ZCMS_DOC_FILES = [
  "api.md",
  "architecture.md",
  "distribution.md",
  "i18n.md",
  "jobs.md",
  "plugins.md",
  "security.md",
  "testing.md",
] as const;
let zcmsDocsCache: Promise<DocsContextRow[]> | undefined;

type ChatMessage = { role: "user" | "assistant"; content: string };
type ContentContextScope = "public" | "admin";

type ContextContentRow = {
  id: string;
  title: string;
  slug: string;
  locale: string;
  excerpt: string | null;
  data: unknown;
  blocks: unknown;
  seo: unknown;
  status: string;
  updatedAt: Date;
  contentType: { key: string; name: string; routePrefix: string };
};

type DocsContextRow = { title: string; source: string; text: string; score: number };

/** The plugin's answer to a `chat` call. */
interface ChatAnswer {
  answer: string;
  provider: string;
}

@Injectable()
export class AiService {
  constructor(
    private readonly contents: ContentsService,
    private readonly plugins: PluginsService,
  ) {}

  async chat(hostname: string, messages: ChatMessage[]): Promise<ChatAnswer> {
    const domain = await getSystemDb().domain.findUnique({
      where: { hostname: hostname.toLowerCase() },
      include: { site: true },
    });
    if (!domain || domain.site.status !== "PUBLISHED") {
      throw new NotFoundException("Site not found.");
    }

    const clean = this.sanitise(messages);
    const systemPrompt = await this.buildGroundedPrompt(
      domain.site.id,
      clean,
      "public",
      domain.hostname,
    );
    return this.ask(domain.site.tenantId, domain.site.id, clean, { systemPrompt });
  }

  async adminChat(
    actor: RequestActor,
    siteId: string,
    messages: ChatMessage[],
    confirmDestructive: boolean,
  ) {
    await this.requireContentManagement(actor.tenantId, siteId);

    const contentTypes = await db().contentType.findMany({
      where: { siteId, key: { in: ["page", "post", "blog"] } },
      select: { id: true, key: true, name: true, fields: true },
    });
    const clean = this.sanitise(messages);
    const siteContext = await this.buildGroundedPrompt(siteId, clean, "admin");

    const instruction = [
      "You are the Z-CMS admin content operator.",
      "Translate the admin request into exactly one JSON object and no markdown.",
      'Allowed actions: list, get, create, update, publish, unpublish, delete.',
      'Shape: {"action":"...","contentTypeKey?":"page|post|blog","id?":"uuid","query?":"text","input?":{...}}.',
      "For create input use title, slug, optional locale/excerpt/data/blocks/seo/status. Never invent an id.",
      "For update put only changed fields in input. Use list first when an id is unknown.",
      `Available content types: ${JSON.stringify(contentTypes)}.`,
      siteContext,
    ].join("\n");
    // requireCore: the admin operator turns the model's output into content CRUD
    // under the ACTOR's permissions. Letting any marketplace plugin that declared
    // `ai.assistant` drive that would be a privilege escalation dressed up as an
    // integration — so this one call, unlike the public chat, insists on the
    // platform's own plugin.
    const { answer, provider } = await this.ask(actor.tenantId, siteId, clean, {
      systemPrompt: instruction,
      requireCore: true,
    });

    const command = this.parseCommand(answer);
    const required = this.permissionFor(command.action);
    if (!actor.permissions.includes(required)) {
      throw new ForbiddenException(`Your account does not have ${required}.`);
    }
    if (command.action === "delete" && !confirmDestructive) {
      return {
        answer: `Xác nhận xóa nội dung ${command.id ?? "đã chọn"}? Thao tác này không thể hoàn tác.`,
        provider,
        confirmationRequired: true,
      };
    }

    const result = await this.executeCommand(actor, siteId, contentTypes, command);
    return { answer: this.describeResult(command.action, result), provider, result };
  }

  /**
   * Asks whichever plugin provides `ai.assistant` to answer, and waits for it.
   *
   * This is the whole provider layer now. Core does not know which model was used,
   * does not hold the API key, and does not open the socket — the plugin does the
   * first, the gateway holds the second, and cms-api's egress service does the
   * third. What comes back is text.
   */
  private async ask(
    tenantId: string,
    siteId: string,
    messages: ChatMessage[],
    options: { systemPrompt?: string; requireCore?: boolean } = {},
  ): Promise<ChatAnswer> {
    const result = (await this.plugins.callCapability(
      tenantId,
      siteId,
      AI_CAPABILITY,
      "chat",
      { messages, ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}) },
      { requireCore: options.requireCore },
    )) as ChatAnswer | null;

    if (!result?.answer) {
      throw new BadGatewayException("The AI provider returned an empty response.");
    }
    return result;
  }

  private async buildGroundedPrompt(
    siteId: string,
    messages: ChatMessage[],
    scope: ContentContextScope,
    hostname?: string,
  ): Promise<string> {
    const query = messages.at(-1)?.content ?? "";
    const [rows, docsRows] = await Promise.all([
      this.findRelevantContent(siteId, query, scope),
      this.shouldIncludeZcmsDocs(hostname, query) ? this.findRelevantDocs(query) : Promise.resolve([]),
    ]);
    const sourceRule = scope === "public"
      ? "Use only the public context below and the conversation. The context contains PUBLISHED site content only."
      : "Use only the admin-visible context below and the conversation. Do not reveal or act on data outside this site.";

    return [
      "You are zAI Assistant for this Z-CMS site.",
      "Product fact: if asked who authored, created, developed, owns, or maintains Z-CMS, answer that Z-CMS is by Z-SOFT Viet Nam (https://z-soft.com.vn). In Vietnamese, say Công ty Z-SOFT Việt Nam.",
      sourceRule,
      "When the answer depends on site facts, answer from the context. If the context does not contain the answer, say you do not have enough site data instead of inventing.",
      docsRows.length
        ? "For questions about Z-CMS itself, prefer the Z-CMS docs context below over generic knowledge."
        : "",
      "Answer in the user's language.",
      docsRows.length
        ? [
            "Z-CMS docs context:",
            docsRows.map((row, index) => this.formatDocsRow(row, index + 1)).join("\n\n"),
          ].join("\n")
        : "",
      "Site context:",
      rows.length
        ? rows.map((row, index) => this.formatContextRow(row, index + 1)).join("\n\n")
        : "(No matching site content was available for this question.)",
    ].filter(Boolean).join("\n");
  }

  private shouldIncludeZcmsDocs(hostname: string | undefined, query: string): boolean {
    const host = (hostname ?? "").toLowerCase();
    if (host !== "z-cms.org" && host !== "www.z-cms.org") return false;
    const q = query.toLowerCase();
    return /\bz-?cms\b|theme|plugin|api|sdk|security|sandbox|deploy|deployment|marketplace|i18n|translation|job|queue|test|architecture|package|docs|documentation|tài liệu|bảo mật|kiến trúc|triển khai/.test(q);
  }

  private async findRelevantContent(
    siteId: string,
    query: string,
    scope: ContentContextScope,
  ): Promise<ContextContentRow[]> {
    const terms = this.searchTerms(query);
    const activeTheme = await db().siteTheme.findFirst({
      where: { siteId, status: "ACTIVE" },
      select: { theme: { select: { key: true } } },
    });
    const demoScope = [{ demoThemeKey: null }, { demoThemeKey: activeTheme?.theme.key ?? "" }];
    const textFilters = terms.flatMap((term) => [
      { title: { contains: term, mode: "insensitive" as const } },
      { slug: { contains: term, mode: "insensitive" as const } },
      { excerpt: { contains: term, mode: "insensitive" as const } },
    ]);

    return db().content.findMany({
      where: {
        siteId,
        OR: demoScope,
        ...(scope === "public" ? { status: "PUBLISHED" as const } : {}),
        ...(textFilters.length ? { AND: [{ OR: textFilters }] } : {}),
      },
      select: {
        id: true,
        title: true,
        slug: true,
        locale: true,
        excerpt: true,
        data: true,
        blocks: true,
        seo: true,
        status: true,
        updatedAt: true,
        contentType: { select: { key: true, name: true, routePrefix: true } },
      },
      orderBy: scope === "public" ? { publishedAt: "desc" } : { updatedAt: "desc" },
      take: 8,
    });
  }

  private searchTerms(query: string): string[] {
    const words = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3);
    return [...new Set(words)].slice(0, 6);
  }

  private formatContextRow(row: ContextContentRow, index: number): string {
    const parts = [
      row.excerpt,
      this.extractText(row.data),
      this.extractText(row.blocks),
      this.extractText(row.seo),
    ].filter(Boolean);
    const routePrefix = row.contentType.routePrefix ? `/${row.contentType.routePrefix}` : "";
    const path = row.slug ? `${routePrefix}/${row.slug}` : routePrefix || "/";
    const body = parts.join("\n").replace(/\s+/g, " ").slice(0, 1_200);
    return [
      `[${index}] ${row.title}`,
      `id: ${row.id}`,
      `type: ${row.contentType.key}`,
      `status: ${row.status}`,
      `locale: ${row.locale}`,
      `path: ${path}`,
      `updatedAt: ${row.updatedAt.toISOString()}`,
      `content: ${body || "(no text content)"}`,
    ].join("\n");
  }

  private extractText(value: unknown): string {
    const strings: string[] = [];
    const visit = (item: unknown, depth: number) => {
      if (strings.join(" ").length > 2_000 || depth > 8 || item == null) return;
      if (typeof item === "string") {
        strings.push(item);
        return;
      }
      if (typeof item === "number" || typeof item === "boolean") {
        strings.push(String(item));
        return;
      }
      if (Array.isArray(item)) {
        for (const child of item) visit(child, depth + 1);
        return;
      }
      if (typeof item === "object") {
        for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
          if (["id", "contentTypeId", "authorId", "translationGroupId"].includes(key)) continue;
          visit(child, depth + 1);
        }
      }
    };
    visit(value, 0);
    return strings.join(" ").trim();
  }

  private async findRelevantDocs(query: string): Promise<DocsContextRow[]> {
    const docs = await this.loadZcmsDocs();
    const terms = this.searchTerms(query);
    if (!terms.length) return docs.slice(0, 5);

    return docs
      .map((row) => {
        const haystack = `${row.title}\n${row.text}`.toLowerCase();
        const score = terms.reduce((sum, term) => {
          const matches = haystack.match(new RegExp(escapeRegExp(term), "g"))?.length ?? 0;
          return sum + matches;
        }, 0);
        return { ...row, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  private async loadZcmsDocs(): Promise<DocsContextRow[]> {
    zcmsDocsCache ??= (async () => {
      const docsDir = await findDocsDir();
      const sections: DocsContextRow[] = [];

      await Promise.all(ZCMS_DOC_FILES.map(async (file) => {
        try {
          const raw = await fs.readFile(path.join(docsDir, file), "utf8");
          sections.push(...splitMarkdownDoc(file, raw));
        } catch {
          // A local API-only build can still answer from site content; production
          // images copy docs into /repo/docs so the default site gets docs grounding.
        }
      }));

      return sections;
    })();
    return zcmsDocsCache;
  }

  private formatDocsRow(row: DocsContextRow, index: number): string {
    return [
      `[D${index}] ${row.title}`,
      `source: ${row.source}`,
      `content: ${row.text.replace(/\s+/g, " ").slice(0, 1_400)}`,
    ].join("\n");
  }

  /**
   * The admin operator is gated on a setting the plugin declares but core enforces.
   *
   * `isCore` and `publisher` are platform-controlled catalogue columns — a
   * marketplace package cannot claim either — so this is an identity check, whereas
   * the capability string in a manifest is only a claim.
   */
  private async requireContentManagement(tenantId: string, siteId: string): Promise<void> {
    const install = await getSystemDb().sitePlugin.findFirst({
      where: {
        tenantId,
        siteId,
        status: "ACTIVE",
        plugin: { isCore: true, publisher: "Z-SOFT Co., Ltd" },
      },
      select: { settings: true },
    });

    const settings = (install?.settings ?? {}) as { contentManagementEnabled?: boolean };
    if (!install || settings.contentManagementEnabled !== true) {
      throw new ForbiddenException(
        "AI content management is disabled, or the trusted core AI plugin is not active.",
      );
    }
  }

  /** Trims the transcript to what a provider should see: recent, non-empty, user-last. */
  private sanitise(messages: ChatMessage[]): ChatMessage[] {
    const clean = (messages ?? [])
      .filter((item) => item && (item.role === "user" || item.role === "assistant"))
      .slice(-12)
      .map((item) => ({ role: item.role, content: String(item.content).trim().slice(0, 4_000) }))
      .filter((item) => item.content);

    if (!clean.length || clean.at(-1)?.role !== "user") {
      throw new BadRequestException("A user message is required.");
    }
    return clean;
  }

  private parseCommand(raw: string): { action: string; id?: string; contentTypeKey?: string; query?: string; input?: Record<string, unknown> } {
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      const value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const allowed = ["list", "get", "create", "update", "publish", "unpublish", "delete"];
      if (!allowed.includes(String(value.action))) throw new Error("Unsupported action");
      return {
        action: String(value.action),
        ...(typeof value.id === "string" ? { id: value.id } : {}),
        ...(typeof value.contentTypeKey === "string" ? { contentTypeKey: value.contentTypeKey } : {}),
        ...(typeof value.query === "string" ? { query: value.query } : {}),
        ...(value.input && typeof value.input === "object" ? { input: value.input as Record<string, unknown> } : {}),
      };
    } catch {
      throw new BadGatewayException("The AI provider did not return a valid content command.");
    }
  }

  private permissionFor(action: string): Permission {
    if (action === "create") return "content:create";
    if (action === "update") return "content:update";
    if (action === "delete") return "content:delete";
    if (action === "publish" || action === "unpublish") return "content:publish";
    return "content:read";
  }

  private async executeCommand(
    actor: RequestActor,
    siteId: string,
    types: Array<{ id: string; key: string }>,
    command: { action: string; id?: string; contentTypeKey?: string; query?: string; input?: Record<string, unknown> },
  ): Promise<unknown> {
    if (command.action === "list") {
      if (command.contentTypeKey && !types.some((item) => item.key === command.contentTypeKey)) {
        throw new BadRequestException("Only page, post, and blog content can be managed by zAI.");
      }
      const selected = command.contentTypeKey
        ? [command.contentTypeKey]
        : types.map((item) => item.key);
      const pages = await Promise.all(selected.map((contentTypeKey) =>
        this.contents.list(siteId, {
          contentTypeKey,
          search: command.query,
          page: 1,
          perPage: 20,
        }),
      ));
      return { items: pages.flatMap((page) => page.items), total: pages.reduce((sum, page) => sum + page.total, 0) };
    }
    if (!command.id && command.action !== "create") {
      throw new BadRequestException("The AI command requires a content id. Ask it to list matching content first.");
    }
    if (command.action !== "create") {
      const existing = await this.contents.findOne(siteId, command.id!);
      if (!types.some((item) => item.key === existing.contentType.key)) {
        throw new ForbiddenException("zAI may only manage page, post, and blog content.");
      }
      if (command.action === "get") return existing;
    }
    if (command.action === "create") {
      const type = types.find((item) => item.key === command.contentTypeKey);
      if (!type) throw new BadRequestException("The requested page/blog content type does not exist.");
      const input = CreateContentSchema.parse({ ...command.input, contentTypeId: type.id });
      return this.contents.create(actor, siteId, input);
    }
    if (command.action === "update") {
      return this.contents.update(actor, siteId, command.id!, UpdateContentSchema.parse(command.input ?? {}));
    }
    if (command.action === "publish") return this.contents.setPublished(actor, siteId, command.id!, true);
    if (command.action === "unpublish") return this.contents.setPublished(actor, siteId, command.id!, false);
    await this.contents.remove(actor, siteId, command.id!);
    return { id: command.id, deleted: true };
  }

  private describeResult(action: string, result: unknown): string {
    if (action === "list") {
      const items = (result as { items?: Array<{ id: string; title: string; status: string }> }).items ?? [];
      return items.length
        ? items.map((item) => `${item.title} — ${item.status} — ${item.id}`).join("\n")
        : "Không tìm thấy page/blog phù hợp.";
    }
    if (action === "delete") return "Đã xóa nội dung thành công.";
    const item = result as { title?: string; id?: string; status?: string };
    return `Đã ${action} thành công: ${item.title ?? item.id ?? "content"}${item.status ? ` (${item.status})` : ""}.`;
  }
}

function splitMarkdownDoc(file: string, raw: string): DocsContextRow[] {
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file;
  const chunks = raw
    .split(/\n(?=##\s+)/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return chunks.map((chunk, index) => {
    const heading = chunk.match(/^##\s+(.+)$/m)?.[1]?.trim();
    const sectionTitle = heading ? `${title} / ${heading}` : title;
    return {
      title: sectionTitle,
      source: `docs/${file}${heading ? `#${slugifyHeading(heading)}` : ""}`,
      text: stripMarkdown(chunk),
      score: index === 0 ? 1 : 0,
    };
  });
}

async function findDocsDir(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "docs"),
    path.resolve(process.cwd(), "../..", "docs"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "architecture.md"));
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  return candidates[0]!;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

@Controller("ai")
@UseGuards(RateLimitGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Internal("render")
  @Post("chat")
  @RateLimit({ by: "ip", points: 20, windowSec: 60 })
  chat(
    @Query("hostname") hostname: string,
    @Body() body: { messages?: ChatMessage[] },
  ) {
    if (!hostname) throw new BadRequestException("hostname is required.");
    if (!Array.isArray(body.messages)) throw new BadRequestException("messages must be an array.");
    return this.ai.chat(hostname, body.messages);
  }

  @Post("admin/chat")
  @SiteScoped()
  @RequirePermissions("content:read")
  @RateLimit({ by: "ip", points: 30, windowSec: 60 })
  adminChat(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body() body: { messages?: ChatMessage[]; confirmDestructive?: boolean },
  ) {
    if (!Array.isArray(body.messages)) throw new BadRequestException("messages must be an array.");
    return this.ai.adminChat(actor, siteId, body.messages, body.confirmDestructive === true);
  }
}

/** Stable capability endpoint. Plugin keys stay an implementation detail. */
@Controller("integrations")
@UseGuards(RateLimitGuard)
export class IntegrationController {
  constructor(private readonly ai: AiService) {}

  @Internal("render")
  @Post(":capability/actions/:action")
  @RateLimit({ by: "ip", points: 20, windowSec: 60 })
  action(
    @Param("capability") capability: string,
    @Param("action") action: string,
    @Query("hostname") hostname: string,
    @Body() body: { messages?: ChatMessage[] },
  ) {
    if (capability !== "ai.assistant" || action !== "chat") {
      throw new NotFoundException("Integration action not found.");
    }
    if (!hostname) throw new BadRequestException("hostname is required.");
    if (!Array.isArray(body.messages)) throw new BadRequestException("messages must be an array.");
    return this.ai.chat(hostname, body.messages);
  }
}

@Module({
  imports: [ContentsModule],
  controllers: [AiController, IntegrationController],
  providers: [AiService],
})
export class AiModule {}
