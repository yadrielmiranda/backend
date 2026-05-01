-- AlterTable
ALTER TABLE `brand` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `brand_product` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `coating` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `config` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `crystal` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `framecolor` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `pricing_rules` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `product` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `sys_conf` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `system` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `system_crystals` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `tint` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX `Brand_isActive_idx` ON `Brand`(`isActive`);

-- CreateIndex
CREATE INDEX `brand_product_isActive_idx` ON `brand_product`(`isActive`);

-- CreateIndex
CREATE INDEX `Coating_isActive_idx` ON `Coating`(`isActive`);

-- CreateIndex
CREATE INDEX `Config_isActive_idx` ON `Config`(`isActive`);

-- CreateIndex
CREATE INDEX `Config_idProduct_isActive_idx` ON `Config`(`idProduct`, `isActive`);

-- CreateIndex
CREATE INDEX `Crystal_isActive_idx` ON `Crystal`(`isActive`);

-- CreateIndex
CREATE INDEX `FrameColor_isActive_idx` ON `FrameColor`(`isActive`);

-- CreateIndex
CREATE INDEX `pricing_rules_isActive_idx` ON `pricing_rules`(`isActive`);

-- CreateIndex
CREATE INDEX `Product_isActive_idx` ON `Product`(`isActive`);

-- CreateIndex
CREATE INDEX `sys_conf_isActive_idx` ON `sys_conf`(`isActive`);

-- CreateIndex
CREATE INDEX `System_isActive_idx` ON `System`(`isActive`);

-- CreateIndex
CREATE INDEX `system_crystals_isActive_idx` ON `system_crystals`(`isActive`);

-- CreateIndex
CREATE INDEX `Tint_isActive_idx` ON `Tint`(`isActive`);
