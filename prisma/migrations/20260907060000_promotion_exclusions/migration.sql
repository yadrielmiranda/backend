-- Las promociones existentes comienzan sin exclusiones.
ALTER TABLE `Promotion`
    ADD COLUMN `excludedProductIds` JSON NULL,
    ADD COLUMN `excludedSystemIds` JSON NULL;

UPDATE `Promotion`
SET `excludedProductIds` = JSON_ARRAY(),
    `excludedSystemIds` = JSON_ARRAY();

ALTER TABLE `Promotion`
    MODIFY COLUMN `excludedProductIds` JSON NOT NULL,
    MODIFY COLUMN `excludedSystemIds` JSON NOT NULL;
