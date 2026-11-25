-- numeric accepts 'NaN', which sorts above every number and therefore passes ">= 0" checks.
ALTER TABLE "menu_items"
  ADD CONSTRAINT "menu_items_base_price_not_nan" CHECK ("base_price" <> 'NaN'::numeric);

ALTER TABLE "outlet_menu_items"
  ADD CONSTRAINT "outlet_menu_items_override_price_not_nan"
    CHECK ("override_price" IS NULL OR "override_price" <> 'NaN'::numeric);

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_total_amount_not_nan" CHECK ("total_amount" <> 'NaN'::numeric);

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_unit_price_not_nan" CHECK ("unit_price" <> 'NaN'::numeric),
  ADD CONSTRAINT "sale_items_line_total_not_nan" CHECK ("line_total" <> 'NaN'::numeric);
