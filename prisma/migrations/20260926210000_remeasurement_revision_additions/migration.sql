-- Amplía las acciones; conserva las revisiones, piezas y pagos existentes.
ALTER TABLE `estimate_revision_items`
  MODIFY `action` ENUM('UNCHANGED', 'UPDATE', 'REPLACE', 'REMOVE', 'ADD') NOT NULL;
