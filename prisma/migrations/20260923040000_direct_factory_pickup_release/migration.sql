-- Salida directa desde fábrica, sin entrada ficticia a un Store.
ALTER TABLE `warehouse_movements`
  MODIFY `type` ENUM('COLLECT', 'RECEIVE', 'RELEASE', 'ADJUST', 'PARTS', 'UNDO', 'COUNT', 'COUNT_UNDO', 'TRANSFER', 'FACTORY_RELEASE') NOT NULL;
