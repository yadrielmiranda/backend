ALTER TABLE `Piece` ADD COLUMN `frameColorBeforeDesignId` INTEGER NULL;

CREATE INDEX `Piece_frameColorBeforeDesignId_idx` ON `Piece`(`frameColorBeforeDesignId`);

ALTER TABLE `Piece` ADD CONSTRAINT `Piece_frameColorBeforeDesignId_fkey`
  FOREIGN KEY (`frameColorBeforeDesignId`) REFERENCES `FrameColor`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
