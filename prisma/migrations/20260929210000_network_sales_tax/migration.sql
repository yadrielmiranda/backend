-- La tasa por relación no modifica exenciones ni estimados ya guardados.
ALTER TABLE `User` ADD COLUMN `networkTaxRate` DECIMAL(10, 4) NULL;
