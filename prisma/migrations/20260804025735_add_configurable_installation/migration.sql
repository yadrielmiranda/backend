-- DropForeignKey
ALTER TABLE `payments` DROP FOREIGN KEY `payments_idEst_fkey`;

-- DropIndex
DROP INDEX `payments_idEst_key` ON `payments`;

-- AlterTable
ALTER TABLE `Role` ADD COLUMN `installationPriceProfileId` INTEGER NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `installationPriceProfileId` INTEGER NULL;

-- AlterTable
ALTER TABLE `GlobalParameter` MODIFY `key` ENUM('SALES_TAX', 'ESTIMATE_VALID_DAYS', 'INSTALLATION_PERMIT_FEE', 'CARD_SURCHARGE_PERCENT') NOT NULL;

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `baseAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `installationJobId` INTEGER NULL,
    ADD COLUMN `sequence` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `surchargeAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `surchargePercent` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    ADD COLUMN `type` ENUM('MATERIAL', 'PERMIT', 'INSTALLATION') NOT NULL DEFAULT 'MATERIAL';

-- Preserve the original material-payment amount as its base snapshot.
UPDATE `payments` SET `baseAmount` = `amount`;

-- CreateTable
CREATE TABLE `installation_services` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `billingUnit` ENUM('UNIT', 'PANEL', 'SQFT', 'SQFT_RECTANGULAR', 'LINEAR_FOOT') NOT NULL,
    `ruleMetric` ENUM('NONE', 'WIDTH', 'HEIGHT', 'AREA', 'PANEL_COUNT', 'LENGTH') NOT NULL DEFAULT 'NONE',
    `baseRate` DECIMAL(12, 4) NOT NULL DEFAULT 0,
    `availableForRequest` BOOLEAN NOT NULL DEFAULT false,
    `availableForField` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `installation_services_name_key`(`name`),
    INDEX `installation_services_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_service_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `serviceId` INTEGER NOT NULL,
    `minValue` DECIMAL(12, 4) NULL,
    `minInclusive` BOOLEAN NOT NULL DEFAULT true,
    `maxValue` DECIMAL(12, 4) NULL,
    `maxInclusive` BOOLEAN NOT NULL DEFAULT false,
    `rate` DECIMAL(12, 4) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `installation_service_rules_serviceId_isActive_sortOrder_idx`(`serviceId`, `isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_installation_services` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `serviceId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_installation_services_serviceId_idx`(`serviceId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `serviceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_price_profiles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `adjustmentPercent` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `minimumCharge` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `installation_price_profiles_name_key`(`name`),
    INDEX `installation_price_profiles_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
    INDEX `installation_price_profiles_isDefault_idx`(`isDefault`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_jobs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `estimateId` INTEGER NOT NULL,
    `status` ENUM('REQUESTED', 'MEASUREMENT_PENDING', 'QUOTE_DRAFT', 'ADMIN_APPROVAL_PENDING', 'CUSTOMER_APPROVAL_PENDING', 'APPROVED', 'MATERIAL_PAYMENT_PENDING', 'MATERIAL_PAID', 'INSTALLATION_PAYMENT_PENDING', 'INSTALLATION_PAID', 'SCHEDULING', 'SCHEDULED', 'COMPLETED', 'CANCELED') NOT NULL DEFAULT 'REQUESTED',
    `requestedById` INTEGER NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `canceledAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `installation_jobs_estimateId_key`(`estimateId`),
    INDEX `installation_jobs_requestedById_idx`(`requestedById`),
    INDEX `installation_jobs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_measurements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `pieceId` INTEGER NULL,
    `unitIndex` INTEGER NOT NULL DEFAULT 1,
    `label` VARCHAR(150) NOT NULL,
    `isManual` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('PENDING', 'COMPLETED') NOT NULL DEFAULT 'PENDING',
    `sourceSnapshot` JSON NULL,
    `widthIn` DECIMAL(10, 3) NULL,
    `heightIn` DECIMAL(10, 3) NULL,
    `heightLeftIn` DECIMAL(10, 3) NULL,
    `heightRightIn` DECIMAL(10, 3) NULL,
    `legHeightIn` DECIMAL(10, 3) NULL,
    `doorWidthIn` DECIMAL(10, 3) NULL,
    `doorHeightIn` DECIMAL(10, 3) NULL,
    `leftSideliteWidthIn` DECIMAL(10, 3) NULL,
    `rightSideliteWidthIn` DECIMAL(10, 3) NULL,
    `leftPanels` INTEGER NULL,
    `rightPanels` INTEGER NULL,
    `panelCount` INTEGER NULL,
    `lengthIn` DECIMAL(10, 3) NULL,
    `notes` VARCHAR(1000) NULL,
    `measuredById` INTEGER NULL,
    `measuredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `installation_measurements_jobId_unitIndex_idx`(`jobId`, `unitIndex`),
    INDEX `installation_measurements_pieceId_idx`(`pieceId`),
    INDEX `installation_measurements_measuredById_idx`(`measuredById`),
    UNIQUE INDEX `uq_installation_measurement_piece_unit`(`jobId`, `pieceId`, `unitIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_quotes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'PENDING_ADMIN_APPROVAL', 'PENDING_CUSTOMER_APPROVAL', 'APPROVED', 'REJECTED', 'SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
    `profileId` INTEGER NULL,
    `profileNameSnapshot` VARCHAR(150) NOT NULL,
    `profileAdjustmentPercent` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `profileMinimumSnapshot` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `baseSubtotal` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `adjustedSubtotal` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `minimumAdjustment` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `notes` VARCHAR(2000) NULL,
    `submittedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `installation_quotes_jobId_status_idx`(`jobId`, `status`),
    INDEX `installation_quotes_profileId_idx`(`profileId`),
    INDEX `installation_quotes_createdById_idx`(`createdById`),
    UNIQUE INDEX `uq_installation_quote_job_version`(`jobId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_quote_lines` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `quoteId` INTEGER NOT NULL,
    `serviceId` INTEGER NOT NULL,
    `ruleId` INTEGER NULL,
    `measurementId` INTEGER NULL,
    `origin` ENUM('AUTO', 'USER_SELECTED', 'FIELD_ADDED') NOT NULL,
    `sourceSystemId` INTEGER NULL,
    `sourceConfigId` INTEGER NULL,
    `componentIndex` INTEGER NULL,
    `componentLabel` VARCHAR(150) NULL,
    `serviceNameSnapshot` VARCHAR(150) NOT NULL,
    `billingUnitSnapshot` ENUM('UNIT', 'PANEL', 'SQFT', 'SQFT_RECTANGULAR', 'LINEAR_FOOT') NOT NULL,
    `ruleMetricSnapshot` ENUM('NONE', 'WIDTH', 'HEIGHT', 'AREA', 'PANEL_COUNT', 'LENGTH') NOT NULL,
    `ruleSnapshot` JSON NULL,
    `widthIn` DECIMAL(10, 3) NULL,
    `heightIn` DECIMAL(10, 3) NULL,
    `areaSqFt` DECIMAL(12, 4) NULL,
    `panelCount` INTEGER NULL,
    `lengthIn` DECIMAL(10, 3) NULL,
    `metricValue` DECIMAL(12, 4) NULL,
    `rate` DECIMAL(12, 4) NOT NULL,
    `billableQuantity` DECIMAL(12, 4) NOT NULL DEFAULT 1,
    `occurrences` INTEGER NOT NULL DEFAULT 1,
    `baseAmount` DECIMAL(12, 2) NOT NULL,
    `adjustmentPercent` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `adjustedAmount` DECIMAL(12, 2) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `installation_quote_lines_quoteId_sortOrder_idx`(`quoteId`, `sortOrder`),
    INDEX `installation_quote_lines_serviceId_idx`(`serviceId`),
    INDEX `installation_quote_lines_ruleId_idx`(`ruleId`),
    INDEX `installation_quote_lines_measurementId_idx`(`measurementId`),
    INDEX `installation_quote_lines_origin_idx`(`origin`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_quote_approvals` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `quoteId` INTEGER NOT NULL,
    `stage` ENUM('ADMIN', 'CUSTOMER') NOT NULL,
    `decision` ENUM('APPROVED', 'REJECTED') NOT NULL,
    `comment` VARCHAR(1000) NULL,
    `actorId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `installation_quote_approvals_quoteId_stage_createdAt_idx`(`quoteId`, `stage`, `createdAt`),
    INDEX `installation_quote_approvals_actorId_idx`(`actorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_permits` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `status` ENUM('PAYMENT_PENDING', 'PAID', 'SUBMITTED', 'CHANGES_REQUIRED', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PAYMENT_PENDING',
    `permitFeeSnapshot` DECIMAL(12, 2) NOT NULL,
    `cityFee` DECIMAL(12, 2) NULL,
    `notes` VARCHAR(1000) NULL,
    `paidAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `installation_permits_jobId_key`(`jobId`),
    INDEX `installation_permits_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installation_appointments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `status` ENUM('PROPOSED', 'ACCEPTED', 'RESCHEDULE_REQUESTED', 'SUPERSEDED', 'CANCELED', 'COMPLETED') NOT NULL DEFAULT 'PROPOSED',
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NULL,
    `note` VARCHAR(1000) NULL,
    `responseNote` VARCHAR(1000) NULL,
    `proposedById` INTEGER NOT NULL,
    `respondedById` INTEGER NULL,
    `respondedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `installation_appointments_jobId_status_startsAt_idx`(`jobId`, `status`, `startsAt`),
    INDEX `installation_appointments_proposedById_idx`(`proposedById`),
    INDEX `installation_appointments_respondedById_idx`(`respondedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Role_installationPriceProfileId_idx` ON `Role`(`installationPriceProfileId`);

-- CreateIndex
CREATE INDEX `User_installationPriceProfileId_idx` ON `User`(`installationPriceProfileId`);

-- CreateIndex
CREATE INDEX `payments_installationJobId_idx` ON `payments`(`installationJobId`);

-- CreateIndex
CREATE UNIQUE INDEX `uq_payment_estimate_type_sequence` ON `payments`(`idEst`, `type`, `sequence`);

-- AddForeignKey
ALTER TABLE `Role` ADD CONSTRAINT `Role_installationPriceProfileId_fkey` FOREIGN KEY (`installationPriceProfileId`) REFERENCES `installation_price_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_installationPriceProfileId_fkey` FOREIGN KEY (`installationPriceProfileId`) REFERENCES `installation_price_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_service_rules` ADD CONSTRAINT `installation_service_rules_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `installation_services`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_installation_services` ADD CONSTRAINT `sysconf_installation_services_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_installation_services` ADD CONSTRAINT `sysconf_installation_services_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `installation_services`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_jobs` ADD CONSTRAINT `installation_jobs_estimateId_fkey` FOREIGN KEY (`estimateId`) REFERENCES `Estimate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_jobs` ADD CONSTRAINT `installation_jobs_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_measurements` ADD CONSTRAINT `installation_measurements_measuredById_fkey` FOREIGN KEY (`measuredById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_measurements` ADD CONSTRAINT `installation_measurements_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `installation_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_measurements` ADD CONSTRAINT `installation_measurements_pieceId_fkey` FOREIGN KEY (`pieceId`) REFERENCES `Piece`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quotes` ADD CONSTRAINT `installation_quotes_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `installation_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quotes` ADD CONSTRAINT `installation_quotes_profileId_fkey` FOREIGN KEY (`profileId`) REFERENCES `installation_price_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quotes` ADD CONSTRAINT `installation_quotes_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quote_lines` ADD CONSTRAINT `installation_quote_lines_quoteId_fkey` FOREIGN KEY (`quoteId`) REFERENCES `installation_quotes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quote_lines` ADD CONSTRAINT `installation_quote_lines_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `installation_services`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quote_lines` ADD CONSTRAINT `installation_quote_lines_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `installation_service_rules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quote_lines` ADD CONSTRAINT `installation_quote_lines_measurementId_fkey` FOREIGN KEY (`measurementId`) REFERENCES `installation_measurements`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quote_approvals` ADD CONSTRAINT `installation_quote_approvals_quoteId_fkey` FOREIGN KEY (`quoteId`) REFERENCES `installation_quotes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_quote_approvals` ADD CONSTRAINT `installation_quote_approvals_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_permits` ADD CONSTRAINT `installation_permits_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `installation_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_appointments` ADD CONSTRAINT `installation_appointments_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `installation_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_appointments` ADD CONSTRAINT `installation_appointments_proposedById_fkey` FOREIGN KEY (`proposedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installation_appointments` ADD CONSTRAINT `installation_appointments_respondedById_fkey` FOREIGN KEY (`respondedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_idEst_fkey` FOREIGN KEY (`idEst`) REFERENCES `Estimate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_installationJobId_fkey` FOREIGN KEY (`installationJobId`) REFERENCES `installation_jobs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
