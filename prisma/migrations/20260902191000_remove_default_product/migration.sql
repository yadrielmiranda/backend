-- Product debe seleccionarse manualmente al crear una pieza.
DROP INDEX `Product_isDefault_idx` ON `Product`;

ALTER TABLE `Product`
  DROP COLUMN `isDefault`;
