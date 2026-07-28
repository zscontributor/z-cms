/**
 * `zcms help`, in the language the author reads.
 *
 * The command SIGNATURES — every `zcms …` line, every flag — are English and stay
 * English, because they are the literal thing the author types; a translated flag
 * would be a flag that does not exist. What is translated is the PROSE around
 * them: what each command does, and why the workflow is shaped the way it is.
 *
 * Kept dependency-free and inline, like everything else in this CLI: a packaging
 * tool that lives next to a signing key does not pull an i18n framework in beside
 * it. Three strings and a resolver is the whole mechanism.
 *
 * Language is resolved, most specific first: an explicit `--lang`, then the
 * ZCMS_LANG env var, then the OS locale (LC_ALL/LC_MESSAGES/LANG), then English.
 * Only `help` output is localized — a build error or a checksum is the same in
 * every language, and translating them would only add surface for drift.
 */

export type Lang = "en" | "ja" | "vi";

/** Every spelling we accept for a language, folded to the code we use internally. */
const ALIASES: Record<string, Lang> = {
  en: "en",
  eng: "en",
  english: "en",
  ja: "ja",
  jp: "ja",
  jpn: "ja",
  japanese: "ja",
  vi: "vi",
  vn: "vi",
  vie: "vi",
  vietnamese: "vi",
};

/** A recognized language code, or undefined when the value names none we have. */
export function normalizeLang(value: string | undefined): Lang | undefined {
  if (!value) return undefined;
  return ALIASES[value.trim().toLowerCase()];
}

/** `--lang <code>` off the argv, if present and recognized. */
export function langFromArgv(argv: string[]): Lang | undefined {
  const i = argv.indexOf("--lang");
  return i >= 0 ? normalizeLang(argv[i + 1]) : undefined;
}

/**
 * The language the environment asks for, if any.
 *
 * ZCMS_LANG is explicit intent and wins. Failing that, a POSIX locale like
 * "ja_JP.UTF-8" carries the language in its first segment — "ja" — so the author
 * who has set their shell to Japanese gets Japanese without a flag. "C" and
 * "POSIX" name no human language and fall through to the default.
 */
export function langFromEnv(env: Record<string, string | undefined>): Lang | undefined {
  const explicit = normalizeLang(env.ZCMS_LANG);
  if (explicit) return explicit;

  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (!locale) return undefined;

  const [prefix] = locale.split(/[_.]/);
  return normalizeLang(prefix);
}

/** The language to print help in: --lang, then the environment, then English. */
export function resolveLang(
  argv: string[],
  env: Record<string, string | undefined>,
): Lang {
  return langFromArgv(argv) ?? langFromEnv(env) ?? "en";
}

// ---------------------------------------------------------------------------
// The help text, per language. The `zcms …` signature lines are identical across
// all three by construction — help.test.ts asserts it — so a new flag has to be
// added in every language or the test fails.
// ---------------------------------------------------------------------------

const EN = `
zcms — the packaging tool for Z-CMS themes and plugins

  zcms init [<dir>] [--kind theme|plugin] [--id <reverse.dns.id>] [--name <name>]
            [--description <text>] [--author <name>] [--author-url <url>]
            [--version <semver>] [--yes]
      Scaffolds a new theme or plugin: manifest, source, build, test, README.
      Asks for anything it was not given. --yes never asks, and then --kind and
      --id are required.

  zcms keygen [--out <dir>]
      Generates the publisher's Ed25519 key pair.
      The private key must NEVER be committed or sent to anyone.

  zcms pack <dir> --kind theme|plugin --key <private.pem> --pub <public.pem> [--out <file>]
            [--bump patch|minor|major] [--no-bump] [--set-version <semver>]
      Packs a built directory into one signed .zcms file. It ships the version the
      manifest declares, then advances it (patch by default) so the NEXT pack is
      automatically a new version — pass --bump minor|major to advance further,
      --no-bump to leave the manifest as-is, or --set-version to ship an exact one.
      Add --operator-key <private.pem> to also stamp an operator signature for the
      sideload route (a self-hosted instance that pins the matching public key).

  zcms verify <file.zcms> [--marketplace-key <public.pem>]
      Checks a package. Without --marketplace-key only the publisher signature is
      checked (enough to check your own work before submitting, NOT enough to install).

  zcms help [--lang en|ja|vi]
      Shows this text. Also: zcms (no command), zcms -h, zcms -help, zcms --help.
      --lang picks the language (en=English, ja=Japanese, vi=Vietnamese; default en).
      It is also read from ZCMS_LANG, or from your shell locale (LANG).

  zcms version
      Prints the installed zcms version. Also: zcms --version, zcms -v.

Typical workflows
  Build a distributable .zcms (the file you upload or submit):
      zcms init ./my-theme --kind theme --id com.acme.theme.blog
      cd my-theme && npm install && npm run build   # produces dist/
      zcms keygen                                    # once — keep the private key safe
      zcms pack ./my-theme --kind theme --key keys/private.pem --pub keys/public.pem
      # -> com.acme.theme.blog-1.0.0.zcms

  Sideload it into your OWN self-hosted instance (no marketplace):
      zcms pack ./my-theme --kind theme --key op-private.pem --pub op-public.pem \\
        --operator-key op-private.pem
      # Upload the .zcms in Admin -> Appearance -> Install from file, then Approve.
      # The instance must pin OPERATOR_PUBLIC_KEY (= op-public.pem); for themes it
      # also needs ALLOW_THEME_SIDELOAD=true. See docs/distribution.md.
`;

