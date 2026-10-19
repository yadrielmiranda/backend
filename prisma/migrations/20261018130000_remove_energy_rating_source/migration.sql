-- Energy ratings retain catalog relationships and values only.
ALTER TABLE `energy_ratings`
    DROP COLUMN `sourceFile`,
    DROP COLUMN `sourceSheet`,
    DROP COLUMN `sourceRow`,
    DROP COLUMN `sourceVersion`,
    DROP COLUMN `sourceGlassId`,
    DROP COLUMN `composition`,
    DROP COLUMN `notes`;

-- Keep any captured values unchanged while removing the old optional metadata.
UPDATE `Piece`
SET `energySnapshot` = JSON_REMOVE(`energySnapshot`, '$.source')
WHERE JSON_CONTAINS_PATH(`energySnapshot`, 'one', '$.source') = 1;
