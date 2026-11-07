CREATE TABLE `french_door_designs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `artworkKey` VARCHAR(64) NOT NULL,
  `code` VARCHAR(80) NOT NULL,
  `kind` ENUM('SINGLE','DOUBLE') NOT NULL,
  `unitPrice` DECIMAL(12,2) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `french_door_designs_artworkKey_key` (`artworkKey`),
  UNIQUE INDEX `french_door_designs_code_key` (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `sys_conf_door_designs` (
  `idSystem` INTEGER NOT NULL,
  `idConfig` INTEGER NOT NULL,
  `idDoorDesign` INTEGER NOT NULL,
  PRIMARY KEY (`idSystem`, `idConfig`, `idDoorDesign`),
  INDEX `sys_conf_door_designs_idDoorDesign_idx` (`idDoorDesign`),
  CONSTRAINT `sys_conf_door_designs_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`,`idConfig`) REFERENCES `sys_conf` (`idSystem`,`idConfig`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sys_conf_door_designs_idDoorDesign_fkey` FOREIGN KEY (`idDoorDesign`) REFERENCES `french_door_designs` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Piece`
  ADD COLUMN `idDoorDesign` INTEGER NULL,
  ADD COLUMN `doorDesignSnapshot` JSON NULL,
  ADD INDEX `Piece_idDoorDesign_idx` (`idDoorDesign`),
  ADD CONSTRAINT `Piece_idDoorDesign_fkey` FOREIGN KEY (`idDoorDesign`) REFERENCES `french_door_designs` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Set a price and choose compatible configurations in Settings before quoting.
INSERT INTO `french_door_designs` (`artworkKey`, `code`, `kind`)
VALUES ('SD01', 'OLD-SD-01', 'SINGLE'), ('DD01', 'OLD-DD-01', 'DOUBLE');
