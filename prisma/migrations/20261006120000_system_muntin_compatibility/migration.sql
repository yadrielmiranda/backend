-- Preserve catalog permissions, never alter saved pieces or their muntin snapshots.
ALTER TABLE `muntin_patterns`
  ADD COLUMN `inputMode` ENUM('NONE', 'GRID', 'PRESET') NOT NULL DEFAULT 'GRID',
  ADD COLUMN `requiresType` BOOLEAN NOT NULL DEFAULT true;
UPDATE `muntin_patterns`
SET `inputMode` = IF(`requiresLites`, 'GRID', 'NONE'), `requiresType` = `requiresLites`;

CREATE TABLE `system_muntin_rules` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `idSystem` INTEGER NOT NULL,
  `patternId` INTEGER NOT NULL,
  `availability` ENUM('ALL', 'SELECTED') NOT NULL,
  `_legacyConfigId` INTEGER NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `muntin_rule_scope_key` (`id`, `idSystem`, `patternId`),
  INDEX `system_muntin_rules_idSystem_patternId_idx` (`idSystem`, `patternId`),
  INDEX `system_muntin_rules_patternId_idx` (`patternId`),
  CONSTRAINT `system_muntin_rules_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `system_muntin_rules_patternId_fkey` FOREIGN KEY (`patternId`) REFERENCES `muntin_patterns` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `system_muntin_rule_types` (
  `ruleId` INTEGER NOT NULL,
  `muntinTypeId` INTEGER NOT NULL,
  PRIMARY KEY (`ruleId`, `muntinTypeId`),
  INDEX `system_muntin_rule_types_muntinTypeId_idx` (`muntinTypeId`),
  CONSTRAINT `system_muntin_rule_types_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `system_muntin_rules` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `system_muntin_rule_types_muntinTypeId_fkey` FOREIGN KEY (`muntinTypeId`) REFERENCES `muntin_types` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `system_muntin_assignments` (
  `idSystem` INTEGER NOT NULL,
  `idConfig` INTEGER NOT NULL,
  `idCrystal` INTEGER NOT NULL,
  `patternId` INTEGER NOT NULL,
  `ruleId` INTEGER NOT NULL,
  PRIMARY KEY (`idSystem`, `idConfig`, `idCrystal`, `patternId`),
  INDEX `system_muntin_assignments_idSystem_idCrystal_idx` (`idSystem`, `idCrystal`),
  INDEX `system_muntin_assignments_ruleId_idSystem_patternId_idx` (`ruleId`, `idSystem`, `patternId`),
  CONSTRAINT `muntin_assignment_config_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf` (`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `muntin_assignment_crystal_fkey` FOREIGN KEY (`idSystem`, `idCrystal`) REFERENCES `system_crystals` (`idSystem`, `idCrystal`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `muntin_assignment_rule_fkey` FOREIGN KEY (`ruleId`, `idSystem`, `patternId`) REFERENCES `system_muntin_rules` (`id`, `idSystem`, `patternId`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Equivalent legacy selections share the first configuration's rule. Comparing
-- sets directly avoids GROUP_CONCAT truncation and preserves inactive type IDs.
CREATE TEMPORARY TABLE `_muntin_backfill` AS
SELECT currentConf.`idSystem`, currentConf.`idConfig`, currentConf.`muntinAvailability`,
  (SELECT MIN(candidate.`idConfig`) FROM `sys_conf` candidate
   WHERE candidate.`idSystem` = currentConf.`idSystem`
     AND candidate.`muntinAvailability` = currentConf.`muntinAvailability`
     AND (currentConf.`muntinAvailability` = 'ALL' OR (
       NOT EXISTS (SELECT 1 FROM `sys_conf_muntin_types` a
         WHERE a.`idSystem` = currentConf.`idSystem` AND a.`idConfig` = currentConf.`idConfig`
           AND NOT EXISTS (SELECT 1 FROM `sys_conf_muntin_types` b
             WHERE b.`idSystem` = candidate.`idSystem` AND b.`idConfig` = candidate.`idConfig` AND b.`muntinTypeId` = a.`muntinTypeId`))
       AND NOT EXISTS (SELECT 1 FROM `sys_conf_muntin_types` b
         WHERE b.`idSystem` = candidate.`idSystem` AND b.`idConfig` = candidate.`idConfig`
           AND NOT EXISTS (SELECT 1 FROM `sys_conf_muntin_types` a
             WHERE a.`idSystem` = currentConf.`idSystem` AND a.`idConfig` = currentConf.`idConfig` AND a.`muntinTypeId` = b.`muntinTypeId`))
     ))) AS `representativeConfigId`
FROM `sys_conf` currentConf
WHERE currentConf.`muntinAvailability` <> 'NONE';

INSERT INTO `system_muntin_rules` (`idSystem`, `patternId`, `availability`, `_legacyConfigId`)
SELECT DISTINCT legacy.`idSystem`, pattern.`id`, legacy.`muntinAvailability`, legacy.`representativeConfigId`
FROM `_muntin_backfill` legacy CROSS JOIN `muntin_patterns` pattern
WHERE pattern.`inputMode` = 'GRID'
  AND EXISTS (SELECT 1 FROM `system_crystals` glass WHERE glass.`idSystem` = legacy.`idSystem`);

INSERT INTO `system_muntin_rule_types` (`ruleId`, `muntinTypeId`)
SELECT rule.`id`, types.`muntinTypeId`
FROM `system_muntin_rules` rule
JOIN `sys_conf_muntin_types` types ON types.`idSystem` = rule.`idSystem` AND types.`idConfig` = rule.`_legacyConfigId`
WHERE rule.`availability` = 'SELECTED';

INSERT INTO `system_muntin_assignments` (`idSystem`, `idConfig`, `idCrystal`, `patternId`, `ruleId`)
SELECT legacy.`idSystem`, legacy.`idConfig`, glass.`idCrystal`, rule.`patternId`, rule.`id`
FROM `_muntin_backfill` legacy
JOIN `system_crystals` glass ON glass.`idSystem` = legacy.`idSystem`
JOIN `system_muntin_rules` rule ON rule.`idSystem` = legacy.`idSystem` AND rule.`_legacyConfigId` = legacy.`representativeConfigId`;

DROP TEMPORARY TABLE `_muntin_backfill`;
ALTER TABLE `system_muntin_rules` DROP COLUMN `_legacyConfigId`;
DROP TABLE `sys_conf_muntin_types`;
ALTER TABLE `sys_conf` DROP COLUMN `muntinAvailability`;
