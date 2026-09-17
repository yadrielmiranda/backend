CREATE TABLE `PlatformTermsVersion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fileKey` VARCHAR(100) NOT NULL,
    `fileHash` CHAR(64) NOT NULL,
    `sourceHash` CHAR(64) NOT NULL,
    `originalName` VARCHAR(255) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `consentText` VARCHAR(500) NOT NULL,
    `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `publishedById` INTEGER NULL,
    UNIQUE INDEX `PlatformTermsVersion_fileKey_key`(`fileKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlatformTermsState` (
    `id` INTEGER NOT NULL,
    `currentVersionId` INTEGER NULL,
    UNIQUE INDEX `PlatformTermsState_currentVersionId_key`(`currentVersionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlatformTermsAcceptance` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `versionId` INTEGER NOT NULL,
    `acceptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `source` VARCHAR(20) NOT NULL,
    INDEX `PlatformTermsAcceptance_versionId_idx`(`versionId`),
    UNIQUE INDEX `PlatformTermsAcceptance_userId_versionId_key`(`userId`, `versionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PlatformTermsVersion` ADD CONSTRAINT `PlatformTermsVersion_publishedById_fkey` FOREIGN KEY (`publishedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `PlatformTermsState` ADD CONSTRAINT `PlatformTermsState_currentVersionId_fkey` FOREIGN KEY (`currentVersionId`) REFERENCES `PlatformTermsVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PlatformTermsAcceptance` ADD CONSTRAINT `PlatformTermsAcceptance_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PlatformTermsAcceptance` ADD CONSTRAINT `PlatformTermsAcceptance_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `PlatformTermsVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Se activa al publicar el primer documento, sin inventar aceptaciones previas.
INSERT INTO `PlatformTermsState` (`id`, `currentVersionId`) VALUES (1, NULL);
