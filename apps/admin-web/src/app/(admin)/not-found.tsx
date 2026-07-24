import Link from "next/link";
import { getT } from "@/lib/locale";

export default async function AdminNotFound() {
  const t = await getT();

  return (
    <div className="z-card mx-auto max-w-md p-10 text-center">
      <p className="text-2xl font-semibold text-brand-500">404</p>
      <h1 className="mt-1 text-sm font-semibold">{t("admin.notFound.title")}</h1>
      <p className="mt-1 text-xs z-muted">{t("admin.notFound.description")}</p>
      <Link
        href="/"
        className="mt-5 inline-flex h-9 items-center rounded-md bg-brand-500 px-3.5 text-sm font-medium text-white hover:bg-brand-600"
      >
        {t("admin.backToDashboard")}
      </Link>
    </div>
  );
}
