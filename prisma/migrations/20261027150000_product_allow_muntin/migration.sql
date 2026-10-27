ALTER TABLE `Product` ADD COLUMN `allowMuntin` BOOLEAN NOT NULL DEFAULT true;

UPDATE `Product`
SET `allowMuntin` = false
WHERE `diagramFamily` = 'GARAGE_DOOR' OR `kind` = 'LINEAR_MATERIAL';
