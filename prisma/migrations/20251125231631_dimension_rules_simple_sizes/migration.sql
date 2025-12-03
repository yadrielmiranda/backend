/*
  Warnings:

  - You are about to drop the column `anchorsPerJamb` on the `dimension_rule` table. All the data in the column will be lost.
  - You are about to drop the column `extraAnchorFlag` on the `dimension_rule` table. All the data in the column will be lost.
  - You are about to drop the column `maxHeightIn` on the `dimension_rule` table. All the data in the column will be lost.
  - You are about to drop the column `maxWidthIn` on the `dimension_rule` table. All the data in the column will be lost.
  - You are about to drop the column `minHeightIn` on the `dimension_rule` table. All the data in the column will be lost.
  - You are about to drop the column `minWidthIn` on the `dimension_rule` table. All the data in the column will be lost.
  - You are about to alter the column `dpPosPsf` on the `dimension_rule` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `Decimal(7,3)`.
  - You are about to alter the column `dpNegPsf` on the `dimension_rule` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `Decimal(7,3)`.
  - A unique constraint covering the columns `[idPolicy,widthIn,heightIn]` on the table `dimension_rule` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `heightIn` to the `dimension_rule` table without a default value. This is not possible if the table is not empty.
  - Added the required column `widthIn` to the `dimension_rule` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX `dimension_rule_minWidthIn_maxWidthIn_minHeightIn_maxHeightIn_idx` ON `dimension_rule`;

-- AlterTable
ALTER TABLE `dimension_rule` DROP COLUMN `anchorsPerJamb`,
    DROP COLUMN `extraAnchorFlag`,
    DROP COLUMN `maxHeightIn`,
    DROP COLUMN `maxWidthIn`,
    DROP COLUMN `minHeightIn`,
    DROP COLUMN `minWidthIn`,
    ADD COLUMN `heightIn` DECIMAL(10, 3) NOT NULL,
    ADD COLUMN `screws` INTEGER NULL,
    ADD COLUMN `widthIn` DECIMAL(10, 3) NOT NULL,
    MODIFY `dpPosPsf` DECIMAL(7, 3) NOT NULL,
    MODIFY `dpNegPsf` DECIMAL(7, 3) NOT NULL,
    MODIFY `note` VARCHAR(255) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `dimension_rule_idPolicy_widthIn_heightIn_key` ON `dimension_rule`(`idPolicy`, `widthIn`, `heightIn`);
