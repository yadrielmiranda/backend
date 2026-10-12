CREATE TABLE `material_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(80) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    UNIQUE INDEX `material_categories_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `material_products`
    ADD COLUMN `imageUrl` VARCHAR(255) NULL,
    ADD COLUMN `brand` VARCHAR(120) NULL,
    ADD COLUMN `categoryId` INTEGER NULL;

CREATE INDEX `material_products_categoryId_idx` ON `material_products`(`categoryId`);
CREATE INDEX `material_products_brand_idx` ON `material_products`(`brand`);
ALTER TABLE `material_products` ADD CONSTRAINT `material_products_categoryId_fkey`
    FOREIGN KEY (`categoryId`) REFERENCES `material_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
