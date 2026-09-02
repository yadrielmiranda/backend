-- Cada System puede definir un Frame Color predeterminado.
ALTER TABLE `system_frame_colors`
  ADD COLUMN `isDefault` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `system_frame_colors_idSystem_isDefault_idx`
  ON `system_frame_colors` (`idSystem`, `isDefault`);

-- Conserva como default el primer color según el orden ya configurado.
UPDATE `system_frame_colors` AS target
LEFT JOIN `system_frame_colors` AS previousColor
  ON previousColor.`idSystem` = target.`idSystem`
 AND (
      previousColor.`sortOrder` < target.`sortOrder`
      OR (
        previousColor.`sortOrder` = target.`sortOrder`
        AND previousColor.`idFrameColor` < target.`idFrameColor`
      )
 )
SET target.`isDefault` = true
WHERE previousColor.`idSystem` IS NULL;
