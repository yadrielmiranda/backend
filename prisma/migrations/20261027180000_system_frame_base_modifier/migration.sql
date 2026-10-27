ALTER TABLE `system_frame_colors`
  ADD COLUMN `modifierEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `basePriceMultiplier` DECIMAL(38, 20) NOT NULL DEFAULT 1,
  ADD COLUMN `basePriceDeduction` DECIMAL(38, 20) NOT NULL DEFAULT 0;
