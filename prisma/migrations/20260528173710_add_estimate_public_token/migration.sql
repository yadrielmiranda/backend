/*
  Warnings:

  - A unique constraint covering the columns `[publicToken]` on the table `Estimate` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `estimate` ADD COLUMN `publicToken` VARCHAR(64) NULL,
    ADD COLUMN `publicTokenCreatedAt` DATETIME(3) NULL,
    ADD COLUMN `publicTokenEnabled` BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX `Estimate_publicToken_key` ON `Estimate`(`publicToken`);
