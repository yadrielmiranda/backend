-- Privacy is now a catalog option selected per Brand instead of a boolean.
CREATE TABLE `Privacy` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Privacy_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `brand_privacies` (
    `idBrand` INTEGER NOT NULL,
    `idPrivacy` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `surchargeEnabled` BOOLEAN NOT NULL DEFAULT false,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `costoA` DECIMAL(24, 20) NULL,
    `costoB` DECIMAL(24, 20) NULL,
    `costoC` DECIMAL(24, 20) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `brand_privacies_idPrivacy_idx`(`idPrivacy`),
    INDEX `brand_privacies_idBrand_isDefault_idx`(`idBrand`, `isDefault`),
    INDEX `brand_privacies_idBrand_sortOrder_idx`(`idBrand`, `sortOrder`),
    PRIMARY KEY (`idBrand`, `idPrivacy`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Piece`
  ADD COLUMN `idPrivacy` INTEGER NULL;

CREATE INDEX `Piece_idPrivacy_idx` ON `Piece`(`idPrivacy`);

ALTER TABLE `brand_privacies`
  ADD CONSTRAINT `brand_privacies_idBrand_fkey`
    FOREIGN KEY (`idBrand`) REFERENCES `Brand`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `brand_privacies_idPrivacy_fkey`
    FOREIGN KEY (`idPrivacy`) REFERENCES `Privacy`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `Piece`
  ADD CONSTRAINT `Piece_idPrivacy_fkey`
    FOREIGN KEY (`idPrivacy`) REFERENCES `Privacy`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed a no-surcharge option so existing Brands remain usable immediately.
-- Application behavior does not depend on this name and it can be renamed.
INSERT INTO `Privacy` (`name`, `isActive`, `createdAt`, `updatedAt`)
VALUES ('None', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT INTO `brand_privacies` (
  `idBrand`,
  `idPrivacy`,
  `sortOrder`,
  `surchargeEnabled`,
  `isDefault`,
  `costoA`,
  `costoB`,
  `costoC`,
  `createdAt`,
  `updatedAt`
)
SELECT
  brand.`id`,
  privacyOption.`id`,
  0,
  false,
  true,
  NULL,
  NULL,
  NULL,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `Brand` AS brand
CROSS JOIN `Privacy` AS privacyOption
WHERE privacyOption.`name` = 'None';

-- Existing glazed pieces become the no-surcharge option. Linear materials
-- intentionally keep idPrivacy NULL because they do not use glass options.
UPDATE `Piece` AS piece
INNER JOIN `Product` AS product ON product.`id` = piece.`idProd`
CROSS JOIN `Privacy` AS privacyOption
SET piece.`idPrivacy` = privacyOption.`id`
WHERE product.`kind` = 'GLAZED_UNIT'
  AND privacyOption.`name` = 'None';

ALTER TABLE `Piece`
  DROP COLUMN `privacy`;
