-- Extend the operational installation stage without changing EstimateStatus.
ALTER TABLE `installation_jobs`
  MODIFY `status` ENUM(
    'REQUESTED',
    'MEASUREMENT_PENDING',
    'QUOTE_DRAFT',
    'ADMIN_APPROVAL_PENDING',
    'CUSTOMER_APPROVAL_PENDING',
    'APPROVED',
    'PERMIT_PAYMENT_PENDING',
    'PERMIT_PROCESSING',
    'MATERIAL_PAYMENT_PENDING',
    'MATERIAL_PAID',
    'INSTALLATION_PAYMENT_PENDING',
    'INSTALLATION_PAID',
    'SCHEDULING',
    'SCHEDULED',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELED'
  ) NOT NULL DEFAULT 'REQUESTED';

-- Snapshot why each installation quote version needs approval.
ALTER TABLE `installation_quotes`
  ADD COLUMN `approvalReason` ENUM(
    'REMEASUREMENT',
    'PERMIT_REVISION',
    'FIELD_CHANGE'
  ) NOT NULL DEFAULT 'REMEASUREMENT' AFTER `status`;

-- Extra charges live under Order and are approved and paid independently.
CREATE TABLE `order_extra_charges` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `sequence` INTEGER NOT NULL,
  `status` ENUM(
    'DRAFT',
    'PENDING_CUSTOMER_APPROVAL',
    'PAYMENT_DUE',
    'PAID',
    'REJECTED',
    'CANCELED'
  ) NOT NULL DEFAULT 'DRAFT',
  `subtotal` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `taxRateSnapshot` DECIMAL(10, 4) NOT NULL DEFAULT 0,
  `taxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `notes` VARCHAR(1000) NULL,
  `decisionComment` VARCHAR(1000) NULL,
  `createdById` INTEGER NOT NULL,
  `respondedById` INTEGER NULL,
  `submittedAt` DATETIME(3) NULL,
  `respondedAt` DATETIME(3) NULL,
  `paidAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_order_extra_charge_sequence`(`orderId`, `sequence`),
  INDEX `order_extra_charges_orderId_status_idx`(`orderId`, `status`),
  INDEX `order_extra_charges_createdById_idx`(`createdById`),
  INDEX `order_extra_charges_respondedById_idx`(`respondedById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_extra_charge_lines` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `extraChargeId` INTEGER NOT NULL,
  `description` VARCHAR(500) NOT NULL,
  `quantity` DECIMAL(12, 4) NOT NULL DEFAULT 1,
  `unitPrice` DECIMAL(12, 2) NOT NULL,
  `taxable` BOOLEAN NOT NULL DEFAULT false,
  `subtotal` DECIMAL(12, 2) NOT NULL,
  `taxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `total` DECIMAL(12, 2) NOT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `order_extra_charge_lines_extraChargeId_sortOrder_idx`(`extraChargeId`, `sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `payments`
  ADD COLUMN `extraChargeId` INTEGER NULL,
  MODIFY `type` ENUM('MATERIAL', 'PERMIT', 'INSTALLATION', 'EXTRA') NOT NULL DEFAULT 'MATERIAL';

CREATE UNIQUE INDEX `payments_extraChargeId_key` ON `payments`(`extraChargeId`);

ALTER TABLE `order_extra_charges`
  ADD CONSTRAINT `order_extra_charges_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `order_extra_charges_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `order_extra_charges_respondedById_fkey`
    FOREIGN KEY (`respondedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `order_extra_charge_lines`
  ADD CONSTRAINT `order_extra_charge_lines_extraChargeId_fkey`
    FOREIGN KEY (`extraChargeId`) REFERENCES `order_extra_charges`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `payments`
  ADD CONSTRAINT `payments_extraChargeId_fkey`
    FOREIGN KEY (`extraChargeId`) REFERENCES `order_extra_charges`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
