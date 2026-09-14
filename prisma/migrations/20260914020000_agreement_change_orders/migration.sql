ALTER TABLE `EstimateAgreement`
  ADD COLUMN `materialHash` CHAR(64) NULL,
  ADD COLUMN `chargesSnapshot` JSON NULL,
  ADD COLUMN `baseAgreementId` VARCHAR(36) NULL,
  ADD COLUMN `changeOrderNumber` INTEGER NULL;

CREATE INDEX `EstimateAgreement_baseAgreementId_idx`
  ON `EstimateAgreement` (`baseAgreementId`);

ALTER TABLE `EstimateAgreement`
  ADD CONSTRAINT `EstimateAgreement_baseAgreementId_fkey`
  FOREIGN KEY (`baseAgreementId`) REFERENCES `EstimateAgreement` (`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
