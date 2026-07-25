-- Commerce: orders placed against a site's products, and per-site storefront settings.
--
-- The cart is browser state; only a completed checkout reaches the database as an
-- Order. Money is re-derived from the product's own Content.data.price at order
-- time, so nothing a client sends can set a price. Order/OrderItem snapshot the
-- title and price at purchase and do not foreign-key the product — a paid order
-- must survive the product being edited or deleted.

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FULFILLED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('COD');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'REFUNDED');

-- CreateTable
CREATE TABLE "commerce_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "cod_enabled" BOOLEAN NOT NULL DEFAULT true,
    "shipping_flat_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "free_shipping_threshold" DECIMAL(12,2),
    "store_name" TEXT,
    "store_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_settings_pkey" PRIMARY KEY ("id")
);

-- One storefront configuration per site.
CREATE UNIQUE INDEX "commerce_settings_site_id_key" ON "commerce_settings"("site_id");

-- CreateIndex
CREATE INDEX "commerce_settings_tenant_id_idx" ON "commerce_settings"("tenant_id");

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "payment_method" "PaymentMethod" NOT NULL DEFAULT 'COD',
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "payment_ref" TEXT,
    "customer_name" TEXT NOT NULL,
    "customer_email" TEXT NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "shipping_address" TEXT NOT NULL,
    "shipping_city" TEXT NOT NULL,
    "note" TEXT,
    "locale" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "shipping_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_access_token_key" ON "orders"("access_token");

-- The order number is sequential per site, so it is unique only within a site.
CREATE UNIQUE INDEX "orders_site_id_order_number_key" ON "orders"("site_id", "order_number");

-- CreateIndex
CREATE INDEX "orders_tenant_id_idx" ON "orders"("tenant_id");

-- The admin list: a site's orders, filtered by status, newest first.
CREATE INDEX "orders_site_id_status_placed_at_idx" ON "orders"("site_id", "status", "placed_at");

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "image" TEXT,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_items_tenant_id_idx" ON "order_items"("tenant_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- AddForeignKey
ALTER TABLE "commerce_settings" ADD CONSTRAINT "commerce_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_settings" ADD CONSTRAINT "commerce_settings_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables. The policy loop in the
-- 20260712105000_row_level_security migration only ever saw the tables that
-- existed when it ran, so every table added later must opt in explicitly.
-- Orders carry a customer's name, contact and address — a missing policy would
-- let one tenant's application-role query read another tenant's customers.
ALTER TABLE "commerce_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commerce_settings"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "commerce_settings" TO zcms_app;

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "orders"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "orders" TO zcms_app;

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_items"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "order_items" TO zcms_app;
