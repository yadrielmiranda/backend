-- Products are selected before a Brand, so their display order is global.
ALTER TABLE `Product`
  ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

-- Each System belongs to one Brand/Product pair, so this order is naturally
-- scoped by that pair.
ALTER TABLE `System`
  ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

-- Global order is used by the Estimate-level default selectors. Brand-specific
-- order remains on each availability association.
ALTER TABLE `Tint`
  ADD COLUMN `globalSortOrder` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `Coating`
  ADD COLUMN `globalSortOrder` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `FrameColor`
  ADD COLUMN `globalSortOrder` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `brand_tints`
  ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `brand_coatings`
  ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

-- Preserve the current Product and System selector order, which was based on
-- primary-key order before these fields existed.
UPDATE `Product` AS product
INNER JOIN (
  SELECT
    `id`,
    ROW_NUMBER() OVER (ORDER BY `id`) - 1 AS `position`
  FROM `Product`
) AS ranked ON ranked.`id` = product.`id`
SET product.`sortOrder` = ranked.`position`;

UPDATE `System` AS systemRow
INNER JOIN (
  SELECT
    `id`,
    ROW_NUMBER() OVER (
      PARTITION BY `idBrand`, `idProduct`
      ORDER BY `id`
    ) - 1 AS `position`
  FROM `System`
) AS ranked ON ranked.`id` = systemRow.`id`
SET systemRow.`sortOrder` = ranked.`position`;

-- Tint, Coating and Frame Color catalogs were previously alphabetical.
UPDATE `Tint` AS tint
INNER JOIN (
  SELECT
    `id`,
    ROW_NUMBER() OVER (ORDER BY `color`, `id`) - 1 AS `position`
  FROM `Tint`
) AS ranked ON ranked.`id` = tint.`id`
SET tint.`globalSortOrder` = ranked.`position`;

UPDATE `Coating` AS coating
INNER JOIN (
  SELECT
    `id`,
    ROW_NUMBER() OVER (ORDER BY `name`, `id`) - 1 AS `position`
  FROM `Coating`
) AS ranked ON ranked.`id` = coating.`id`
SET coating.`globalSortOrder` = ranked.`position`;

UPDATE `FrameColor` AS frameColor
INNER JOIN (
  SELECT
    `id`,
    ROW_NUMBER() OVER (ORDER BY `color`, `id`) - 1 AS `position`
  FROM `FrameColor`
) AS ranked ON ranked.`id` = frameColor.`id`
SET frameColor.`globalSortOrder` = ranked.`position`;

UPDATE `brand_tints` AS association
INNER JOIN (
  SELECT
    brandTint.`idBrand`,
    brandTint.`idTint`,
    ROW_NUMBER() OVER (
      PARTITION BY brandTint.`idBrand`
      ORDER BY tint.`color`, tint.`id`
    ) - 1 AS `position`
  FROM `brand_tints` AS brandTint
  INNER JOIN `Tint` AS tint ON tint.`id` = brandTint.`idTint`
) AS ranked
  ON ranked.`idBrand` = association.`idBrand`
 AND ranked.`idTint` = association.`idTint`
SET association.`sortOrder` = ranked.`position`;

UPDATE `brand_coatings` AS association
INNER JOIN (
  SELECT
    brandCoating.`idBrand`,
    brandCoating.`idCoating`,
    ROW_NUMBER() OVER (
      PARTITION BY brandCoating.`idBrand`
      ORDER BY coating.`name`, coating.`id`
    ) - 1 AS `position`
  FROM `brand_coatings` AS brandCoating
  INNER JOIN `Coating` AS coating ON coating.`id` = brandCoating.`idCoating`
) AS ranked
  ON ranked.`idBrand` = association.`idBrand`
 AND ranked.`idCoating` = association.`idCoating`
SET association.`sortOrder` = ranked.`position`;

CREATE INDEX `Product_isActive_sortOrder_idx`
  ON `Product` (`isActive`, `sortOrder`);

CREATE INDEX `System_idBrand_idProduct_sortOrder_idx`
  ON `System` (`idBrand`, `idProduct`, `sortOrder`);

CREATE INDEX `Tint_isGlobal_isActive_globalSortOrder_idx`
  ON `Tint` (`isGlobal`, `isActive`, `globalSortOrder`);

CREATE INDEX `Coating_isGlobal_isActive_globalSortOrder_idx`
  ON `Coating` (`isGlobal`, `isActive`, `globalSortOrder`);

CREATE INDEX `FrameColor_isGlobal_isActive_globalSortOrder_idx`
  ON `FrameColor` (`isGlobal`, `isActive`, `globalSortOrder`);

CREATE INDEX `brand_tints_idBrand_sortOrder_idx`
  ON `brand_tints` (`idBrand`, `sortOrder`);

CREATE INDEX `brand_coatings_idBrand_sortOrder_idx`
  ON `brand_coatings` (`idBrand`, `sortOrder`);
