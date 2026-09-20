CREATE TABLE `warehouse_delivery_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `street` VARCHAR(150) NOT NULL,
    `city` VARCHAR(100) NOT NULL,
    `state` VARCHAR(2) NOT NULL,
    `postalCode` VARCHAR(10) NOT NULL,
    `maxDeliveryMiles` DECIMAL(10, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Los deliveries anteriores conservan sus condiciones y no reciben un límite inventado.
ALTER TABLE `order_deliveries`
    ADD COLUMN `maxDistanceMilesSnapshot` DECIMAL(10, 2) NULL;
