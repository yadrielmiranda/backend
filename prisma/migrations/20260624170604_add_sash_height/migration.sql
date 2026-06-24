-- AlterTable
ALTER TABLE `Config` ADD COLUMN `requiresSashHeight` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Piece` ADD COLUMN `sashHeight` DECIMAL(10, 3) NULL;
