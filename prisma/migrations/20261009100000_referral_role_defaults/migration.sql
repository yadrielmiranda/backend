-- Defaults are inherited by both existing and future eligible accounts.
CREATE TABLE `ReferralRoleDefault` (
    `role` ENUM('CLIENT', 'DISTRIBUTOR', 'SUBDEALER_INTERNAL', 'SUBDEALER_EXTERNAL', 'DEALER_EXTERNAL', 'DEALER_INTERNAL') NOT NULL,
    `mode` ENUM('EXTERNAL_MARGIN', 'CUSTOM_PERCENT', 'DEALER_PLAN') NOT NULL DEFAULT 'CUSTOM_PERCENT',
    `percent` DECIMAL(7,4) NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`role`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ReferralProfile`
    ADD COLUMN `useRoleDefaults` BOOLEAN NOT NULL DEFAULT true,
    ALTER COLUMN `enabled` SET DEFAULT true;

-- Keep deliberately saved individual arrangements, including deliberate disabling.
UPDATE `ReferralProfile` SET `useRoleDefaults` = false
WHERE `revision` > 1 OR `percent` IS NOT NULL OR `enabled` = true OR `mode` = 'DEALER_PLAN';
-- Profiles only created by opening the old dashboard were never configured.
UPDATE `ReferralProfile` SET `enabled` = true WHERE `useRoleDefaults` = true;

INSERT INTO `ReferralRoleDefault` (`role`, `mode`, `percent`, `updatedAt`) VALUES
('CLIENT', 'CUSTOM_PERCENT', 0, CURRENT_TIMESTAMP(3)),
('DISTRIBUTOR', 'CUSTOM_PERCENT', 0, CURRENT_TIMESTAMP(3)),
('SUBDEALER_INTERNAL', 'CUSTOM_PERCENT', 0, CURRENT_TIMESTAMP(3)),
('SUBDEALER_EXTERNAL', 'CUSTOM_PERCENT', 0, CURRENT_TIMESTAMP(3)),
('DEALER_EXTERNAL', 'EXTERNAL_MARGIN', NULL, CURRENT_TIMESTAMP(3)),
('DEALER_INTERNAL', 'CUSTOM_PERCENT', 0, CURRENT_TIMESTAMP(3));
