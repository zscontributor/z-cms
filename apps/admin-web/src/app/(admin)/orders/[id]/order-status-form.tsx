"use client";

import { useActionState, useState } from "react";
import { ORDER_STATUSES, type OrderStatus } from "@zcmsorg/schemas";
import { updateOrderStatusAction, type OrderActionResult } from "@/app/actions/orders";
import { Select } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { orderStatusKey } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";

type State = OrderActionResult | null;

const save = async (_prev: State, formData: FormData): Promise<State> =>
  updateOrderStatusAction(formData);

export function OrderStatusForm({ id, status }: { id: string; status: OrderStatus }) {
  const t = useT();
  const [state, action] = useActionState(save, null);
  const [selected, setSelected] = useState<OrderStatus>(status);

  return (
    <form action={action} className="z-card space-y-3 p-5">
      <h2 className="text-sm font-semibold">{t("commerce.detail.updateStatus")}</h2>
      <input type="hidden" name="id" value={id} />
      <Select
        name="status"
        value={selected}
        onChange={(event) => setSelected(event.target.value as OrderStatus)}
        aria-label={t("commerce.detail.updateStatus")}
      >
        {ORDER_STATUSES.map((value) => (
          <option key={value} value={value}>
            {t(orderStatusKey(value))}
          </option>
        ))}
      </Select>

      {state?.ok === false ? (
        <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>
      ) : state?.ok ? (
        <p className="text-xs text-green-600 dark:text-green-400">{state.message}</p>
      ) : null}

      <SubmitButton className="w-full">{t("commerce.detail.save")}</SubmitButton>
    </form>
  );
}
