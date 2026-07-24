import type { Metadata } from "next";
import { Logo } from "@/components/brand";
import { getT } from "@/lib/locale";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("auth.login.metaTitle") };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const t = await getT();
  const { next } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo size={40} />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t("auth.login.title")}</h1>
            <p className="mt-1 text-xs z-muted">{t("auth.login.subtitle")}</p>
          </div>
        </div>

        <div className="z-card p-6 shadow-sm">
          <LoginForm next={next ?? "/"} />
        </div>

        <p className="mt-6 text-center text-[11px] z-muted">
          {t("auth.login.copyright", { year: new Date().getFullYear() })}
        </p>
      </div>
    </main>
  );
}
