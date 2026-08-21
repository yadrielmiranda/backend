CREATE TABLE `estimate_customer_charges` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `estimateId` INTEGER NOT NULL,
  `origin` ENUM('SYSTEM', 'DEALER') NOT NULL,
  `source` ENUM('INSTALLATION', 'INSTALLATION_SERVICE', 'PERMIT', 'CITY_FEE', 'CUSTOM') NOT NULL,
  `sourceKey` VARCHAR(100) NULL,
  `sourceRefId` INTEGER NULL,
  `description` VARCHAR(150) NOT NULL,
  `pricingMode` ENUM('PERCENTAGE', 'AMOUNT', 'FINAL') NOT NULL,
  `pricingValue` DECIMAL(12, 4) NOT NULL,
  `systemAmountSnapshot` DECIMAL(12, 2) NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_estimate_customer_charge_source`(`estimateId`, `sourceKey`),
  INDEX `estimate_customer_charges_estimateId_sortOrder_idx`(`estimateId`, `sortOrder`),
  INDEX `estimate_customer_charges_estimateId_origin_idx`(`estimateId`, `origin`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `estimate_customer_charges`
  ADD CONSTRAINT `estimate_customer_charges_estimateId_fkey`
  FOREIGN KEY (`estimateId`) REFERENCES `Estimate`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
