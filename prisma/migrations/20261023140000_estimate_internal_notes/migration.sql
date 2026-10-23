-- Optional internal notes are stored separately from estimate amounts and documents.
CREATE TABLE `EstimateInternalNote` (
  `estimateId` INTEGER NOT NULL,
  `text` TEXT NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `updatedAt` DATETIME(3) NOT NULL,
  `updatedById` INTEGER NULL,

  INDEX `EstimateInternalNote_updatedById_idx` (`updatedById`),
  PRIMARY KEY (`estimateId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `EstimateInternalNote`
  ADD CONSTRAINT `EstimateInternalNote_estimateId_fkey`
    FOREIGN KEY (`estimateId`) REFERENCES `Estimate` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `EstimateInternalNote_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
