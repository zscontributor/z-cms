import "dotenv/config";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import bcrypt from "bcryptjs";
import { getSystemDb, disconnectDb } from "../src/clients";
import { installCorePlugins } from "../src/core-plugins";

const db = getSystemDb();

// Passwords that must never protect an admin on a real instance. `??` in the old
// code only caught `undefined`, so the deploy default of SEED_ADMIN_PASSWORD=""
// slipped straight through and seeded an admin with an empty password.
const WEAK_SEED_PASSWORDS = new Set(["", "admin123", "password", "changeme", "admin"]);

function resolveSeedAdminPassword(): string {
  const provided = (process.env.SEED_ADMIN_PASSWORD ?? "").trim();
  if (process.env.NODE_ENV === "production") {
    if (!provided || WEAK_SEED_PASSWORDS.has(provided.toLowerCase())) {
      throw new Error(
        "Refusing to seed an admin with an empty or well-known password while " +
          "NODE_ENV=production. Set SEED_ADMIN_PASSWORD to a strong secret, or set " +
          "SEED_ON_DEPLOY=0 to skip seeding entirely.",
      );
    }
    return provided;
  }
  // Development convenience only: a fixed, obvious default outside production.
  return provided || "admin123";
}

async function upsertNormalContent(args: {
  siteId: string;
  locale: string;
  slug: string;
  update: Record<string, unknown>;
  create: Record<string, unknown>;
}) {
  const existing = await db.content.findFirst({
    where: {
      siteId: args.siteId,
      locale: args.locale,
      slug: args.slug,
      demoThemeKey: null,
    },
  });

  if (existing) {
    return db.content.update({
      where: { id: existing.id },
      data: args.update as never,
    });
  }

  return db.content.create({ data: args.create as never });
}

async function upsertNormalMenu(args: {
  tenantId: string;
  siteId: string;
  key: string;
  name: string;
}) {
  const existing = await db.menu.findFirst({
    where: { siteId: args.siteId, key: args.key, demoThemeKey: null },
  });

  if (existing) return existing;

  return db.menu.create({
    data: {
      tenantId: args.tenantId,
      siteId: args.siteId,
      key: args.key,
      name: args.name,
      demoThemeKey: null,
    },
  });
}

