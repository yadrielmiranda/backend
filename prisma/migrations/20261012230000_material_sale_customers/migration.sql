-- Separate the purchaser's account from the staff member who recorded a sale.
ALTER TABLE `material_sales` ADD COLUMN `customerUserId` INTEGER NULL;

CREATE INDEX `material_sales_customerUserId_id_idx` ON `material_sales`(`customerUserId`, `id`);

-- Only catalog creation records prove that the creator was the buyer.
-- Never link a manually entered customer by matching their name or email.
UPDATE `material_sales` s
INNER JOIN `User` u ON u.id = s.createdById
SET s.customerUserId = u.id
WHERE s.customerUserId IS NULL AND EXISTS (
    SELECT 1 FROM `material_operations` o
    WHERE o.kind = 'CUSTOMER_SALE_CREATE' AND o.actorId = s.createdById
      AND JSON_EXTRACT(o.result, '$.id') = s.id
);

ALTER TABLE `material_sales` ADD CONSTRAINT `material_sales_customerUserId_fkey`
    FOREIGN KEY (`customerUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `material_sale_emails` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `saleId` INTEGER NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `customerName` VARCHAR(200) NOT NULL,
    `saleCode` VARCHAR(50) NOT NULL,
    `total` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(10) NOT NULL,
    `publicToken` VARCHAR(100) NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'ACCEPTED', 'SKIPPED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `attemptedAt` DATETIME(3) NULL,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acceptedAt` DATETIME(3) NULL,
    `providerMessageId` VARCHAR(320) NULL,
    `errorCode` VARCHAR(80) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `material_sale_emails_saleId_key`(`saleId`),
    INDEX `material_sale_emails_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `material_sale_emails` ADD CONSTRAINT `material_sale_emails_saleId_fkey`
    FOREIGN KEY (`saleId`) REFERENCES `material_sales`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
