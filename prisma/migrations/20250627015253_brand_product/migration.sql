-- CreateTable
CREATE TABLE `brand_product` (
    `idBrand` INTEGER NOT NULL,
    `idProduct` INTEGER NOT NULL,

    PRIMARY KEY (`idBrand`, `idProduct`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `brand_product` ADD CONSTRAINT `brand_product_idBrand_fkey` FOREIGN KEY (`idBrand`) REFERENCES `Brand`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `brand_product` ADD CONSTRAINT `brand_product_idProduct_fkey` FOREIGN KEY (`idProduct`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
