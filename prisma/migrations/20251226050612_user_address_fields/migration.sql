/*
  Warnings:

  - You are about to drop the column `address` on the `user` table. All the data in the column will be lost.
  - Added the required column `city` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `postalCode` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `state` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `street` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `user` DROP COLUMN `address`,
    ADD COLUMN `city` VARCHAR(100) NOT NULL,
    ADD COLUMN `postalCode` VARCHAR(20) NOT NULL,
    ADD COLUMN `state` VARCHAR(50) NOT NULL,
    ADD COLUMN `street` VARCHAR(150) NOT NULL;