const JA = `
zcms — Z-CMS のテーマとプラグインをパッケージ化するツール

  zcms init [<dir>] [--kind theme|plugin] [--id <reverse.dns.id>] [--name <name>]
            [--description <text>] [--author <name>] [--author-url <url>]
            [--version <semver>] [--yes]
      新しいテーマまたはプラグインの雛形を生成します（マニフェスト、ソース、ビルド、
      テスト、README）。指定されなかった項目は対話的に質問します。--yes は一切質問せず、
      その場合は --kind と --id が必須です。

  zcms keygen [--out <dir>]
      公開者の Ed25519 鍵ペアを生成します。
      秘密鍵は決してコミットしたり、誰かに送ったりしてはいけません。

  zcms pack <dir> --kind theme|plugin --key <private.pem> --pub <public.pem> [--out <file>]
            [--bump patch|minor|major] [--no-bump] [--set-version <semver>]
      ビルド済みのディレクトリを、署名付きの .zcms ファイル 1 つにまとめます。マニフェストに
      書かれたバージョンでパックし、その後バージョンを（既定では patch）1 つ進めるので、
      次回のパックは自動的に新しいバージョンになります。--bump minor|major でさらに進め、
      --no-bump でマニフェストをそのまま、--set-version で明示したバージョンでパックできます。
      --operator-key <private.pem> を付けると、サイドロード経路（対応する公開鍵を
      ピン留めした自己ホスト型インスタンス）向けのオペレーター署名も付与します。

  zcms verify <file.zcms> [--marketplace-key <public.pem>]
      パッケージを検証します。--marketplace-key がなければ公開者署名のみを検証します
      （提出前に自分の成果物を確認するには十分ですが、インストールには不十分です）。

  zcms help [--lang en|ja|vi]
      このヘルプを表示します。zcms（コマンドなし）、zcms -h、zcms -help、zcms --help も同様。
      --lang で言語を選べます（en=英語, ja=日本語, vi=ベトナム語。既定は en）。
      環境変数 ZCMS_LANG、またはシェルのロケール（LANG）からも判定します。

  zcms version
      インストールされている zcms のバージョンを表示します。zcms --version、zcms -v も同様。

代表的なワークフロー
  配布用の .zcms（アップロードまたは提出するファイル）を作成する:
      zcms init ./my-theme --kind theme --id com.acme.theme.blog
      cd my-theme && npm install && npm run build   # dist/ を生成
      zcms keygen                                    # 一度だけ — 秘密鍵は安全に保管
      zcms pack ./my-theme --kind theme --key keys/private.pem --pub keys/public.pem
      # -> com.acme.theme.blog-1.0.0.zcms

  自分の自己ホスト型インスタンスにサイドロードする（マーケットプレイス不要）:
      zcms pack ./my-theme --kind theme --key op-private.pem --pub op-public.pem \\
        --operator-key op-private.pem
      # 管理画面 -> Appearance -> Install from file で .zcms をアップロードし、Approve。
      # インスタンスは OPERATOR_PUBLIC_KEY（= op-public.pem）をピン留めする必要があります。
      # テーマの場合は ALLOW_THEME_SIDELOAD=true も必要です。docs/distribution.md を参照。
`;

