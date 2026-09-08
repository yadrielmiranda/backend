-- Registra únicamente las autorizaciones expresas de los nuevos registros.
CREATE TABLE `RegistrationConsent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NULL,
    `phone` VARCHAR(20) NOT NULL,
    `email` VARCHAR(150) NOT NULL,
    `serviceSmsAccepted` BOOLEAN NOT NULL,
    `serviceEmailAccepted` BOOLEAN NOT NULL,
    `promotionalSmsAccepted` BOOLEAN NOT NULL DEFAULT false,
    `promotionalEmailAccepted` BOOLEAN NOT NULL DEFAULT false,
    `consentVersion` VARCHAR(64) NOT NULL,
    `consentText` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `RegistrationConsent_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `RegistrationConsent` ADD CONSTRAINT `RegistrationConsent_userId_fkey`
FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
