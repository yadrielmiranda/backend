-- Registra la autorización sin alterar depósitos ni citas existentes.
ALTER TABLE `installation_jobs` ADD COLUMN `dealerMeasurementsAcceptedAt` DATETIME(3) NULL,
    ADD COLUMN `dealerMeasurementsAcceptedById` INTEGER NULL;

ALTER TABLE `installation_quotes` MODIFY `approvalReason` ENUM('REMEASUREMENT', 'PERMIT_REVISION', 'FIELD_CHANGE', 'DEALER_MEASUREMENTS') NOT NULL DEFAULT 'REMEASUREMENT';

ALTER TABLE `estimate_revisions` MODIFY `reason` ENUM('REMEASUREMENT', 'PERMIT_REVISION', 'FIELD_CHANGE', 'DEALER_MEASUREMENTS') NOT NULL DEFAULT 'REMEASUREMENT';

CREATE INDEX `installation_jobs_dealerMeasurementsAcceptedById_idx` ON `installation_jobs`(`dealerMeasurementsAcceptedById`);

ALTER TABLE `installation_jobs` ADD CONSTRAINT `installation_jobs_dealerMeasurementsAcceptedById_fkey` FOREIGN KEY (`dealerMeasurementsAcceptedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
