-- Catálogo administrable. La migración anterior se conserva para instalaciones
-- que ya recibieron la primera entrega, sin modificar su historial de Prisma.
CREATE TABLE `DealerEarningsPlan` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `basis` ENUM('DEALER_MARKUP', 'EXPECTED_PROFIT', 'REAL_PROFIT') NOT NULL,
  `percent` DECIMAL(7,4) NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `DealerEarningsPlan_name_key` (`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `User` ADD COLUMN `dealerEarningsPlanId` INTEGER NULL;

-- Se convierten las condiciones que realmente existen en planes compartidos.
-- No se siembran tres planes fijos ni se modifica ningún estimado histórico.
INSERT INTO `DealerEarningsPlan` (`name`, `basis`, `percent`, `updatedAt`)
SELECT DISTINCT
  CONCAT('Migrated ',
    CASE `dealerEarningsType`
      WHEN 'FULL_MARKUP' THEN 'dealer markup'
      WHEN 'EXPECTED_PROFIT_PERCENT' THEN 'expected profit'
      ELSE 'real profit' END,
    ' ', CAST(CASE WHEN `dealerEarningsType` = 'FULL_MARKUP' THEN 100.0000
      ELSE `dealerEarningsPercent` END AS CHAR), '%'),
  CASE `dealerEarningsType`
    WHEN 'FULL_MARKUP' THEN 'DEALER_MARKUP'
    WHEN 'EXPECTED_PROFIT_PERCENT' THEN 'EXPECTED_PROFIT'
    ELSE 'REAL_PROFIT' END,
  CASE WHEN `dealerEarningsType` = 'FULL_MARKUP' THEN 100.0000 ELSE `dealerEarningsPercent` END,
  CURRENT_TIMESTAMP(3)
FROM `User`
WHERE `dealerMode` = 'INTERNAL';

UPDATE `User` u JOIN `DealerEarningsPlan` p ON
  p.`basis` = CASE u.`dealerEarningsType`
    WHEN 'FULL_MARKUP' THEN 'DEALER_MARKUP'
    WHEN 'EXPECTED_PROFIT_PERCENT' THEN 'EXPECTED_PROFIT'
    ELSE 'REAL_PROFIT' END
  AND p.`percent` = CASE WHEN u.`dealerEarningsType` = 'FULL_MARKUP' THEN 100.0000
    ELSE u.`dealerEarningsPercent` END
SET u.`dealerEarningsPlanId` = p.`id`
WHERE u.`dealerMode` = 'INTERNAL';

ALTER TABLE `User`
  ADD INDEX `User_dealerEarningsPlanId_idx` (`dealerEarningsPlanId`),
  ADD CONSTRAINT `User_dealerEarningsPlanId_fkey` FOREIGN KEY (`dealerEarningsPlanId`)
    REFERENCES `DealerEarningsPlan` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN `dealerEarningsType`,
  DROP COLUMN `dealerEarningsPercent`;
