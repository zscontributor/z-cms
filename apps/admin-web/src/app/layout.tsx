import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { LOCALES, messagesFor } from "@zcmsorg/i18n";
import { LocaleProvider } from "@/lib/i18n-provider";
import { getLocale, getT } from "@/lib/locale";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: {
      default: "Z-CMS Admin",
      template: "%s · Z-CMS",
    },
    description: t("admin.appDescription"),
  };
}

export const viewport: Viewport = {
  themeColor: "#FA5600",
};

/**
 * Runs before paint so a dark-mode user never sees a white flash. Kept as a
 * string literal rather than a component because it must be inline and blocking.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem("zcms-theme");
    var dark = stored ? stored === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();
`;

/**
 * The provider sits at the root, not in the admin shell: /login renders client
 * components too, and it is the one screen a user can reach before the shell
 * exists.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dir = LOCALES.find((entry) => entry.code === locale)?.dir ?? "ltr";

  // Resolved here, on the server, and handed to the client as data: the messages
  // for this one locale, English already folded in underneath. The alternative —
  // a client component importing the catalogue — ships every language Z-CMS has
  // ever merged to a user who reads one of them.
  const messages = messagesFor(locale);

  // Next stamps its OWN inline scripts with the CSP nonce automatically; a script
  // the app writes itself is not its business, so it has to be stamped here. The
  // nonce comes from middleware.ts via a request header. Without it the CSP
  // refuses this script and every dark-mode user gets a white flash.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-screen antialiased">
        <LocaleProvider locale={locale} messages={messages}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
