-- AlterTable
ALTER TABLE `Config` ADD COLUMN `requiresWindowHeight` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Piece` ADD COLUMN `windowHeight` DECIMAL(10, 3) NULL;
