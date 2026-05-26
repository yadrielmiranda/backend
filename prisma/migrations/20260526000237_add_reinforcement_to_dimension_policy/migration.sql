/*
  Warnings:

  - A unique constraint covering the columns `[idSystem,idConfig,idCrystal,idReinforcementOption]` on the table `dimension_policy` will be added. If there are existing duplicate values, this will fail.

*/

-- DropForeignKey
ALTER TABLE `dimension_policy` DROP FOREIGN KEY `dimension_policy_idSystem_idConfig_fkey`;

-- DropIndex
DROP INDEX `uq_policy_sysconf_crystal` ON `dimension_policy`;

-- AlterTable
ALTER TABLE `dimension_policy` ADD COLUMN `idReinforcementOption` INTEGER NULL;

-- CreateIndex
CREATE INDEX `idx_dimension_policy_sysconf` ON `dimension_policy`(`idSystem`, `idConfig`);

-- CreateIndex
CREATE INDEX `idx_dimension_policy_reinforcement` ON `dimension_policy`(`idReinforcementOption`);

-- CreateIndex
CREATE UNIQUE INDEX `uq_policy_sysconf_crystal_reinf` ON `dimension_policy`(`idSystem`, `idConfig`, `idCrystal`, `idReinforcementOption`);

-- AddForeignKey
ALTER TABLE `dimension_policy`
ADD CONSTRAINT `dimension_policy_idSystem_idConfig_fkey`
FOREIGN KEY (`idSystem`, `idConfig`)
REFERENCES `sys_conf`(`idSystem`, `idConfig`)
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dimension_policy`
ADD CONSTRAINT `dimension_policy_idReinforcementOption_fkey`
FOREIGN KEY (`idReinforcementOption`)
REFERENCES `reinforcement_options`(`id`)
ON DELETE RESTRICT
ON UPDATE CASCADE;