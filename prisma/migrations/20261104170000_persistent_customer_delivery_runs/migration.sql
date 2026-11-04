ALTER TABLE `warehouse_customer_deliveries` ADD COLUMN `pendingItems` JSON NULL, ADD COLUMN `orders` JSON NULL;
CREATE TABLE `warehouse_customer_delivery_runs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(64) NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `storeId` INTEGER NULL,
  `storeName` VARCHAR(80) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `version` INTEGER NOT NULL DEFAULT 0,
  `orders` JSON NOT NULL,
  `items` JSON NOT NULL,
  `snapshot` JSON NULL,
  `createdById` INTEGER NOT NULL,
  `createdByName` VARCHAR(255) NOT NULL,
  `deliveryId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `closedAt` DATETIME(3) NULL,
  UNIQUE INDEX `warehouse_customer_delivery_runs_requestKey_key` (`requestKey`),
  UNIQUE INDEX `warehouse_customer_delivery_runs_deliveryId_key` (`deliveryId`),
  INDEX `warehouse_customer_delivery_runs_status_id_idx` (`status`, `id`),
  INDEX `warehouse_customer_delivery_runs_storeId_id_idx` (`storeId`, `id`),
  INDEX `warehouse_customer_delivery_runs_createdById_idx` (`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `warehouse_customer_delivery_run_events` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `runId` INTEGER NOT NULL,
  `requestKey` VARCHAR(64) NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `action` VARCHAR(20) NOT NULL,
  `actorId` INTEGER NOT NULL,
  `details` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `warehouse_customer_delivery_run_events_requestKey_key` (`requestKey`),
  INDEX `warehouse_customer_delivery_run_events_runId_id_idx` (`runId`, `id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `warehouse_customer_delivery_runs` ADD CONSTRAINT `warehouse_customer_delivery_runs_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `warehouse_stores` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_customer_delivery_runs` ADD CONSTRAINT `warehouse_customer_delivery_runs_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_customer_delivery_runs` ADD CONSTRAINT `warehouse_customer_delivery_runs_deliveryId_fkey` FOREIGN KEY (`deliveryId`) REFERENCES `warehouse_customer_deliveries` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_customer_delivery_run_events` ADD CONSTRAINT `warehouse_customer_delivery_run_events_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `warehouse_customer_delivery_runs` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
