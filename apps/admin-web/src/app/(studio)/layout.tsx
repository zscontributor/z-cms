import { redirect } from "next/navigation";
import { getSession } from "@/lib/api";

/**
 * The Studio shell — deliberately bare.
 *
 * The Theme Editor is a full-screen design surface, so it opts OUT of the admin
 * chrome (sidebar + topbar) that `(admin)/layout.tsx` wraps every other page in.
 * A route group changes nothing in the URL, so `/theme-editor/[id]` is unchanged and
 * every existing link still resolves here — this layout just renders its child
 * edge-to-edge under the root layout's providers (locale, etc.).
 *
 * Auth still has to be enforced (the admin layout was the only thing redirecting an
 * anonymous visitor before), so the session gate lives here; the page itself then
 * gates on the finer `theme:author` permission.
 */
export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");
  return <>{children}</>;
}
