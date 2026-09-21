-- Conserva la precisión del costo del fabricante sin alterar los valores existentes.
ALTER TABLE `Order` MODIFY `rateReal` DECIMAL(18, 8) NULL;

-- Solo se guarda el vínculo; las características permanecen en Piece.
CREATE TABLE `factory_units` (
    `lineNumber` VARCHAR(50) NOT NULL,
    `pieceId` INTEGER NOT NULL,
    INDEX `factory_units_pieceId_idx` (`pieceId`),
    PRIMARY KEY (`lineNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `factory_units` ADD CONSTRAINT `factory_units_pieceId_fkey`
    FOREIGN KEY (`pieceId`) REFERENCES `Piece` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
