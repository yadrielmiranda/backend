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

-- AddForeignKey
ALTER TABLE `branding` ADD CONSTRAINT `branding_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
