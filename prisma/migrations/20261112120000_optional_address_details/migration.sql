-- Keep supplemental address details separate from the existing street address.
ALTER TABLE `User` ADD COLUMN `addressLine2` VARCHAR(150) NULL;
ALTER TABLE `branding` ADD COLUMN `addressLine2` VARCHAR(150) NULL;
ALTER TABLE `Estimate` ADD COLUMN `customerAddressLine2` VARCHAR(150) NULL;
ALTER TABLE `installation_coverage` ADD COLUMN `originAddressLine2` VARCHAR(150) NULL;
ALTER TABLE `warehouse_delivery_settings` ADD COLUMN `addressLine2` VARCHAR(150) NULL;
ALTER TABLE `order_deliveries`
    ADD COLUMN `originAddressLine2` VARCHAR(150) NULL,
    ADD COLUMN `destinationAddressLine2` VARCHAR(150) NULL;
