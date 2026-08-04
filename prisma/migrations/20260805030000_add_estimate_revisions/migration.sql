-- Field measurements now capture every dimension that can affect a Piece.
ALTER TABLE `installation_measurements`
  ADD COLUMN `sashHeightIn` DECIMAL(10, 3) NULL AFTER `legHeightIn`,
  ADD COLUMN `windowHeightIn` DECIMAL(10, 3) NULL AFTER `sashHeightIn`,
  ADD COLUMN `horizontalHeights` JSON NULL AFTER `panelCount`;

-- A revision freezes the original and proposed material totals that accompany
-- one installation-quote version. The live Estimate is changed only after the
-- customer approves this record.
CREATE TABLE `estimate_revisions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `estimateId` INTEGER NOT NULL,
  `installationJobId` INTEGER NOT NULL,
  `quoteId` INTEGER NOT NULL,
  `version` INTEGER NOT NULL,
  `status` ENUM(
    'DRAFT',
    'PENDING_ADMIN_APPROVAL',
    'PENDING_CUSTOMER_APPROVAL',
    'APPROVED',
    'REJECTED',
    'SUPERSEDED'
  ) NOT NULL DEFAULT 'DRAFT',
  `reason` ENUM('REMEASUREMENT', 'PERMIT_REVISION', 'FIELD_CHANGE')
    NOT NULL DEFAULT 'REMEASUREMENT',
  `originalTotals` JSON NOT NULL,
  `revisedTotals` JSON NOT NULL,
  `createdById` INTEGER NOT NULL,
  `submittedAt` DATETIME(3) NULL,
  `approvedAt` DATETIME(3) NULL,
  `rejectedAt` DATETIME(3) NULL,
  `appliedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `estimate_revisions_quoteId_key` (`quoteId`),
  UNIQUE INDEX `uq_estimate_revision_job_version` (`installationJobId`, `version`),
  INDEX `estimate_revisions_estimateId_status_idx` (`estimateId`, `status`),
  INDEX `estimate_revisions_createdById_idx` (`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `estimate_revision_items` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `revisionId` INTEGER NOT NULL,
  `measurementId` INTEGER NOT NULL,
  `originalPieceId` INTEGER NULL,
  `sourceUnitIndex` INTEGER NOT NULL,
  `action` ENUM('UNCHANGED', 'UPDATE', 'REPLACE', 'REMOVE') NOT NULL,
  `reason` ENUM(
    'REMEASUREMENT',
    'EGRESS',
    'DIMENSION_LIMITS',
    'STRUCTURAL_CONDITION',
    'CUSTOMER_REQUEST',
    'OTHER'
  ) NOT NULL DEFAULT 'REMEASUREMENT',
  `reasonNote` VARCHAR(1000) NULL,
  `originalSnapshot` JSON NOT NULL,
  `proposedPieceInput` JSON NULL,
  `calculatedSnapshot` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_estimate_revision_measurement` (`revisionId`, `measurementId`),
  INDEX `estimate_revision_items_measurementId_idx` (`measurementId`),
  INDEX `estimate_revision_items_originalPieceId_sourceUnitIndex_idx`
    (`originalPieceId`, `sourceUnitIndex`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `estimate_revisions`
  ADD CONSTRAINT `estimate_revisions_estimateId_fkey`
    FOREIGN KEY (`estimateId`) REFERENCES `Estimate`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `estimate_revisions_installationJobId_fkey`
    FOREIGN KEY (`installationJobId`) REFERENCES `installation_jobs`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `estimate_revisions_quoteId_fkey`
    FOREIGN KEY (`quoteId`) REFERENCES `installation_quotes`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `estimate_revisions_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `estimate_revision_items`
  ADD CONSTRAINT `estimate_revision_items_revisionId_fkey`
    FOREIGN KEY (`revisionId`) REFERENCES `estimate_revisions`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `estimate_revision_items_measurementId_fkey`
    FOREIGN KEY (`measurementId`) REFERENCES `installation_measurements`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
