-- Repara EstimateSequence si la tabla falta por schema drift.
CREATE TABLE IF NOT EXISTS `EstimateSequence` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Reconstruye las secuencias conocidas usando la fórmula:
-- Estimate.number = 190909 + EstimateSequence.id
INSERT IGNORE INTO `EstimateSequence` (`id`, `createdAt`)
SELECT
    CAST(`number` AS UNSIGNED) - 190909,
    `date`
FROM `Estimate`
WHERE `number` REGEXP '^[0-9]+$'
  AND CAST(`number` AS UNSIGNED) > 190909;