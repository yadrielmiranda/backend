ALTER TABLE `Notification`
  ADD COLUMN `actionUrl` VARCHAR(500) NULL,
  ADD COLUMN `actionLabel` VARCHAR(80) NULL,
  ADD COLUMN `dedupeKey` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `uq_notification_recipient_dedupe`
  ON `Notification`(`recipientId`, `dedupeKey`);
