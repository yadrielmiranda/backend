-- Añade historial independiente; no modifica órdenes, pagos ni permisos existentes.
CREATE TABLE `material_revisions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `estimateId` INTEGER NOT NULL,
  `version` INTEGER NOT NULL,
  `activeSlot` INTEGER NULL DEFAULT 1,
  `status` ENUM('DRAFT','PENDING_APPROVAL','AWAITING_SIGNATURE','APPLIED','REJECTED','CANCELED') NOT NULL DEFAULT 'DRAFT',
  `reason` VARCHAR(1000) NOT NULL,
  `baseHash` CHAR(64) NOT NULL,
  `items` JSON NOT NULL,
  `proposal` JSON NULL,
  `originalSummary` JSON NOT NULL,
  `revisedSummary` JSON NULL,
  `requiresSignature` BOOLEAN NOT NULL DEFAULT false,
  `factoryNotSentConfirmedAt` DATETIME(3) NULL,
  `createdById` INTEGER NOT NULL,
  `approvedById` INTEGER NULL,
  `submittedAt` DATETIME(3) NULL,
  `approvedAt` DATETIME(3) NULL,
  `appliedAt` DATETIME(3) NULL,
  `closedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `material_revisions_estimateId_version_key` (`estimateId`,`version`),
  UNIQUE INDEX `material_revisions_estimateId_activeSlot_key` (`estimateId`,`activeSlot`),
  INDEX `material_revisions_estimateId_status_idx` (`estimateId`,`status`),
  CONSTRAINT `material_revisions_estimateId_fkey` FOREIGN KEY (`estimateId`) REFERENCES `Estimate` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `EstimateAgreement` ADD COLUMN `materialRevisionId` INTEGER NULL;
ALTER TABLE `EstimateAgreement` ADD CONSTRAINT `EstimateAgreement_materialRevisionId_fkey` FOREIGN KEY (`materialRevisionId`) REFERENCES `material_revisions` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
