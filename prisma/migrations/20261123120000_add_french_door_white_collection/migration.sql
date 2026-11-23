-- Add the 27 approved white-collection motifs without changing existing identities or prices.
-- A NULL price keeps a new entry unavailable in estimates until an administrator prices it.
-- Exact existing mappings are skipped; conflicting keys/codes fail the unique constraints.
-- No UPDATE/REPLACE/IGNORE: a collision must not silently reassign or omit a design.
START TRANSACTION;

INSERT INTO `french_door_designs` (`artworkKey`, `code`, `kind`, `unitPrice`)
SELECT catalog.`artworkKey`, catalog.`code`, catalog.`kind`, NULL
FROM (
  SELECT 'SD97' AS `artworkKey`, 'AE-SD-97' AS `code`, 'SINGLE' AS `kind`
  UNION ALL
  SELECT 'SD98', 'AE-SD-98', 'SINGLE'
  UNION ALL
  SELECT 'SD99', 'AE-SD-99', 'SINGLE'
  UNION ALL
  SELECT 'SD100', 'AE-SD-100', 'SINGLE'
  UNION ALL
  SELECT 'SD101', 'AE-SD-101', 'SINGLE'
  UNION ALL
  SELECT 'SD102', 'AE-SD-102', 'SINGLE'
  UNION ALL
  SELECT 'SD103', 'AE-SD-103', 'SINGLE'
  UNION ALL
  SELECT 'SD104', 'AE-SD-104', 'SINGLE'
  UNION ALL
  SELECT 'SD105', 'AE-SD-105', 'SINGLE'
  UNION ALL
  SELECT 'SD106', 'AE-SD-106', 'SINGLE'
  UNION ALL
  SELECT 'SD107', 'AE-SD-107', 'SINGLE'
  UNION ALL
  SELECT 'SD108', 'AE-SD-108', 'SINGLE'
  UNION ALL
  SELECT 'SD109', 'AE-SD-109', 'SINGLE'
  UNION ALL
  SELECT 'SD110', 'AE-SD-110', 'SINGLE'
  UNION ALL
  SELECT 'DD97', 'AE-DD-97', 'DOUBLE'
  UNION ALL
  SELECT 'DD98', 'AE-DD-98', 'DOUBLE'
  UNION ALL
  SELECT 'DD99', 'AE-DD-99', 'DOUBLE'
  UNION ALL
  SELECT 'DD100', 'AE-DD-100', 'DOUBLE'
  UNION ALL
  SELECT 'DD101', 'AE-DD-101', 'DOUBLE'
  UNION ALL
  SELECT 'DD102', 'AE-DD-102', 'DOUBLE'
  UNION ALL
  SELECT 'DD103', 'AE-DD-103', 'DOUBLE'
  UNION ALL
  SELECT 'DD104', 'AE-DD-104', 'DOUBLE'
  UNION ALL
  SELECT 'DD105', 'AE-DD-105', 'DOUBLE'
  UNION ALL
  SELECT 'DD106', 'AE-DD-106', 'DOUBLE'
  UNION ALL
  SELECT 'DD107', 'AE-DD-107', 'DOUBLE'
  UNION ALL
  SELECT 'DD108', 'AE-DD-108', 'DOUBLE'
  UNION ALL
  SELECT 'DD109', 'AE-DD-109', 'DOUBLE'
) AS catalog
WHERE NOT EXISTS (
  SELECT 1 FROM `french_door_designs` AS existing
  WHERE BINARY existing.`artworkKey` = BINARY catalog.`artworkKey`
    AND BINARY existing.`code` = BINARY catalog.`code`
    AND existing.`kind` = catalog.`kind`
);

COMMIT;
