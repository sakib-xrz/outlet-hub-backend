-- CreateTable
CREATE TABLE "outlets" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "address" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outlets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_memberships" (
    "user_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outlet_memberships_pkey" PRIMARY KEY ("user_id","outlet_id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "sku" VARCHAR(50) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" VARCHAR(1000),
    "base_price" DECIMAL(12,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_menu_items" (
    "outlet_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "override_price" DECIMAL(12,2),
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outlet_menu_items_pkey" PRIMARY KEY ("outlet_id","menu_item_id")
);

-- CreateTable
CREATE TABLE "receipt_counters" (
    "outlet_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("outlet_id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "receipt_number" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "total_amount" DECIMAL(16,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "sale_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "item_name" VARCHAR(150) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(16,2) NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("sale_id","menu_item_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outlets_code_key" ON "outlets"("code");

-- CreateIndex
CREATE INDEX "outlet_memberships_outlet_id_idx" ON "outlet_memberships"("outlet_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_sku_key" ON "menu_items"("sku");

-- CreateIndex
CREATE INDEX "outlet_menu_items_menu_item_id_idx" ON "outlet_menu_items"("menu_item_id");

-- CreateIndex
CREATE INDEX "sales_outlet_id_created_at_idx" ON "sales"("outlet_id", "created_at");

-- CreateIndex
CREATE INDEX "sales_created_by_id_idx" ON "sales"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_outlet_id_receipt_number_key" ON "sales"("outlet_id", "receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_outlet_id_request_id_key" ON "sales"("outlet_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_id_outlet_id_key" ON "sales"("id", "outlet_id");

-- CreateIndex
CREATE INDEX "sale_items_outlet_id_menu_item_id_idx" ON "sale_items"("outlet_id", "menu_item_id");

-- AddForeignKey
ALTER TABLE "outlet_memberships" ADD CONSTRAINT "outlet_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_memberships" ADD CONSTRAINT "outlet_memberships_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_menu_items" ADD CONSTRAINT "outlet_menu_items_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_menu_items" ADD CONSTRAINT "outlet_menu_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_counters" ADD CONSTRAINT "receipt_counters_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_outlet_id_fkey" FOREIGN KEY ("sale_id", "outlet_id") REFERENCES "sales"("id", "outlet_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_outlet_id_menu_item_id_fkey" FOREIGN KEY ("outlet_id", "menu_item_id") REFERENCES "outlet_menu_items"("outlet_id", "menu_item_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddCheckConstraints (not expressible in the Prisma schema)
ALTER TABLE "outlets"
  ADD CONSTRAINT "outlets_code_not_blank" CHECK (btrim("code") <> ''),
  ADD CONSTRAINT "outlets_name_not_blank" CHECK (btrim("name") <> '');

ALTER TABLE "menu_items"
  ADD CONSTRAINT "menu_items_sku_not_blank" CHECK (btrim("sku") <> ''),
  ADD CONSTRAINT "menu_items_name_not_blank" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "menu_items_base_price_nonnegative" CHECK ("base_price" >= 0);

ALTER TABLE "outlet_menu_items"
  ADD CONSTRAINT "outlet_menu_items_override_price_nonnegative" CHECK ("override_price" IS NULL OR "override_price" >= 0),
  ADD CONSTRAINT "outlet_menu_items_stock_quantity_nonnegative" CHECK ("stock_quantity" >= 0);

ALTER TABLE "receipt_counters"
  ADD CONSTRAINT "receipt_counters_last_number_nonnegative" CHECK ("last_number" >= 0);

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_receipt_number_positive" CHECK ("receipt_number" > 0),
  ADD CONSTRAINT "sales_total_amount_nonnegative" CHECK ("total_amount" >= 0),
  ADD CONSTRAINT "sales_request_hash_sha256_hex" CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_item_name_not_blank" CHECK (btrim("item_name") <> ''),
  ADD CONSTRAINT "sale_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "sale_items_unit_price_nonnegative" CHECK ("unit_price" >= 0),
  ADD CONSTRAINT "sale_items_line_total_matches" CHECK ("line_total" = "unit_price" * "quantity");
