/*
  Warnings:

  - A unique constraint covering the columns `[number]` on the table `Estimate` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX `Estimate_number_key` ON `Estimate`(`number`);
