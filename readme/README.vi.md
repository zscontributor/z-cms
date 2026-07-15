# Z-CMS

[English](../README.md) | **Tiếng Việt** | [日本語](README.ja.md)

[![CI](https://github.com/zscontributor/z-cms/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zscontributor/z-cms/actions/workflows/ci.yml)
[![Giấy phép: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)

Z-CMS là nền tảng CMS đa tenant với theme engine và marketplace dành cho plugin.
Giao diện thân thiện, nhưng bên dưới là một nền tảng SaaS hiện đại thay vì một ứng
dụng monolith chạy mã của bên thứ ba với toàn bộ đặc quyền của hệ thống.

**Một codebase, nhiều website.** Một bản triển khai Z-CMS có thể vận hành nhiều
website độc lập — thương hiệu, chi nhánh hoặc khách hàng — mỗi website có tên miền,
nội dung, theme và thiết lập riêng. Không cần fork hoặc clone mã nguồn cho từng
website. Developer duy trì một codebase và một pipeline; mọi bản sửa lỗi và tính
năng mới được triển khai đồng thời đến tất cả website.

| Website public | Core API | Database | Cache | Storage | Extension |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Next.js | NestJS | PostgreSQL<br>Row-Level Security | Redis | S3 | package có chữ ký<br>V8 isolate |

**[z-cms.org](https://z-cms.org)** · tài liệu: **[docs.z-cms.org](https://docs.z-cms.org)** · theme và plugin: **[marketplace.z-cms.org](https://marketplace.z-cms.org)**

Ba thuộc tính bảo mật cốt lõi của hệ thống:

- **PostgreSQL thực thi tenant isolation**, không phụ thuộc hoàn toàn vào application code.
- **Plugin không bao giờ chạy trong API process**; mã plugin chạy trong V8 isolate
  không có database, storage hoặc session credential.
- **Chỉ package đã ký và không bị thay đổi mới được cài đặt**; theme và plugin được
  xác minh bằng public key đã pin trước khi import.

```bash
pnpm verify   # chạy các bộ kiểm thử tấn công cho RLS, sandbox, chữ ký package,
              # revocation, malware scan và quyền sở hữu bảng của plugin
```

---

## Bắt đầu nhanh

Yêu cầu **Node 22+**, **pnpm 10+** và **Docker**. Contributor cũng cần
**[gitleaks](https://github.com/gitleaks/gitleaks#installing)** để chạy secret scan
trong Git hooks.

```bash
cp .env.example .env
pnpm install
pnpm bootstrap          # khởi động Docker, migrate và seed dữ liệu
```

Khởi động các process cần thiết:

```bash
pnpm --filter @zcmsorg/cms-api dev         # http://localhost:4100/api/v1
pnpm --filter @zcmsorg/site-runtime dev    # http://localhost:3100
pnpm --filter @zcmsorg/admin-web dev       # http://localhost:3101
pnpm --filter @zcmsorg/plugin-runtime dev  # http://localhost:4200
pnpm --filter @zcmsorg/worker dev           # xử lý background job
```

Đăng nhập tại `http://localhost:3101` bằng
**`admin@z-cms.org` / `admin123`**.
Production nên mount admin-web dưới origin của từng site tại `/admin`
(ví dụ `https://z-cms.org/admin`), không dùng hostname riêng kiểu `admin.*`.

> Trong môi trường development, các port là 3100 / 3101 / 4100. Hostname trong
> bảng `domains` phải khớp với port của site-runtime (`localhost:3100`).

---

## Công nghệ

| Layer | Công nghệ | Vai trò |
| --- | --- | --- |
| API | NestJS 11, Node 22, TypeScript 5.9 | API, auth, permission và business logic |
| Website public | Next.js 16, App Router, RSC | Render website theo dữ liệu và theme |
| Admin | Next.js 16, Tailwind 4 | Quản trị nội dung và hệ thống |
| Database | PostgreSQL 17, Prisma 7 | Lưu trữ và tenant isolation bằng RLS |
| Cache | Redis 8 | Cache render và background queue |
| Object storage | RustFS, S3 API | Media và file package |
| Plugin sandbox | isolated-vm | Chạy mã plugin trong V8 isolate |
| Contract | Zod 4 | Schema dùng chung giữa API và frontend |
| Monorepo | Turborepo, pnpm workspace | Build và quản lý workspace |

## Cấu trúc repository

```text
apps/
  cms-api          API NestJS
  site-runtime     website public dùng Next.js
  admin-web        giao diện quản trị
  plugin-runtime   sandbox chạy plugin
  worker           xử lý BullMQ background job
packages/
  database         Prisma schema, migration và RLS
  schemas          Zod contract dùng chung
  theme-sdk        contract để phát triển theme
  plugin-sdk       contract để phát triển plugin
  i18n             message catalogue của core
  queue            định nghĩa và producer của job
  package          đóng gói, ký, xác minh và thu hồi package
  scanner          phân tích package trước khi chạy
  cli              CLI `zcms`
themes/            các theme tích hợp sẵn
plugins/           các plugin tham chiếu
```

## Lệnh dành cho developer

| Lệnh | Chức năng |
| --- | --- |
| `pnpm bootstrap` | Khởi động Docker, migrate và seed cho bản clone mới |
| `pnpm dev` | Chạy tất cả app ở chế độ watch |
| `pnpm build` | Build toàn bộ package và app |
| `pnpm typecheck` | Kiểm tra TypeScript cho toàn workspace |
| `pnpm lint` | Chạy lint cho toàn workspace |
| `pnpm test` | Chạy unit test và kiểm tra coverage |
| `pnpm verify` | Chạy các bộ kiểm thử tấn công và security gate |
| `pnpm verify:auth` | Kiểm tra auth boundary end-to-end |
| `pnpm scan:secrets` | Quét credential bằng gitleaks |
| `pnpm openapi` | Sinh OpenAPI document từ route đang hoạt động |
| `pnpm infra:up` / `pnpm infra:down` | Khởi động hoặc dừng Docker stack |

## Kiến trúc và bảo mật

- `APP_DATABASE_URL` phải trỏ đến role `zcms_app`, không được trỏ đến owner role;
  nếu không, PostgreSQL RLS sẽ không còn bảo vệ tenant isolation.
- Redis cache-version counter không được phép bị eviction; hãy sử dụng policy
  `volatile-*`, không sử dụng `allkeys-lru`.
- Plugin chỉ được truy cập capability đã khai báo và được admin phê duyệt thông qua
  scoped token có thời hạn ngắn.
- Runtime chỉ cài package có chữ ký hợp lệ với `MARKETPLACE_PUBLIC_KEY` đã pin.

API tự sinh tài liệu OpenAPI từ contract thực tế. Sau khi khởi động `cms-api`, mở
[localhost:4100/api/v1/docs](http://localhost:4100/api/v1/docs) để xem và thử API.

## Quốc tế hóa

**English là base locale**. Mỗi ngôn ngữ khác fallback về English theo từng key,
vì vậy bản dịch chưa hoàn chỉnh vẫn có thể sử dụng và merge an toàn.

- Core locale: `packages/i18n/src/locales/`
- Theme locale: `themes/<name>/src/locales/`

Hướng dẫn chi tiết: [packages/i18n/README.md](../packages/i18n/README.md) và
[docs/i18n.md](../docs/i18n.md).

## Tài liệu

- [API](../docs/api.md)
- [Kiến trúc](../docs/architecture.md)
- [Plugin và sandbox](../docs/plugins.md)
- [Bảo mật](../docs/security.md)
- [Phân phối package](../docs/distribution.md)
- [Quốc tế hóa](../docs/i18n.md)
- [Background job](../docs/jobs.md)
- [Kiểm thử](../docs/testing.md)

## Đóng góp

Mọi đóng góp đều được chào đón, đặc biệt là bản dịch. Trước khi mở pull request:

```bash
pnpm typecheck
pnpm build
pnpm verify                          # khi thay đổi database, sandbox hoặc package
pnpm --filter @zcmsorg/i18n check      # khi thay đổi message
```

Xem quy trình đầy đủ tại [CONTRIBUTING.md](../CONTRIBUTING.md), quy tắc ứng xử tại
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md), và cách báo cáo lỗ hổng tại
[SECURITY.md](../SECURITY.md). Không tạo public issue cho lỗ hổng bảo mật.

## Liên hệ

| | |
| --- | --- |
| Dự án | [z-cms.org](https://z-cms.org) |
| Tài liệu | [docs.z-cms.org](https://docs.z-cms.org) |
| Marketplace | [marketplace.z-cms.org](https://marketplace.z-cms.org) |
| Hỗ trợ | **support@z-cms.org** |
| Lỗ hổng bảo mật | **support@z-cms.org** — vui lòng báo cáo riêng tư trước |

## Giấy phép

[MIT](../LICENSE) © 2026 Z-SOFT Co., Ltd.