const VI = `
zcms — công cụ đóng gói theme và plugin cho Z-CMS

  zcms init [<dir>] [--kind theme|plugin] [--id <reverse.dns.id>] [--name <name>]
            [--description <text>] [--author <name>] [--author-url <url>]
            [--version <semver>] [--yes]
      Tạo khung một theme hoặc plugin mới: manifest, mã nguồn, build, test, README.
      Hỏi những gì chưa được cung cấp. --yes sẽ không hỏi gì, khi đó bắt buộc phải có
      --kind và --id.

  zcms keygen [--out <dir>]
      Tạo cặp khóa Ed25519 của nhà phát hành.
      Khóa riêng TUYỆT ĐỐI không được commit hay gửi cho bất kỳ ai.

  zcms pack <dir> --kind theme|plugin --key <private.pem> --pub <public.pem> [--out <file>]
            [--bump patch|minor|major] [--no-bump] [--set-version <semver>]
      Đóng gói một thư mục đã build thành một file .zcms có chữ ký. Nó pack đúng version
      đang khai báo trong manifest, rồi tự tăng version đó (mặc định là patch) để lần pack
      SAU tự động là version mới — dùng --bump minor|major để tăng nhiều hơn, --no-bump để
      giữ nguyên manifest, hoặc --set-version để pack một version cụ thể.
      Thêm --operator-key <private.pem> để đóng thêm chữ ký operator cho luồng sideload
      (một instance tự vận hành có ghim khóa công khai tương ứng).

  zcms verify <file.zcms> [--marketplace-key <public.pem>]
      Kiểm tra một gói. Nếu không có --marketplace-key thì chỉ kiểm tra chữ ký nhà phát
      hành (đủ để tự kiểm tra trước khi gửi, KHÔNG đủ để cài đặt).

  zcms help [--lang en|ja|vi]
      Hiển thị nội dung này. Cũng như: zcms (không có lệnh), zcms -h, zcms -help, zcms --help.
      --lang chọn ngôn ngữ (en=Anh, ja=Nhật, vi=Việt; mặc định en).
      Cũng đọc từ biến môi trường ZCMS_LANG, hoặc từ locale của shell (LANG).

  zcms version
      In ra phiên bản zcms đang cài. Cũng như: zcms --version, zcms -v.

Các quy trình thường gặp
  Tạo file .zcms để phân phối (file bạn tải lên hoặc gửi đi):
      zcms init ./my-theme --kind theme --id com.acme.theme.blog
      cd my-theme && npm install && npm run build   # tạo ra dist/
      zcms keygen                                    # một lần — giữ khóa riêng an toàn
      zcms pack ./my-theme --kind theme --key keys/private.pem --pub keys/public.pem
      # -> com.acme.theme.blog-1.0.0.zcms

  Sideload vào instance tự vận hành CỦA BẠN (không cần marketplace):
      zcms pack ./my-theme --kind theme --key op-private.pem --pub op-public.pem \\
        --operator-key op-private.pem
      # Tải file .zcms trong Admin -> Appearance -> Install from file, rồi Approve.
      # Instance phải ghim OPERATOR_PUBLIC_KEY (= op-public.pem); với theme thì
      # cũng cần ALLOW_THEME_SIDELOAD=true. Xem docs/distribution.md.
`;

const USAGE: Record<Lang, string> = { en: EN, ja: JA, vi: VI };

/** The full help text in the given language. */
export function usage(lang: Lang = "en"): string {
  return USAGE[lang];
}

/**
 * The one-line "you typed a command that does not exist" message, localized.
 *
 * The command name is echoed back verbatim — a typo is easier to see next to the
 * thing that named it than buried in the usage text that follows.
 */
export function unknownCommand(command: string, lang: Lang = "en"): string {
  switch (lang) {
    case "ja":
      return `不明なコマンド "${command}"。zcms help を試してください。\n`;
    case "vi":
      return `Lệnh không hợp lệ "${command}". Hãy thử: zcms help\n`;
    default:
      return `Unknown command "${command}". Try: zcms help\n`;
  }
}
