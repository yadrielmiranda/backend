CREATE TABLE `system_design_color_modifiers` (
  `idSystem` INTEGER NOT NULL,
  `idDesignColor` INTEGER NOT NULL,
  `modifierEnabled` BOOLEAN NOT NULL DEFAULT false,
  `basePriceMultiplier` DECIMAL(38, 20) NOT NULL DEFAULT 1,
  `basePriceDeduction` DECIMAL(38, 20) NOT NULL DEFAULT 0,
  INDEX `system_design_color_modifiers_idDesignColor_idx` (`idDesignColor`),
  PRIMARY KEY (`idSystem`, `idDesignColor`),
  CONSTRAINT `system_design_color_modifiers_idSystem_fkey`
    FOREIGN KEY (`idSystem`) REFERENCES `System` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `system_design_color_modifiers_idDesignColor_fkey`
    FOREIGN KEY (`idDesignColor`) REFERENCES `design_colors` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `system_design_color_modifiers` (`idSystem`, `idDesignColor`)
SELECT DISTINCT `idSystem`, `idDesignColor` FROM `system_design_options`;
