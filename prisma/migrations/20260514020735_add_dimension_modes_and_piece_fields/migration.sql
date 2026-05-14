-- AlterTable
ALTER TABLE `Piece` ADD COLUMN `doorWidth` DECIMAL(10, 3) NULL,
    ADD COLUMN `horizontalHeights` JSON NULL,
    ADD COLUMN `leftPanels` INTEGER NULL,
    ADD COLUMN `leftSideliteWidth` DECIMAL(10, 3) NULL,
    ADD COLUMN `panelCount` INTEGER NULL,
    ADD COLUMN `rightPanels` INTEGER NULL,
    ADD COLUMN `rightSideliteWidth` DECIMAL(10, 3) NULL;

-- AlterTable
ALTER TABLE `sys_conf` ADD COLUMN `dimensionMode` ENUM('STANDARD', 'ECO_WINDOWS_DOOR', 'ECO_NOVO_DOOR', 'WINDOW_WALL') NOT NULL DEFAULT 'STANDARD';