async function main() {
  console.log("Seeding Z-CMS…");

  // The default theme's catalogue row comes from `seed:themes`, which reads it out of
  // the SIGNED package. It is not written here.
  //
  // It used to be — a hand-copied `theme.upsert` with the manifest transcribed inline,
  // under a comment promising that "the two must not drift". They had: this said
  // version 0.1.0 while the theme itself was on 1.2.0, and the settingsSchema had not
  // been touched in either direction. A manifest maintained in two places is a
  // manifest maintained in neither, and this is the copy that lost, because the other
  // one is the one a signature covers.
  const theme = await db.theme.findUnique({ where: { key: "vn.zsoft.theme.default" } });
  const themeVersion = theme
    ? await db.themeVersion.findFirst({
        where: { themeId: theme.id },
        orderBy: { createdAt: "desc" },
      })
    : null;

  if (!theme || !themeVersion) {
    throw new Error(
      "The default theme is not in the catalogue. Sign and register the built-ins first:\n" +
        "  pnpm sign:builtins && pnpm seed:builtins",
    );
  }

  const tenant = await db.tenant.upsert({
    where: { slug: "zsoft" },
    update: {},
    create: { slug: "zsoft", name: "Z-SOFT Co., Ltd" },
  });

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@z-cms.org";
  const adminPassword = resolveSeedAdminPassword();
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const owner = await db.user.upsert({
    where: { email: adminEmail },
    // Re-seeding with SEED_ADMIN_PASSWORD set resets the admin password, so an
    // instance seeded before the env was wired up can be repaired by re-running.
    update: process.env.SEED_ADMIN_PASSWORD ? { passwordHash } : {},
    create: {
      tenantId: tenant.id,
      email: adminEmail,
      passwordHash,
      name: "Z-SOFT Admin",
    },
  });

  const site = await db.site.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "main" } },
    update: {},
    create: {
      tenantId: tenant.id,
      slug: "main",
      name: "Z-SOFT Website",
      status: "PUBLISHED",
      defaultLocale: "en",
      locales: ["en", "vi", "ja"],
    },
  });

  // A tenant-wide OWNER: siteId NULL means the role covers every site.
  // Cannot use upsert() here — Prisma refuses to target NULL in a compound
  // unique, because SQL would not match on it anyway.
  const existingOwnerRole = await db.membership.findFirst({
    where: { userId: owner.id, siteId: null },
  });
  if (!existingOwnerRole) {
    await db.membership.create({
      data: { tenantId: tenant.id, userId: owner.id, siteId: null, role: "OWNER" },
    });
  }

  await db.domain.upsert({
    where: { hostname: "localhost:3100" },
    update: {},
    create: {
      tenantId: tenant.id,
      siteId: site.id,
      hostname: "localhost:3100",
      isPrimary: true,
      verified: true,
    },
  });

  await db.siteTheme.upsert({
    where: { siteId_themeId: { siteId: site.id, themeId: theme.id } },
    // `versionId` on update too: without it, a site seeded before the theme was
    // re-signed stays pinned to whatever version it first got — the row said ACTIVE
    // and pointed at 0.1.0 while the theme had moved to 1.2.0, and re-running the
    // seed did not fix it, because "update the status" is not "update the version".
    update: { status: "ACTIVE", versionId: themeVersion.id },
    create: {
      tenantId: tenant.id,
      siteId: site.id,
      themeId: theme.id,
      versionId: themeVersion.id,
      status: "ACTIVE",
      settings: {
        primaryColor: "#FA5600",
        siteTitle: "Z-SOFT",
        tagline: "A multi-tenant CMS with themes and plugins",
        showSearch: true,
        footerText: "© 2026 Z-SOFT Co., Ltd",
      },
    },
  });

  // The built-in plugins, installed and switched OFF. The seeded site is the one a
  // developer opens first, so it should look like a real new site does — zAI present
  // in Plugins, waiting for someone to grant it and turn it on, rather than either
  // missing entirely or silently running with the network scope nobody approved.
  const corePlugins = await installCorePlugins(db, tenant.id, site.id);
  if (corePlugins.length > 0) {
    console.log(`  core plugins installed (INACTIVE): ${corePlugins.join(", ")}`);
  }

  const page = await db.contentType.upsert({
    where: { siteId_key: { siteId: site.id, key: "page" } },
    update: {},
    create: {
      tenantId: tenant.id,
      siteId: site.id,
      key: "page",
      name: "Page",
      pluralName: "Pages",
      routePrefix: "",
      hasBlocks: true,
      icon: "file-text",
      fields: [],
    },
  });

  const post = await db.contentType.upsert({
    where: { siteId_key: { siteId: site.id, key: "post" } },
    update: {},
    create: {
      tenantId: tenant.id,
      siteId: site.id,
      key: "post",
      name: "Post",
      pluralName: "Posts",
      routePrefix: "blog",
      hasBlocks: true,
      icon: "newspaper",
      fields: [
        { key: "coverImage", type: "media", label: "Cover image", required: false },
        { key: "readingTime", type: "number", label: "Reading time (minutes)", required: false },
      ],
    },
  });

  // Translation groups.
  //
  // Fixed ids so the seed is idempotent: re-running it must not fork a page into
  // two groups and quietly break the link between its languages.
  //
  // Each page below is seeded three times — English, Vietnamese and Japanese —
  // sharing a group. The translated slugs are deliberately *different*: "/about" is
  // "/vi/gioi-thieu" and "/ja/gaiyou", not "/vi/about". That is the point of the
  // group: a translated URL that still reads as English is not a translated URL, and
  // nothing in the router depends on the slugs matching. Three published siblings in
  // a group is also what makes the theme's language switcher appear — it renders only
  // when `ctx.alternates` has more than one entry, one per locale the page exists in.
  const GROUP = {
    home: "0e9c1b6a-0000-4000-8000-000000000001",
    about: "0e9c1b6a-0000-4000-8000-000000000002",
    hello: "0e9c1b6a-0000-4000-8000-000000000003",
  } as const;

  // The homepage is the empty slug — site-runtime resolves "/" to it.
  await upsertNormalContent({
    siteId: site.id,
    locale: "en",
    slug: "",
    update: { translationGroupId: GROUP.home },
    create: {
      translationGroupId: GROUP.home,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: page.id,
      locale: "en",
      slug: "",
      title: "Home",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      seo: { title: "Z-SOFT — the CMS platform", description: "Z-CMS demo." },
      blocks: [
        {
          id: "hero-1",
          type: "core/hero",
          props: {
            heading: "Z-CMS",
            subheading: "A multi-tenant CMS with a theme and plugin marketplace",
            ctaLabel: "Read the blog",
            ctaHref: "/blog",
          },
        },
        {
          id: "rich-1",
          type: "core/richtext",
          props: {
            html: "<p>This page is rendered by the <strong>default theme</strong> from data served by the CMS API. Every block on it is stored as JSON in Postgres.</p>",
          },
        },
        {
          id: "features-1",
          type: "core/features",
          props: {
            heading: "Architecture",
            items: [
              { title: "Multi-tenant", body: "Data is isolated by Postgres row-level security." },
              { title: "Theme engine", body: "A theme is a standalone package described by a manifest." },
              { title: "Plugin sandbox", body: "Marketplace plugins run outside the core process." },
            ],
          },
        },
      ],
    },
  });

  await upsertNormalContent({
    siteId: site.id,
    locale: "en",
    slug: "about",
    update: { translationGroupId: GROUP.about },
    create: {
      translationGroupId: GROUP.about,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: page.id,
      locale: "en",
      slug: "about",
      title: "About",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      blocks: [
        {
          id: "rich-2",
          type: "core/richtext",
          props: { html: "<p>Z-SOFT Co., Ltd — the company behind Z-CMS.</p>" },
        },
      ],
    },
  });

  await upsertNormalContent({
    siteId: site.id,
    locale: "en",
    slug: "hello-world",
    update: { translationGroupId: GROUP.hello },
    create: {
      translationGroupId: GROUP.hello,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: post.id,
      locale: "en",
      slug: "hello-world",
      title: "Hello world",
      excerpt: "A sample post that exercises the /blog/:slug route and the archive.",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      data: { readingTime: 3 },
      blocks: [
        {
          id: "rich-3",
          type: "core/richtext",
          props: {
            html: "<p>A sample post. The theme decides how this is displayed; the CMS only supplies the data.</p>",
          },
        },
      ],
    },
  });

  // ---------------------------------------------------------------------------
  // The same three pages, in Vietnamese.
  //
  // The site's default locale is English, so these are served under /vi:
  //
  //   /               <->  /vi
  //   /about          <->  /vi/gioi-thieu       (a different slug, on purpose)
  //   /blog/hello-world <-> /vi/blog/xin-chao
  //
  // Note "about" and "gioi-thieu" are one page. Nothing derives one URL from the
  // other — they are the same page because they share a translation group, which
  // is exactly what lets a Vietnamese URL be Vietnamese.
  // ---------------------------------------------------------------------------

  await upsertNormalContent({
    siteId: site.id,
    locale: "vi",
    slug: "",
    update: { translationGroupId: GROUP.home },
    create: {
      translationGroupId: GROUP.home,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: page.id,
      locale: "vi",
      slug: "",
      title: "Trang chủ",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      seo: { title: "Z-SOFT — nền tảng CMS", description: "Bản demo Z-CMS." },
      blocks: [
        {
          id: "hero-1-vi",
          type: "core/hero",
          props: {
            heading: "Z-CMS",
            subheading: "Nền tảng CMS đa tổ chức, có chợ giao diện và tiện ích mở rộng",
            ctaLabel: "Đọc blog",
            ctaHref: "/blog",
          },
        },
        {
          id: "rich-1-vi",
          type: "core/richtext",
          props: {
            html: "<p>Trang này do <strong>giao diện mặc định</strong> dựng nên từ dữ liệu của CMS API. Mọi khối trên trang đều được lưu dưới dạng JSON trong Postgres.</p>",
          },
        },
        {
          id: "features-1-vi",
          type: "core/features",
          props: {
            heading: "Kiến trúc",
            items: [
              { title: "Đa tổ chức", body: "Dữ liệu được cô lập bằng row-level security của Postgres." },
              { title: "Bộ máy giao diện", body: "Một giao diện là một gói độc lập, mô tả bằng manifest." },
              { title: "Hộp cát tiện ích", body: "Tiện ích từ chợ chạy ngoài tiến trình lõi." },
            ],
          },
        },
      ],
    },
  });

  await upsertNormalContent({
    siteId: site.id,
    locale: "vi",
    slug: "gioi-thieu",
    update: { translationGroupId: GROUP.about },
    create: {
      translationGroupId: GROUP.about,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: page.id,
      locale: "vi",
      slug: "gioi-thieu",
      title: "Giới thiệu",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      blocks: [
        {
          id: "rich-2-vi",
          type: "core/richtext",
          props: { html: "<p>Công ty TNHH Z-SOFT — đơn vị phát triển Z-CMS.</p>" },
        },
      ],
    },
  });

  await upsertNormalContent({
    siteId: site.id,
    locale: "vi",
    slug: "xin-chao",
    update: { translationGroupId: GROUP.hello },
    create: {
      translationGroupId: GROUP.hello,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: post.id,
      locale: "vi",
      slug: "xin-chao",
      title: "Xin chào",
      excerpt: "Bài viết mẫu, dùng để thử route /blog/:slug và trang danh sách.",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      data: { readingTime: 3 },
      blocks: [
        {
          id: "rich-3-vi",
          type: "core/richtext",
          props: {
            html: "<p>Bài viết mẫu. Giao diện quyết định cách hiển thị; CMS chỉ cung cấp dữ liệu.</p>",
          },
        },
      ],
    },
  });

  // ---------------------------------------------------------------------------
  // The same three pages, in Japanese.
  //
  // Served under /ja, again with slugs that read as the language rather than as
  // English:
  //
  //   /               <->  /ja
  //   /about          <->  /ja/gaiyou
  //   /blog/hello-world <-> /ja/blog/konnichiwa
  //
  // Sharing the same translation groups as the English and Vietnamese pages, so all
  // three are one page in three languages and the switcher can move between them.
  // ---------------------------------------------------------------------------

  await upsertNormalContent({
    siteId: site.id,
    locale: "ja",
    slug: "",
    update: { translationGroupId: GROUP.home },
    create: {
      translationGroupId: GROUP.home,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: page.id,
      locale: "ja",
      slug: "",
      title: "ホーム",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      seo: { title: "Z-SOFT — CMS プラットフォーム", description: "Z-CMS のデモ。" },
      blocks: [
        {
          id: "hero-1-ja",
          type: "core/hero",
          props: {
            heading: "Z-CMS",
            subheading: "テーマとプラグインのマーケットプレイスを備えたマルチテナント CMS",
            ctaLabel: "ブログを読む",
            ctaHref: "/blog",
          },
        },
        {
          id: "rich-1-ja",
          type: "core/richtext",
          props: {
            html: "<p>このページは <strong>デフォルトテーマ</strong> が CMS API のデータから描画しています。ページ上のすべてのブロックは Postgres に JSON として保存されています。</p>",
          },
        },
        {
          id: "features-1-ja",
          type: "core/features",
          props: {
            heading: "アーキテクチャ",
            items: [
              { title: "マルチテナント", body: "データは Postgres の行単位セキュリティで分離されています。" },
              { title: "テーマエンジン", body: "テーマは manifest で記述された独立したパッケージです。" },
              { title: "プラグインサンドボックス", body: "マーケットプレイスのプラグインはコアプロセスの外で動作します。" },
            ],
          },
        },
      ],
    },
  });

  await upsertNormalContent({
    siteId: site.id,
    locale: "ja",
    slug: "gaiyou",
    update: { translationGroupId: GROUP.about },
    create: {
      translationGroupId: GROUP.about,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: page.id,
      locale: "ja",
      slug: "gaiyou",
      title: "概要",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      blocks: [
        {
          id: "rich-2-ja",
          type: "core/richtext",
          props: { html: "<p>Z-SOFT株式会社 — Z-CMS を開発している会社です。</p>" },
        },
      ],
    },
  });

  await upsertNormalContent({
    siteId: site.id,
    locale: "ja",
    slug: "konnichiwa",
    update: { translationGroupId: GROUP.hello },
    create: {
      translationGroupId: GROUP.hello,
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: post.id,
      locale: "ja",
      slug: "konnichiwa",
      title: "こんにちは",
      excerpt: "/blog/:slug ルートとアーカイブを試すためのサンプル記事です。",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId: owner.id,
      data: { readingTime: 3 },
      blocks: [
        {
          id: "rich-3-ja",
          type: "core/richtext",
          props: {
            html: "<p>サンプル記事です。表示方法はテーマが決め、CMS はデータのみを提供します。</p>",
          },
        },
      ],
    },
  });

  const menu = await upsertNormalMenu({
    tenantId: tenant.id,
    siteId: site.id,
    key: "primary",
    name: "Primary menu",
  });

  await db.menuItem.deleteMany({ where: { menuId: menu.id } });
  await db.menuItem.createMany({
    data: [
      { tenantId: tenant.id, menuId: menu.id, label: "Home", url: "/", order: 0 },
      { tenantId: tenant.id, menuId: menu.id, label: "About", url: "/about", order: 1 },
      { tenantId: tenant.id, menuId: menu.id, label: "Blog", url: "/blog", order: 2 },
    ],
  });

  console.log(`
Seed complete.

  Tenant   : ${tenant.name} (${tenant.slug})
  Site     : ${site.name} -> http://localhost:3100
  Admin    : ${adminEmail} / ${process.env.SEED_ADMIN_PASSWORD ? "(SEED_ADMIN_PASSWORD)" : adminPassword}
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
