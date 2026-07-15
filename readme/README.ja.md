# Z-CMS

[English](../README.md) | [Tiếng Việt](README.vi.md) | **日本語**

[![CI](https://github.com/zscontributor/z-cms/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zscontributor/z-cms/actions/workflows/ci.yml)
[![ライセンス: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)

Z-CMS は、テーマエンジンとプラグインマーケットプレイスを備えた
マルチテナント CMS です。使いやすいインターフェースの下には、第三者コードを
すべての権限で実行する単一プロセスのモノリスではなく、モダンな SaaS
プラットフォームがあります。

**1 つのコードベースで複数のサイトを運用。** 1 回の Z-CMS デプロイで、
ブランド、支店、顧客など複数の独立したサイトを運用できます。各サイトは
独自のドメイン、コンテンツ、テーマ、設定を持ちます。サイトごとにソースを
fork・clone する必要はありません。開発者は 1 つのコードベースとパイプラインを
保守し、修正や機能をすべてのサイトへ同時にリリースできます。

| 公開サイト | Core API | データベース | キャッシュ | ストレージ | 拡張機能 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Next.js | NestJS | PostgreSQL<br>Row-Level Security | Redis | S3 | 署名済みパッケージ<br>V8 isolate |

**[z-cms.org](https://z-cms.org)** · ドキュメント: **[docs.z-cms.org](https://docs.z-cms.org)** · テーマとプラグイン: **[marketplace.z-cms.org](https://marketplace.z-cms.org)**

システムを支える 3 つのセキュリティ特性：

- **テナント分離は PostgreSQL が強制**し、アプリケーションコードだけに依存しません。
- **プラグインは API プロセス内で実行されません**。データベース、ストレージ、
  セッション資格情報を持たない V8 isolate 内で実行されます。
- **署名され、改変されていないパッケージだけをインストール**できます。
  テーマとプラグインは import 前に固定された公開鍵で検証されます。

```bash
pnpm verify   # RLS、sandbox、パッケージ署名、失効、マルウェアスキャン、
              # プラグインテーブル所有権の攻撃テストを実行
```

---

## クイックスタート

**Node 22+**、**pnpm 10+**、**Docker** が必要です。コントリビューターは
Git hooks のシークレットスキャン用に
**[gitleaks](https://github.com/gitleaks/gitleaks#installing)** も必要です。

```bash
cp .env.example .env
pnpm install
pnpm bootstrap          # Docker の起動、migration、seed
```

必要なプロセスを起動します。

```bash
pnpm --filter @zcmsorg/cms-api dev         # http://localhost:4100/api/v1
pnpm --filter @zcmsorg/site-runtime dev    # http://localhost:3100
pnpm --filter @zcmsorg/admin-web dev       # http://localhost:3101
pnpm --filter @zcmsorg/plugin-runtime dev  # http://localhost:4200
pnpm --filter @zcmsorg/worker dev           # バックグラウンドジョブ
```

`http://localhost:3101` で **`admin@z-cms.org` / `admin123`** を使用して
ログインできます。
本番環境では admin-web を各サイトの同一オリジン配下の `/admin`
（例: `https://z-cms.org/admin`）に配置し、`admin.*` の別ホスト名は使いません。

> 開発環境のポートは 3100 / 3101 / 4100 です。`domains` テーブルの hostname は
> site-runtime のポート（`localhost:3100`）と一致させてください。

---

## 技術スタック

| レイヤー | 技術 | 役割 |
| --- | --- | --- |
| API | NestJS 11、Node 22、TypeScript 5.9 | API、認証、権限、ビジネスロジック |
| 公開サイト | Next.js 16、App Router、RSC | データとテーマによるサイト描画 |
| 管理画面 | Next.js 16、Tailwind 4 | コンテンツとシステムの管理 |
| データベース | PostgreSQL 17、Prisma 7 | 保存と RLS によるテナント分離 |
| キャッシュ | Redis 8 | レンダリングキャッシュとジョブキュー |
| オブジェクトストレージ | RustFS、S3 API | メディアとパッケージファイル |
| プラグイン sandbox | isolated-vm | V8 isolate 内でプラグインを実行 |
| コントラクト | Zod 4 | API とフロントエンドで共有する schema |
| Monorepo | Turborepo、pnpm workspace | workspace のビルドと管理 |

## リポジトリ構成

```text
apps/
  cms-api          NestJS API
  site-runtime     Next.js 公開サイト
  admin-web        管理画面
  plugin-runtime   プラグイン実行 sandbox
  worker           BullMQ バックグラウンドジョブ
packages/
  database         Prisma schema、migration、RLS
  schemas          共有 Zod コントラクト
  theme-sdk        テーマ開発用コントラクト
  plugin-sdk       プラグイン開発用コントラクト
  i18n             Core メッセージカタログ
  queue            ジョブ定義と producer
  package          パッケージ化、署名、検証、失効
  scanner          実行前のパッケージ解析
  cli              `zcms` CLI
themes/            組み込みテーマ
plugins/           リファレンスプラグイン
```

## 開発用コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm bootstrap` | Docker の起動、migration、seed |
| `pnpm dev` | 全アプリを watch モードで実行 |
| `pnpm build` | 全 package と app をビルド |
| `pnpm typecheck` | workspace 全体の TypeScript を検査 |
| `pnpm lint` | workspace 全体を lint |
| `pnpm test` | unit test と coverage 検査を実行 |
| `pnpm verify` | 攻撃テストとセキュリティゲートを実行 |
| `pnpm verify:auth` | 認証境界を end-to-end で検証 |
| `pnpm scan:secrets` | gitleaks で資格情報をスキャン |
| `pnpm openapi` | 実際の route から OpenAPI document を生成 |
| `pnpm infra:up` / `pnpm infra:down` | Docker stack の起動・停止 |

## アーキテクチャとセキュリティ

- `APP_DATABASE_URL` は owner role ではなく `zcms_app` role を指す必要が
  あります。owner role を使用すると PostgreSQL RLS によるテナント分離が
  無効になります。
- Redis の cache-version counter は eviction されてはいけません。
  `volatile-*` policy を使用し、`allkeys-lru` は使用しないでください。
- プラグインは、宣言され管理者に承認された capability のみに、短期間の
  scoped token を通じてアクセスできます。
- Runtime は、固定された `MARKETPLACE_PUBLIC_KEY` で署名を検証できる
  パッケージのみインストールします。

API ドキュメントは実際のコントラクトから生成されます。`cms-api` 起動後、
[localhost:4100/api/v1/docs](http://localhost:4100/api/v1/docs) で API を確認・実行できます。

## 国際化

**English が base locale** です。他の言語は key ごとに English へ fallback
するため、部分的な翻訳も安全に利用・merge できます。

- Core locale: `packages/i18n/src/locales/`
- Theme locale: `themes/<name>/src/locales/`

詳細は [packages/i18n/README.md](../packages/i18n/README.md) および
[docs/i18n.md](../docs/i18n.md) を参照してください。

## ドキュメント

- [API](../docs/api.md)
- [アーキテクチャ](../docs/architecture.md)
- [プラグインと sandbox](../docs/plugins.md)
- [セキュリティ](../docs/security.md)
- [パッケージ配布](../docs/distribution.md)
- [国際化](../docs/i18n.md)
- [バックグラウンドジョブ](../docs/jobs.md)
- [テスト](../docs/testing.md)

## コントリビューション

すべてのコントリビューションを歓迎します。特に翻訳は参加しやすい領域です。
Pull request を作成する前に以下を実行してください。

```bash
pnpm typecheck
pnpm build
pnpm verify                          # database、sandbox、package の変更時
pnpm --filter @zcmsorg/i18n check      # message の変更時
```

詳しい手順は [CONTRIBUTING.md](../CONTRIBUTING.md)、行動規範は
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)、脆弱性の報告方法は
[SECURITY.md](../SECURITY.md) を参照してください。セキュリティ脆弱性を
公開 issue として報告しないでください。

## 連絡先

| | |
| --- | --- |
| プロジェクト | [z-cms.org](https://z-cms.org) |
| ドキュメント | [docs.z-cms.org](https://docs.z-cms.org) |
| Marketplace | [marketplace.z-cms.org](https://marketplace.z-cms.org) |
| サポート | **support@z-cms.org** |
| セキュリティ脆弱性 | **support@z-cms.org** — 最初に非公開でご連絡ください |

## ライセンス

[MIT](../LICENSE) © 2026 Z-SOFT Co., Ltd.
