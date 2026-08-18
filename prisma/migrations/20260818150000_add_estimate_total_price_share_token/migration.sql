ALTER TABLE `Estimate`
  ADD COLUMN `publicTotalToken` VARCHAR(64) NULL,
  ADD UNIQUE INDEX `Estimate_publicTotalToken_key` (`publicTotalToken`);
