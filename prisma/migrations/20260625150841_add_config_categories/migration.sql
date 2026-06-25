-- AlterTable
ALTER TABLE `Config` ADD COLUMN `categoryId` INTEGER NULL;

-- CreateTable
CREATE TABLE `config_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `idProduct` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `config_categories_idProduct_idx`(`idProduct`),
    INDEX `config_categories_isActive_idx`(`isActive`),
    UNIQUE INDEX `config_categories_idProduct_name_key`(`idProduct`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Config_categoryId_idx` ON `Config`(`categoryId`);

-- AddForeignKey
ALTER TABLE `Config` ADD CONSTRAINT `Config_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `config_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `config_categories` ADD CONSTRAINT `config_categories_idProduct_fkey` FOREIGN KEY (`idProduct`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
