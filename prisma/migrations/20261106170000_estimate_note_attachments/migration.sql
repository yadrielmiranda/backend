CREATE TABLE `EstimateNoteAttachment` (
    `id` CHAR(36) NOT NULL,
    `estimateId` INTEGER NULL,
    `name` VARCHAR(255) NOT NULL,
    `mimeType` VARCHAR(80) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `ready` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EstimateNoteAttachment_estimateId_ready_idx`(`estimateId`, `ready`),
    INDEX `EstimateNoteAttachment_ready_createdAt_idx`(`ready`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `EstimateNoteAttachment_estimateId_fkey` FOREIGN KEY (`estimateId`) REFERENCES `Estimate`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `EstimateNoteAttachmentQuota` (
    `id` INTEGER NOT NULL,
    `usedBytes` BIGINT NOT NULL DEFAULT 0,
    `warned` BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `EstimateNoteAttachmentQuota` (`id`) VALUES (1);
