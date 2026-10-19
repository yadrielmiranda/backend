-- Existing materials keep their current single-unit workflows.
ALTER TABLE `material_products`
    ADD COLUMN `allowBaseUnitOperations` BOOLEAN NOT NULL DEFAULT true;
