/*
  Warnings:

  - A unique constraint covering the columns `[idPolicy,ruleType,widthIn,heightIn]` on the table `DimensionRule` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `DimensionRule` ADD COLUMN `ruleType` ENUM('MAIN', 'DOOR', 'SIDELITE') NOT NULL DEFAULT 'MAIN';

-- CreateIndex
CREATE INDEX `idx_rule_policy_type` ON `DimensionRule`(`idPolicy`, `ruleType`);

-- CreateIndex
CREATE INDEX `idx_rule_policy_type_dims` ON `DimensionRule`(`idPolicy`, `ruleType`, `widthIn`, `heightIn`);

-- CreateIndex
CREATE UNIQUE INDEX `uq_rule_policy_type_dims` ON `DimensionRule`(`idPolicy`, `ruleType`, `widthIn`, `heightIn`);
