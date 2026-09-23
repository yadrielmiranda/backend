-- La entrega directa consume tránsito y conserva el destino sin crear existencias.
ALTER TABLE `warehouse_movements`
  MODIFY `type` ENUM('COLLECT', 'RECEIVE', 'RELEASE', 'ADJUST', 'PARTS', 'UNDO', 'COUNT', 'COUNT_UNDO', 'TRANSFER', 'FACTORY_RELEASE', 'INSTALLATION_DELIVERY') NOT NULL,
  ADD COLUMN `installationJobId` INTEGER NULL,
  ADD COLUMN `installationAddress` VARCHAR(500) NULL,
  ADD INDEX `warehouse_movements_installationJobId_id_idx` (`installationJobId`, `id`),
  ADD CONSTRAINT `warehouse_movements_installationJobId_fkey`
    FOREIGN KEY (`installationJobId`) REFERENCES `installation_jobs` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
