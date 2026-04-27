/*
  Warnings:

  - Made the column `panelLabel` on table `piece_muntin_panels` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `piece_muntin_panels` MODIFY `panelCode` VARCHAR(20) NULL,
    MODIFY `panelLabel` VARCHAR(100) NOT NULL;
