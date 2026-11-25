ALTER TABLE `DealerRegistrationRequest` DROP COLUMN `preferredLanguage`;
ALTER TABLE `User` DROP COLUMN `preferredLanguage`;

-- Preserve the type of welcome already queued. Delivery status and attempts stay intact.
-- A finite LIMIT permits these updates in safe mode. An INT primary key allows
-- at most 2^32 distinct rows, so this bound includes every queued approval.
ALTER TABLE `AccountWelcomeEmail` ADD COLUMN `isDealerApproval` BOOLEAN NOT NULL DEFAULT false;
UPDATE `AccountWelcomeEmail` SET `isDealerApproval` = true WHERE `approvalLanguage` IS NOT NULL
ORDER BY `userId` LIMIT 4294967296;
ALTER TABLE `AccountWelcomeEmail` DROP COLUMN `approvalLanguage`;

ALTER TABLE `AccountWelcomeSms` ADD COLUMN `isDealerApproval` BOOLEAN NOT NULL DEFAULT false;
UPDATE `AccountWelcomeSms` SET `isDealerApproval` = true WHERE `approvalLanguage` IS NOT NULL
ORDER BY `userId` LIMIT 4294967296;
ALTER TABLE `AccountWelcomeSms` DROP COLUMN `approvalLanguage`;

ALTER TABLE `DealerRegistrationRejectionDelivery` DROP COLUMN `language`;
