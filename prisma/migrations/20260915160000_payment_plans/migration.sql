-- AlterTable
ALTER TABLE `Role` ADD COLUMN `paymentPlanId` INTEGER NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `paymentPlanId` INTEGER NULL;

-- AlterTable
ALTER TABLE `Estimate` ADD COLUMN `paymentPlanSnapshot` JSON NULL;

-- AlterTable
ALTER TABLE `payments` MODIFY `type` ENUM('INSTALLMENT', 'MATERIAL', 'INSTALLATION_DEPOSIT', 'PERMIT', 'INSTALLATION', 'DELIVERY', 'EXTRA') NOT NULL DEFAULT 'MATERIAL';

-- CreateTable
CREATE TABLE `PaymentPlan` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `definition` JSON NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PaymentPlan_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Role` ADD CONSTRAINT `Role_paymentPlanId_fkey` FOREIGN KEY (`paymentPlanId`) REFERENCES `PaymentPlan`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_paymentPlanId_fkey` FOREIGN KEY (`paymentPlanId`) REFERENCES `PaymentPlan`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Los estimados anteriores conservan su flujo y sus pagos. Las nuevas cotizaciones guardan el plan asignado.
INSERT INTO `PaymentPlan` (`name`, `definition`, `updatedAt`) VALUES ('Material upfront / installation before work', '{"withInstallation":[{"milestone":"ORDER","basis":"MATERIAL","percent":100},{"milestone":"INSTALL","basis":"INSTALLATION","percent":100}],"withoutInstallation":[{"milestone":"ORDER","basis":"MATERIAL","percent":100}]}', CURRENT_TIMESTAMP(3));
INSERT INTO `PaymentPlan` (`name`, `definition`, `updatedAt`) VALUES ('Project 50 / 40 / 10', '{"withInstallation":[{"milestone":"ORDER","basis":"PROJECT","percent":50},{"milestone":"RELEASE","basis":"PROJECT","percent":40},{"milestone":"COMPLETE","basis":"PROJECT","percent":10}],"withoutInstallation":[{"milestone":"ORDER","basis":"MATERIAL","percent":50},{"milestone":"RELEASE","basis":"MATERIAL","percent":50}]}', CURRENT_TIMESTAMP(3));
INSERT INTO `PaymentPlan` (`name`, `definition`, `updatedAt`) VALUES ('Material 50 / 50 + installation 50 / 50', '{"withInstallation":[{"milestone":"ORDER","basis":"MATERIAL","percent":50},{"milestone":"RELEASE","basis":"MATERIAL","percent":50},{"milestone":"INSTALL","basis":"INSTALLATION","percent":50},{"milestone":"COMPLETE","basis":"INSTALLATION","percent":50}],"withoutInstallation":[{"milestone":"ORDER","basis":"MATERIAL","percent":50},{"milestone":"RELEASE","basis":"MATERIAL","percent":50}]}', CURRENT_TIMESTAMP(3));
