import { can, getSession } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { ZaiAdmin } from "./zai-admin";

export const dynamic = "force-dynamic";

export default async function ZaiPage() {
  const user = await getSession();
  if (!can(user, "content:read")) {
    return <div className="z-card p-10 text-center text-sm">Bạn không có quyền sử dụng zAI Content Operator.</div>;
  }
  return (
    <>
      <PageHeader title="zAI" description="Quản lý pages và blogs bằng ngôn ngữ tự nhiên." />
      <ZaiAdmin />
    </>
  );
}
