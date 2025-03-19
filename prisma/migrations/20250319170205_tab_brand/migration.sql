/*
  Warnings:

  - Added the required column `idBrand` to the `Piece` table without a default value. This is not possible if the table is not empty.
  - Added the required column `idBrand` to the `System` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `piece` ADD COLUMN `idBrand` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `system` ADD COLUMN `idBrand` INTEGER NOT NULL;

-- CreateTable
CREATE TABLE `Brand` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `System` ADD CONSTRAINT `System_idBrand_fkey` FOREIGN KEY (`idBrand`) REFERENCES `Brand`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idBrand_fkey` FOREIGN KEY (`idBrand`) REFERENCES `Brand`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
