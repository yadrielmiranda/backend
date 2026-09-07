-- Conserva el rol de cada promoción existente antes de retirar el campo individual.
ALTER TABLE `Promotion` ADD COLUMN `roleIds` JSON NULL;

UPDATE `Promotion`
SET `roleIds` = CASE
    WHEN `audience` = 'ROLE' AND `roleId` IS NOT NULL THEN JSON_ARRAY(`roleId`)
    ELSE JSON_ARRAY()
END;

ALTER TABLE `Promotion`
    MODIFY COLUMN `roleIds` JSON NOT NULL,
    DROP COLUMN `roleId`;
