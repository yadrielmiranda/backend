ALTER TABLE `design_colors`
  ADD COLUMN `idFrameColor` INTEGER NULL,
  ADD CONSTRAINT `design_colors_idFrameColor_fkey`
    FOREIGN KEY (`idFrameColor`) REFERENCES `FrameColor`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
