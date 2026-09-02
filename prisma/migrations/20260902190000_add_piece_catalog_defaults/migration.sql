-- Permite configurar la selección inicial de Product, Brand y System.
ALTER TABLE `Product`
  ADD COLUMN `isDefault` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `brand_product`
  ADD COLUMN `isDefault` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `System`
  ADD COLUMN `isDefault` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `Product_isDefault_idx`
  ON `Product` (`isDefault`);

CREATE INDEX `brand_product_idProduct_isDefault_idx`
  ON `brand_product` (`idProduct`, `isDefault`);

CREATE INDEX `System_idBrand_idProduct_isDefault_idx`
  ON `System` (`idBrand`, `idProduct`, `isDefault`);

-- Solo asigna defaults automáticamente cuando no existe ninguna ambigüedad.
UPDATE `Product` AS product
INNER JOIN (
  SELECT MIN(`id`) AS `id`
  FROM `Product`
  WHERE `isActive` = true
  HAVING COUNT(*) = 1
) AS singleProduct ON singleProduct.`id` = product.`id`
SET product.`isDefault` = true;

UPDATE `brand_product` AS brandProduct
INNER JOIN (
  SELECT
    association.`idProduct`,
    MIN(association.`idBrand`) AS `idBrand`
  FROM `brand_product` AS association
  INNER JOIN `Brand` AS brand ON brand.`id` = association.`idBrand`
  INNER JOIN `Product` AS product ON product.`id` = association.`idProduct`
  WHERE brand.`isActive` = true
    AND product.`isActive` = true
  GROUP BY association.`idProduct`
  HAVING COUNT(*) = 1
) AS singleBrand
  ON singleBrand.`idProduct` = brandProduct.`idProduct`
 AND singleBrand.`idBrand` = brandProduct.`idBrand`
SET brandProduct.`isDefault` = true;

UPDATE `System` AS systemRow
INNER JOIN (
  SELECT
    `idBrand`,
    `idProduct`,
    MIN(`id`) AS `id`
  FROM `System`
  WHERE `isActive` = true
  GROUP BY `idBrand`, `idProduct`
  HAVING COUNT(*) = 1
) AS singleSystem ON singleSystem.`id` = systemRow.`id`
SET systemRow.`isDefault` = true;
