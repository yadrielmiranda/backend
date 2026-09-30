ALTER TABLE `User`
  ADD COLUMN `parentDealerId` INTEGER NULL,
  ADD COLUMN `networkMarkup` DECIMAL(24,18) NOT NULL DEFAULT 0,
  ADD COLUMN `subdealerEarningsMode` ENUM('AVAILABLE_PROFIT','MARKUP') NULL,
  ADD COLUMN `subdealerEarningsPercent` DECIMAL(7,4) NULL;
CREATE INDEX `User_parentDealerId_idx` ON `User`(`parentDealerId`);
ALTER TABLE `User` ADD CONSTRAINT `User_parentDealerId_fkey`
  FOREIGN KEY (`parentDealerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Estimate`
  ADD COLUMN `dealerNetworkSnapshot` JSON NULL,
  ADD COLUMN `networkBillingPriceT` DECIMAL(12,2) NULL,
  ADD COLUMN `networkRootPriceT` DECIMAL(12,2) NULL,
  ADD COLUMN `networkSubdealerPriceT` DECIMAL(12,2) NULL;
ALTER TABLE `Piece` ADD COLUMN `networkPricing` JSON NULL;
