-- Remove unit metadata only; keep all catalog values and captured metrics unchanged.
UPDATE `Piece`
SET `energySnapshot` = JSON_REMOVE(`energySnapshot`, '$.units'),
    `updatedAt` = `updatedAt`
WHERE JSON_CONTAINS_PATH(`energySnapshot`, 'one', '$.units') = 1;

-- Existing snapshot units are strings. Remove their exact paths one at a time.
-- JSON_REMOVE preserves array positions and unrelated quantity fields named units.
-- The default recursion limit fails safely for an unexpectedly large document;
-- there is no depth cutoff that could silently leave a partially cleaned snapshot.

WITH RECURSIVE cleaned AS (
    SELECT `id`, `before` AS document
    FROM `temp_logs`
    WHERE JSON_SEARCH(`before`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `temp_logs` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`before` = cleaned.document
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

WITH RECURSIVE cleaned AS (
    SELECT `id`, `after` AS document
    FROM `temp_logs`
    WHERE JSON_SEARCH(`after`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `temp_logs` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`after` = cleaned.document
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

WITH RECURSIVE cleaned AS (
    SELECT `id`, `meta` AS document
    FROM `temp_logs`
    WHERE JSON_SEARCH(`meta`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `temp_logs` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`meta` = cleaned.document
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

WITH RECURSIVE cleaned AS (
    SELECT `id`, `items` AS document
    FROM `material_revisions`
    WHERE JSON_SEARCH(`items`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `material_revisions` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`items` = cleaned.document,
    target.`updatedAt` = target.`updatedAt`
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

WITH RECURSIVE cleaned AS (
    SELECT `id`, `proposal` AS document
    FROM `material_revisions`
    WHERE JSON_SEARCH(`proposal`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `material_revisions` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`proposal` = cleaned.document,
    target.`updatedAt` = target.`updatedAt`
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

WITH RECURSIVE cleaned AS (
    SELECT `id`, `sourceSnapshot` AS document
    FROM `installation_measurements`
    WHERE JSON_SEARCH(`sourceSnapshot`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `installation_measurements` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`sourceSnapshot` = cleaned.document,
    target.`updatedAt` = target.`updatedAt`
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

WITH RECURSIVE cleaned AS (
    SELECT `id`, `originalSnapshot` AS document
    FROM `estimate_revision_items`
    WHERE JSON_SEARCH(`originalSnapshot`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `estimate_revision_items` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`originalSnapshot` = cleaned.document,
    target.`updatedAt` = target.`updatedAt`
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

WITH RECURSIVE cleaned AS (
    SELECT `id`, `calculatedSnapshot` AS document
    FROM `estimate_revision_items`
    WHERE JSON_SEARCH(`calculatedSnapshot`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `estimate_revision_items` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`calculatedSnapshot` = cleaned.document,
    target.`updatedAt` = target.`updatedAt`
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

WITH RECURSIVE cleaned AS (
    SELECT `id`, `snapshot` AS document
    FROM `EstimateAgreement`
    WHERE JSON_SEARCH(`snapshot`, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
    UNION ALL
    SELECT `id`, JSON_REMOVE(document, JSON_UNQUOTE(JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units')))
    FROM cleaned
    WHERE JSON_SEARCH(document, 'one', '%', NULL, '$**.energySnapshot.units') IS NOT NULL
)
UPDATE `EstimateAgreement` AS target
JOIN cleaned ON cleaned.id = target.id
SET target.`snapshot` = cleaned.document
WHERE JSON_SEARCH(cleaned.document, 'one', '%', NULL, '$**.energySnapshot.units') IS NULL;

ALTER TABLE `energy_ratings` DROP COLUMN `units`;

