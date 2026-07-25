-- Demo orders: sample orders a theme's "Seed demo" creates so the admin Orders
-- screen is not empty in a demo. Scoped to the theme exactly like demo content and
-- demo menus (demoThemeKey), so re-seeding replaces only this theme's demo orders
-- and never touches a real customer's order.
ALTER TABLE "orders" ADD COLUMN "demo_theme_key" TEXT;

-- Cleanup on re-seed selects a site's demo orders for one theme.
CREATE INDEX "orders_site_id_demo_theme_key_idx" ON "orders"("site_id", "demo_theme_key");
