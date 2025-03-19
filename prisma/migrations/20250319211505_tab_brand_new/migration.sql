/*
  Warnings:

  - You are about to drop the column `code` on the `estimate` table. All the data in the column will be lost.
  - You are about to drop the column `total` on the `estimate` table. All the data in the column will be lost.
  - Added the required column `netProfit` to the `Estimate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `number` to the `Estimate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `priceT` to the `Estimate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `project` to the `Estimate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `rateT` to the `Estimate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `mark` to the `Piece` table without a default value. This is not possible if the table is not empty.
  - Added the required column `markup` to the `Piece` table without a default value. This is not possible if the table is not empty.
  - Added the required column `netProfit` to the `Piece` table without a default value. This is not possible if the table is not empty.
  - Added the required column `qty` to the `Piece` table without a default value. This is not possible if the table is not empty.
  - Added the required column `rate` to the `Piece` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subtotal` to the `Piece` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `estimate` DROP COLUMN `code`,
    DROP COLUMN `total`,
    ADD COLUMN `netProfit` INTEGER NOT NULL,
    ADD COLUMN `number` VARCHAR(191) NOT NULL,
    ADD COLUMN `priceT` DECIMAL(65, 30) NOT NULL,
    ADD COLUMN `project` VARCHAR(191) NOT NULL,
    ADD COLUMN `rateT` DECIMAL(65, 30) NOT NULL;

-- AlterTable
ALTER TABLE `piece` ADD COLUMN `mark` VARCHAR(191) NOT NULL,
    ADD COLUMN `markup` INTEGER NOT NULL,
    ADD COLUMN `netProfit` DECIMAL(65, 30) NOT NULL,
    ADD COLUMN `qty` INTEGER NOT NULL,
    ADD COLUMN `rate` DECIMAL(65, 30) NOT NULL,
    ADD COLUMN `subtotal` DECIMAL(65, 30) NOT NULL;
