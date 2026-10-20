-- Add typed tracking without rewriting existing quantities or movement history.
ALTER TABLE `warehouse_stock`
  ADD COLUMN `partBalances` JSON NULL;

ALTER TABLE `warehouse_movements`
  ADD COLUMN `partDetails` JSON NULL;

ALTER TABLE `warehouse_count_lines`
  ADD COLUMN `partDetails` JSON NULL;
