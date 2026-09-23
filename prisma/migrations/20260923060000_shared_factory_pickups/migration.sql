-- Conserva los creadores y el historial de las recogidas anteriores.
-- El índice nuevo mantiene el soporte de la FK antes de quitar la exclusividad por persona.
CREATE INDEX `factory_pickup_runs_createdById_idx` ON `factory_pickup_runs`(`technicianId`);
ALTER TABLE `factory_pickup_runs`
  DROP INDEX `factory_pickup_runs_technicianId_activeSlot_key`,
  ADD COLUMN `closedById` INTEGER NULL,
  ADD COLUMN `cycle` INTEGER NOT NULL DEFAULT 0;
CREATE INDEX `factory_pickup_runs_closedById_idx` ON `factory_pickup_runs`(`closedById`);
ALTER TABLE `factory_pickup_runs` ADD CONSTRAINT `factory_pickup_runs_closedById_fkey`
  FOREIGN KEY (`closedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `factory_pickup_run_technicians` (
  `pickupRunId` INTEGER NOT NULL,
  `technicianId` INTEGER NOT NULL,
  `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`pickupRunId`, `technicianId`),
  INDEX `factory_pickup_run_technicians_technicianId_pickupRunId_idx` (`technicianId`, `pickupRunId`),
  CONSTRAINT `factory_pickup_run_technicians_pickupRunId_fkey`
    FOREIGN KEY (`pickupRunId`) REFERENCES `factory_pickup_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `factory_pickup_run_technicians_technicianId_fkey`
    FOREIGN KEY (`technicianId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Antes solo el creador podía cerrar; se conserva ese autor en los cierres históricos.
UPDATE `factory_pickup_runs` SET `closedById` = `technicianId` WHERE `status` <> 'ACTIVE';
INSERT INTO `factory_pickup_run_technicians` (`pickupRunId`, `technicianId`, `assignedAt`)
  SELECT p.`id`, p.`technicianId`, p.`createdAt`
  FROM `factory_pickup_runs` p
  JOIN `User` u ON u.`id` = p.`technicianId`
  JOIN `Role` r ON r.`id` = u.`idRole`
  WHERE r.`name` = 'technician';

CREATE TABLE `factory_pickup_run_events` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `pickupRunId` INTEGER NOT NULL,
  `actorId` INTEGER NOT NULL,
  `status` ENUM('ACTIVE', 'COMPLETED', 'PARTIAL') NOT NULL,
  `cycle` INTEGER NOT NULL,
  `partialReason` ENUM('NOT_READY_AT_FACTORY', 'MANUFACTURER_HELD_MATERIAL', 'DAMAGED_NOT_ACCEPTED', 'OTHER') NULL,
  `note` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `factory_pickup_run_events_pickupRunId_cycle_status_key` (`pickupRunId`, `cycle`, `status`),
  INDEX `factory_pickup_run_events_actorId_idx` (`actorId`),
  CONSTRAINT `factory_pickup_run_events_pickupRunId_fkey`
    FOREIGN KEY (`pickupRunId`) REFERENCES `factory_pickup_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `factory_pickup_run_events_actorId_fkey`
    FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO `factory_pickup_run_events` (`pickupRunId`, `actorId`, `status`, `cycle`, `partialReason`, `note`, `createdAt`)
  SELECT `id`, `closedById`, `status`, 0, `partialReason`, `note`, COALESCE(`finishedAt`, `updatedAt`)
  FROM `factory_pickup_runs` WHERE `status` <> 'ACTIVE';
