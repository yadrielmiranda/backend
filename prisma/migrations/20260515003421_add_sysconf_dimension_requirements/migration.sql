-- AlterTable
ALTER TABLE `sys_conf` ADD COLUMN `requiresDoorWidth` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresHeight` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresHeightLeft` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresHeightRight` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresHorizontalHeights` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresLeftPanels` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresLeftSideliteWidth` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresLegHeight` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresPanelCount` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresRightPanels` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresRightSideliteWidth` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresWidth` BOOLEAN NOT NULL DEFAULT false;
