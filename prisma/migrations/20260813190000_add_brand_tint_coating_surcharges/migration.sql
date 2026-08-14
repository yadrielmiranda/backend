-- Global catalog options are eligible for Estimate-level defaults. Actual
-- availability and pricing remain specific to each Brand association.
ALTER TABLE `Tint`
  ADD COLUMN `isGlobal` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `Coating`
  ADD COLUMN `isGlobal` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `brand_tints` (
  `idBrand` INTEGER NOT NULL,
  `idTint` INTEGER NOT NULL,
  `surchargeEnabled` BOOLEAN NOT NULL DEFAULT false,
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `costoA` DECIMAL(24, 20) NULL,
  `costoB` DECIMAL(24, 20) NULL,
  `costoC` DECIMAL(24, 20) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `brand_tints_idTint_idx` (`idTint`),
  INDEX `brand_tints_idBrand_isDefault_idx` (`idBrand`, `isDefault`),
  PRIMARY KEY (`idBrand`, `idTint`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `brand_coatings` (
  `idBrand` INTEGER NOT NULL,
  `idCoating` INTEGER NOT NULL,
  `surchargeEnabled` BOOLEAN NOT NULL DEFAULT false,
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `costoA` DECIMAL(24, 20) NULL,
  `costoB` DECIMAL(24, 20) NULL,
  `costoC` DECIMAL(24, 20) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `brand_coatings_idCoating_idx` (`idCoating`),
  INDEX `brand_coatings_idBrand_isDefault_idx` (`idBrand`, `isDefault`),
  PRIMARY KEY (`idBrand`, `idCoating`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `brand_tints`
  ADD CONSTRAINT `brand_tints_idBrand_fkey`
    FOREIGN KEY (`idBrand`) REFERENCES `Brand` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `brand_tints_idTint_fkey`
    FOREIGN KEY (`idTint`) REFERENCES `Tint` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `brand_coatings`
  ADD CONSTRAINT `brand_coatings_idBrand_fkey`
    FOREIGN KEY (`idBrand`) REFERENCES `Brand` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `brand_coatings_idCoating_fkey`
    FOREIGN KEY (`idCoating`) REFERENCES `Coating` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Before this migration every Tint and Coating was available to every Brand.
-- Preserve that availability, without guessing defaults from option names and
-- without introducing any surcharge until an administrator configures it.
INSERT INTO `brand_tints` (
  `idBrand`, `idTint`, `surchargeEnabled`, `isDefault`, `createdAt`, `updatedAt`
)
SELECT
  brand.`id`, tint.`id`, false, false, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Brand` AS brand
CROSS JOIN `Tint` AS tint;

INSERT INTO `brand_coatings` (
  `idBrand`, `idCoating`, `surchargeEnabled`, `isDefault`, `createdAt`, `updatedAt`
)
SELECT
  brand.`id`, coating.`id`, false, false, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Brand` AS brand
CROSS JOIN `Coating` AS coating;
