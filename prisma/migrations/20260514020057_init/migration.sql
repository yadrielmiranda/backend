-- CreateTable
CREATE TABLE `Role` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `markup` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Role_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `User` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NOT NULL,
    `passwordUpdatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `street` VARCHAR(150) NOT NULL,
    `city` VARCHAR(100) NOT NULL,
    `state` VARCHAR(50) NOT NULL,
    `postalCode` VARCHAR(20) NOT NULL,
    `markupOverride` DECIMAL(10, 4) NULL,
    `isTaxExempt` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `deletedAt` DATETIME(3) NULL,
    `idRole` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_username_key`(`username`),
    UNIQUE INDEX `User_email_key`(`email`),
    UNIQUE INDEX `User_phone_key`(`phone`),
    INDEX `User_isActive_idx`(`isActive`),
    INDEX `User_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `refreshTokenHash` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastRefreshedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `userAgent` VARCHAR(255) NULL,
    `ip` VARCHAR(64) NULL,

    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `branding` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` ENUM('COMPANY', 'DEALER') NOT NULL,
    `userId` INTEGER NULL,
    `name` VARCHAR(150) NOT NULL,
    `phone` VARCHAR(30) NULL,
    `email` VARCHAR(150) NULL,
    `website` VARCHAR(150) NULL,
    `street` VARCHAR(150) NULL,
    `city` VARCHAR(100) NULL,
    `state` VARCHAR(50) NULL,
    `postalCode` VARCHAR(20) NULL,
    `logoUrl` VARCHAR(500) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `branding_userId_key`(`userId`),
    INDEX `branding_type_isActive_idx`(`type`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Brand` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Brand_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Product` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Product_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brand_product` (
    `idBrand` INTEGER NOT NULL,
    `idProduct` INTEGER NOT NULL,

    PRIMARY KEY (`idBrand`, `idProduct`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `System` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `idBrand` INTEGER NOT NULL,
    `idProduct` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `defaultCrystalId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `System_defaultCrystalId_idx`(`defaultCrystalId`),
    INDEX `System_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Config` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `conf` VARCHAR(191) NOT NULL,
    `idProduct` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `requiresWidth` BOOLEAN NOT NULL DEFAULT false,
    `requiresHeight` BOOLEAN NOT NULL DEFAULT false,
    `requiresHeightLeft` BOOLEAN NOT NULL DEFAULT false,
    `requiresHeightRight` BOOLEAN NOT NULL DEFAULT false,
    `requiresLegHeight` BOOLEAN NOT NULL DEFAULT false,
    `muntinLayout` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Config_isActive_idx`(`isActive`),
    INDEX `Config_idProduct_isActive_idx`(`idProduct`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sys_conf` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `allowScreen` BOOLEAN NOT NULL DEFAULT false,
    `defaultActiveOptionId` INTEGER NULL,
    `defaultPreparationOptionId` INTEGER NULL,
    `defaultSillOptionId` INTEGER NULL,
    `defaultReinforcementOptionId` INTEGER NULL,

    INDEX `sys_conf_defaultActiveOptionId_idx`(`defaultActiveOptionId`),
    INDEX `sys_conf_defaultPreparationOptionId_idx`(`defaultPreparationOptionId`),
    INDEX `sys_conf_defaultSillOptionId_idx`(`defaultSillOptionId`),
    INDEX `sys_conf_defaultReinforcementOptionId_idx`(`defaultReinforcementOptionId`),
    PRIMARY KEY (`idSystem`, `idConfig`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_crystals` (
    `idSystem` INTEGER NOT NULL,
    `idCrystal` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `system_crystals_idCrystal_idx`(`idCrystal`),
    PRIMARY KEY (`idSystem`, `idCrystal`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `active_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `active_options_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preparation_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `preparation_options_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sill_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sill_options_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reinforcement_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `reinforcement_options_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_active_options` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `optionId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_active_options_optionId_idx`(`optionId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `optionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_preparation_options` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `optionId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_preparation_options_optionId_idx`(`optionId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `optionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_sill_options` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `optionId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_sill_options_optionId_idx`(`optionId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `optionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_reinforcement_options` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `optionId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_reinforcement_options_optionId_idx`(`optionId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `optionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FrameColor` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `color` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isGlobal` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FrameColor_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_frame_colors` (
    `idSystem` INTEGER NOT NULL,
    `idFrameColor` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `system_frame_colors_idFrameColor_idx`(`idFrameColor`),
    PRIMARY KEY (`idSystem`, `idFrameColor`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Crystal` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `glass` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Crystal_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Tint` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `color` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Tint_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Coating` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Coating_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `muntin_patterns` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `requiresLites` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `muntin_patterns_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `muntin_types` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `muntin_types_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `piece_muntins` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `pieceId` INTEGER NOT NULL,
    `patternId` INTEGER NOT NULL,
    `typeId` INTEGER NULL,
    `totalLites` INTEGER NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `piece_muntins_pieceId_key`(`pieceId`),
    INDEX `piece_muntins_patternId_idx`(`patternId`),
    INDEX `piece_muntins_typeId_idx`(`typeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `piece_muntin_panels` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `pieceMuntinId` INTEGER NOT NULL,
    `panelIndex` INTEGER NOT NULL,
    `panelCode` VARCHAR(20) NULL,
    `panelLabel` VARCHAR(100) NOT NULL,
    `horizontalLites` INTEGER NOT NULL DEFAULT 1,
    `verticalLites` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `piece_muntin_panels_pieceMuntinId_idx`(`pieceMuntinId`),
    UNIQUE INDEX `uq_piece_muntin_panel_index`(`pieceMuntinId`, `panelIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GlobalParameter` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` ENUM('SALES_TAX', 'ESTIMATE_VALID_DAYS') NOT NULL,
    `value` DECIMAL(10, 4) NOT NULL,
    `description` VARCHAR(191) NULL,
    `unit` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GlobalParameter_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pricing_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idBrand` INTEGER NOT NULL,
    `idProduct` INTEGER NOT NULL,
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `idCrystal` INTEGER NOT NULL,
    `costoA` DECIMAL(18, 8) NOT NULL,
    `costoB` DECIMAL(18, 8) NOT NULL,
    `costoC` DECIMAL(18, 8) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `unique_pricing_rule_combination`(`idBrand`, `idProduct`, `idSystem`, `idConfig`, `idCrystal`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EstimateStatus` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `EstimateStatus_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EstimateSequence` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Estimate` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `number` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NULL,
    `units` INTEGER NOT NULL,
    `rateT` DECIMAL(12, 2) NOT NULL,
    `priceT` DECIMAL(12, 2) NOT NULL,
    `netProfit` DECIMAL(12, 2) NOT NULL,
    `taxRate` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `taxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `totalPayable` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `customerPriceT` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `customerTaxRate` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `customerTaxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `customerTotalPayable` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `netProfitD` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `idUser` INTEGER NOT NULL,
    `statusId` INTEGER NOT NULL,
    `customerFirstName` VARCHAR(100) NULL,
    `customerLastName` VARCHAR(100) NULL,
    `customerEmail` VARCHAR(150) NULL,
    `customerPhone` VARCHAR(30) NULL,
    `customerStreet` VARCHAR(150) NULL,
    `customerCity` VARCHAR(100) NULL,
    `customerState` VARCHAR(50) NULL,
    `customerPostalCode` VARCHAR(20) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Estimate_number_key`(`number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Piece` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idEst` INTEGER NOT NULL,
    `mark` VARCHAR(191) NOT NULL,
    `idProd` INTEGER NOT NULL,
    `idBrand` INTEGER NOT NULL,
    `idSyst` INTEGER NOT NULL,
    `idConf` INTEGER NOT NULL,
    `idFC` INTEGER NOT NULL,
    `width` DECIMAL(10, 3) NULL,
    `height` DECIMAL(10, 3) NULL,
    `heightLeft` DECIMAL(10, 3) NULL,
    `heightRight` DECIMAL(10, 3) NULL,
    `legHeight` DECIMAL(10, 3) NULL,
    `idCryst` INTEGER NOT NULL,
    `idTint` INTEGER NOT NULL,
    `privacy` BOOLEAN NOT NULL,
    `idCoat` INTEGER NOT NULL,
    `dpPosPsf` DECIMAL(10, 2) NULL,
    `dpNegPsf` DECIMAL(10, 2) NULL,
    `screen` BOOLEAN NOT NULL,
    `idActiveOption` INTEGER NULL,
    `idPreparationOption` INTEGER NULL,
    `idSillOption` INTEGER NULL,
    `idReinforcementOption` INTEGER NULL,
    `qty` INTEGER NOT NULL,
    `rate` DECIMAL(12, 2) NOT NULL,
    `markup` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `price` DECIMAL(12, 2) NOT NULL,
    `subtotal` DECIMAL(12, 2) NOT NULL,
    `netProfit` DECIMAL(12, 2) NOT NULL,
    `dealerMarkup` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `customerPrice` DECIMAL(12, 2) NOT NULL,
    `customerSubtotal` DECIMAL(12, 2) NOT NULL,
    `netProfitD` DECIMAL(12, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Piece_idEst_idx`(`idEst`),
    INDEX `Piece_idProd_idx`(`idProd`),
    INDEX `Piece_idBrand_idx`(`idBrand`),
    INDEX `Piece_idSyst_idx`(`idSyst`),
    INDEX `Piece_idConf_idx`(`idConf`),
    INDEX `Piece_idActiveOption_idx`(`idActiveOption`),
    INDEX `Piece_idPreparationOption_idx`(`idPreparationOption`),
    INDEX `Piece_idSillOption_idx`(`idSillOption`),
    INDEX `Piece_idReinforcementOption_idx`(`idReinforcementOption`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderStatus` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `OrderStatus_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Order` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `number` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `units` INTEGER NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `price` DECIMAL(12, 2) NOT NULL,
    `rate` DECIMAL(12, 2) NOT NULL,
    `netProfit` DECIMAL(12, 2) NOT NULL,
    `poNumber` VARCHAR(50) NULL,
    `rateReal` DECIMAL(12, 2) NULL,
    `netProfitReal` DECIMAL(12, 2) NULL,
    `idEst` INTEGER NOT NULL,
    `statusId` INTEGER NOT NULL,
    `updateStatus` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `userId` INTEGER NOT NULL,
    `paymentId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Order_number_key`(`number`),
    UNIQUE INDEX `Order_poNumber_key`(`poNumber`),
    UNIQUE INDEX `Order_idEst_key`(`idEst`),
    UNIQUE INDEX `Order_paymentId_key`(`paymentId`),
    INDEX `Order_userId_idx`(`userId`),
    INDEX `Order_statusId_idx`(`statusId`),
    INDEX `Order_date_idx`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `message` VARCHAR(191) NOT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `recipientId` INTEGER NOT NULL,

    INDEX `Notification_recipientId_idx`(`recipientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dimension_policy` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `idCrystal` INTEGER NOT NULL,
    `sizeBasis` ENUM('FRAME', 'DLO') NOT NULL DEFAULT 'FRAME',
    `roundingRule` ENUM('ROUND_UP_TO_NEXT', 'NEAREST') NOT NULL DEFAULT 'ROUND_UP_TO_NEXT',
    `notes` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_policy_sysconf_crystal`(`idSystem`, `idConfig`, `idCrystal`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DimensionRule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idPolicy` INTEGER NOT NULL,
    `widthIn` DECIMAL(10, 3) NOT NULL,
    `heightIn` DECIMAL(10, 3) NOT NULL,
    `dpPosPsf` DECIMAL(10, 2) NOT NULL,
    `dpNegPsf` DECIMAL(10, 2) NOT NULL,
    `screws` INTEGER NOT NULL,
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_rule_policy_dims`(`idPolicy`, `widthIn`, `heightIn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `status` ENUM('PENDING', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `idEst` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'usd',
    `stripeSessionId` VARCHAR(255) NULL,
    `stripePaymentIntentId` VARCHAR(255) NULL,
    `stripeCustomerId` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_idEst_key`(`idEst`),
    UNIQUE INDEX `payments_stripeSessionId_key`(`stripeSessionId`),
    UNIQUE INDEX `payments_stripePaymentIntentId_key`(`stripePaymentIntentId`),
    INDEX `payments_userId_idx`(`userId`),
    INDEX `payments_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `action` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` INTEGER NOT NULL,
    `userId` INTEGER NULL,
    `message` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `event_logs_userId_idx`(`userId`),
    INDEX `event_logs_entityType_idx`(`entityType`),
    INDEX `event_logs_entityId_idx`(`entityId`),
    INDEX `event_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `temp_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `temp_logs_eventId_key`(`eventId`),
    INDEX `temp_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_idRole_fkey` FOREIGN KEY (`idRole`) REFERENCES `Role`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `branding` ADD CONSTRAINT `branding_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `brand_product` ADD CONSTRAINT `brand_product_idBrand_fkey` FOREIGN KEY (`idBrand`) REFERENCES `Brand`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `brand_product` ADD CONSTRAINT `brand_product_idProduct_fkey` FOREIGN KEY (`idProduct`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `System` ADD CONSTRAINT `System_idBrand_idProduct_fkey` FOREIGN KEY (`idBrand`, `idProduct`) REFERENCES `brand_product`(`idBrand`, `idProduct`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `System` ADD CONSTRAINT `System_defaultCrystalId_fkey` FOREIGN KEY (`defaultCrystalId`) REFERENCES `Crystal`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Config` ADD CONSTRAINT `Config_idProduct_fkey` FOREIGN KEY (`idProduct`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_idConfig_fkey` FOREIGN KEY (`idConfig`) REFERENCES `Config`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_defaultActiveOptionId_fkey` FOREIGN KEY (`defaultActiveOptionId`) REFERENCES `active_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_defaultPreparationOptionId_fkey` FOREIGN KEY (`defaultPreparationOptionId`) REFERENCES `preparation_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_defaultSillOptionId_fkey` FOREIGN KEY (`defaultSillOptionId`) REFERENCES `sill_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_defaultReinforcementOptionId_fkey` FOREIGN KEY (`defaultReinforcementOptionId`) REFERENCES `reinforcement_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_crystals` ADD CONSTRAINT `system_crystals_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_crystals` ADD CONSTRAINT `system_crystals_idCrystal_fkey` FOREIGN KEY (`idCrystal`) REFERENCES `Crystal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_active_options` ADD CONSTRAINT `sysconf_active_options_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_active_options` ADD CONSTRAINT `sysconf_active_options_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `active_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_preparation_options` ADD CONSTRAINT `sysconf_preparation_options_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_preparation_options` ADD CONSTRAINT `sysconf_preparation_options_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `preparation_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_sill_options` ADD CONSTRAINT `sysconf_sill_options_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_sill_options` ADD CONSTRAINT `sysconf_sill_options_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `sill_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_reinforcement_options` ADD CONSTRAINT `sysconf_reinforcement_options_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_reinforcement_options` ADD CONSTRAINT `sysconf_reinforcement_options_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `reinforcement_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_frame_colors` ADD CONSTRAINT `system_frame_colors_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_frame_colors` ADD CONSTRAINT `system_frame_colors_idFrameColor_fkey` FOREIGN KEY (`idFrameColor`) REFERENCES `FrameColor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piece_muntins` ADD CONSTRAINT `piece_muntins_pieceId_fkey` FOREIGN KEY (`pieceId`) REFERENCES `Piece`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piece_muntins` ADD CONSTRAINT `piece_muntins_patternId_fkey` FOREIGN KEY (`patternId`) REFERENCES `muntin_patterns`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piece_muntins` ADD CONSTRAINT `piece_muntins_typeId_fkey` FOREIGN KEY (`typeId`) REFERENCES `muntin_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piece_muntin_panels` ADD CONSTRAINT `piece_muntin_panels_pieceMuntinId_fkey` FOREIGN KEY (`pieceMuntinId`) REFERENCES `piece_muntins`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pricing_rules` ADD CONSTRAINT `pricing_rules_idBrand_fkey` FOREIGN KEY (`idBrand`) REFERENCES `Brand`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pricing_rules` ADD CONSTRAINT `pricing_rules_idProduct_fkey` FOREIGN KEY (`idProduct`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pricing_rules` ADD CONSTRAINT `pricing_rules_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pricing_rules` ADD CONSTRAINT `pricing_rules_idConfig_fkey` FOREIGN KEY (`idConfig`) REFERENCES `Config`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pricing_rules` ADD CONSTRAINT `pricing_rules_idCrystal_fkey` FOREIGN KEY (`idCrystal`) REFERENCES `Crystal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Estimate` ADD CONSTRAINT `Estimate_idUser_fkey` FOREIGN KEY (`idUser`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Estimate` ADD CONSTRAINT `Estimate_statusId_fkey` FOREIGN KEY (`statusId`) REFERENCES `EstimateStatus`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idEst_fkey` FOREIGN KEY (`idEst`) REFERENCES `Estimate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idProd_fkey` FOREIGN KEY (`idProd`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idBrand_fkey` FOREIGN KEY (`idBrand`) REFERENCES `Brand`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idSyst_fkey` FOREIGN KEY (`idSyst`) REFERENCES `System`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idConf_fkey` FOREIGN KEY (`idConf`) REFERENCES `Config`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idFC_fkey` FOREIGN KEY (`idFC`) REFERENCES `FrameColor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idCryst_fkey` FOREIGN KEY (`idCryst`) REFERENCES `Crystal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idTint_fkey` FOREIGN KEY (`idTint`) REFERENCES `Tint`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idCoat_fkey` FOREIGN KEY (`idCoat`) REFERENCES `Coating`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idActiveOption_fkey` FOREIGN KEY (`idActiveOption`) REFERENCES `active_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idPreparationOption_fkey` FOREIGN KEY (`idPreparationOption`) REFERENCES `preparation_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idSillOption_fkey` FOREIGN KEY (`idSillOption`) REFERENCES `sill_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idReinforcementOption_fkey` FOREIGN KEY (`idReinforcementOption`) REFERENCES `reinforcement_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_idEst_fkey` FOREIGN KEY (`idEst`) REFERENCES `Estimate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_statusId_fkey` FOREIGN KEY (`statusId`) REFERENCES `OrderStatus`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_recipientId_fkey` FOREIGN KEY (`recipientId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dimension_policy` ADD CONSTRAINT `dimension_policy_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dimension_policy` ADD CONSTRAINT `dimension_policy_idCrystal_fkey` FOREIGN KEY (`idCrystal`) REFERENCES `Crystal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DimensionRule` ADD CONSTRAINT `DimensionRule_idPolicy_fkey` FOREIGN KEY (`idPolicy`) REFERENCES `dimension_policy`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_idEst_fkey` FOREIGN KEY (`idEst`) REFERENCES `Estimate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_logs` ADD CONSTRAINT `event_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `temp_logs` ADD CONSTRAINT `temp_logs_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event_logs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
