-- Configurable delivery pricing. Existing values are preserved on later seeds.
ALTER TABLE `GlobalParameter`
  MODIFY `key` ENUM(
    'SALES_TAX',
    'ESTIMATE_VALID_DAYS',
    'INSTALLATION_DEPOSIT',
    'INSTALLATION_PERMIT_FEE',
    'CARD_SURCHARGE_PERCENT',
    'DELIVERY_BASE_PRICE',
    'DELIVERY_INCLUDED_MILES',
    'DELIVERY_ADDITIONAL_MILE_PRICE'
  ) NOT NULL;

INSERT INTO `GlobalParameter` (`key`, `value`, `description`, `unit`, `updatedAt`)
VALUES
  ('DELIVERY_BASE_PRICE', 200, 'Base delivery price through the included-mile threshold.', 'USD', CURRENT_TIMESTAMP(3)),
  ('DELIVERY_INCLUDED_MILES', 30, 'One-way road miles included in the base delivery price.', 'miles', CURRENT_TIMESTAMP(3)),
  ('DELIVERY_ADDITIONAL_MILE_PRICE', 5, 'Price for each additional one-way road mile, rounded upward.', 'USD/mile', CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE `key` = VALUES(`key`);

-- Fulfillment is selected only after production marks the order ready.
ALTER TABLE `Order`
  ADD COLUMN `fulfillmentMethod` ENUM(
    'UNDECIDED',
    'CUSTOMER_PICKUP',
    'COMPANY_DELIVERY',
    'INSTALLATION_DELIVERY'
  ) NOT NULL DEFAULT 'UNDECIDED',
  ADD COLUMN `fulfillmentSelectedAt` DATETIME(3) NULL,
  ADD COLUMN `pickupCompletedAt` DATETIME(3) NULL;

INSERT INTO `OrderStatus` (`name`)
VALUES ('Picked up')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- Installation orders use the installation trip by default. An admin may still
-- create a separately charged installation-delivery record below.
UPDATE `Order` AS `o`
INNER JOIN `installation_jobs` AS `j` ON `j`.`estimateId` = `o`.`idEst`
SET
  `o`.`fulfillmentMethod` = 'INSTALLATION_DELIVERY',
  `o`.`fulfillmentSelectedAt` = CURRENT_TIMESTAMP(3)
WHERE `j`.`status` <> 'CANCELED';

CREATE TABLE `order_deliveries` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `sequence` INTEGER NOT NULL,
  `type` ENUM(
    'STANDARD',
    'INSTALLATION_OVERRIDE',
    'PRE_DELIVERY',
    'REDELIVERY'
  ) NOT NULL,
  `status` ENUM(
    'PAYMENT_DUE',
    'READY_TO_SCHEDULE',
    'SCHEDULED',
    'COMPLETED',
    'CANCELED'
  ) NOT NULL DEFAULT 'PAYMENT_DUE',

  `vehicleProfile` VARCHAR(30) NOT NULL DEFAULT 'PICKUP',
  `routeProvider` VARCHAR(50) NOT NULL DEFAULT 'GOOGLE_ROUTES',

  `originStreet` VARCHAR(150) NOT NULL,
  `originCity` VARCHAR(100) NOT NULL,
  `originState` VARCHAR(50) NOT NULL,
  `originPostalCode` VARCHAR(20) NOT NULL,
  `destinationStreet` VARCHAR(150) NOT NULL,
  `destinationCity` VARCHAR(100) NOT NULL,
  `destinationState` VARCHAR(50) NOT NULL,
  `destinationPostalCode` VARCHAR(20) NOT NULL,

  `distanceMeters` INTEGER NOT NULL,
  `roadMiles` DECIMAL(10, 2) NOT NULL,
  `basePriceSnapshot` DECIMAL(12, 2) NOT NULL,
  `includedMilesSnapshot` DECIMAL(10, 2) NOT NULL,
  `additionalMilePriceSnapshot` DECIMAL(12, 2) NOT NULL,
  `additionalMiles` INTEGER NOT NULL,
  `tollAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `taxable` BOOLEAN NOT NULL DEFAULT false,
  `taxRateSnapshot` DECIMAL(10, 4) NOT NULL DEFAULT 0,
  `subtotal` DECIMAL(12, 2) NOT NULL,
  `taxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `total` DECIMAL(12, 2) NOT NULL,

  `internalReason` VARCHAR(1000) NULL,
  `createdById` INTEGER NOT NULL,
  `scheduledFor` DATETIME(3) NULL,
  `paidAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `canceledAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_order_delivery_sequence`(`orderId`, `sequence`),
  INDEX `order_deliveries_orderId_status_idx`(`orderId`, `status`),
  INDEX `order_deliveries_createdById_idx`(`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `payments`
  ADD COLUMN `deliveryId` INTEGER NULL,
  MODIFY `type` ENUM(
    'MATERIAL',
    'INSTALLATION_DEPOSIT',
    'PERMIT',
    'INSTALLATION',
    'DELIVERY',
    'EXTRA'
  ) NOT NULL DEFAULT 'MATERIAL';

CREATE UNIQUE INDEX `payments_deliveryId_key` ON `payments`(`deliveryId`);

ALTER TABLE `order_deliveries`
  ADD CONSTRAINT `order_deliveries_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `order_deliveries_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `payments`
  ADD CONSTRAINT `payments_deliveryId_fkey`
    FOREIGN KEY (`deliveryId`) REFERENCES `order_deliveries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
