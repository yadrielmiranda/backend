-- DropForeignKey
ALTER TABLE `system` DROP FOREIGN KEY `System_idBrand_fkey`;

-- DropForeignKey
ALTER TABLE `system` DROP FOREIGN KEY `System_idProduct_fkey`;

-- DropIndex
DROP INDEX `System_idBrand_fkey` ON `system`;

-- DropIndex
DROP INDEX `System_idProduct_fkey` ON `system`;

-- AddForeignKey
ALTER TABLE `System` ADD CONSTRAINT `System_idBrand_idProduct_fkey` FOREIGN KEY (`idBrand`, `idProduct`) REFERENCES `brand_product`(`idBrand`, `idProduct`) ON DELETE RESTRICT ON UPDATE CASCADE;
