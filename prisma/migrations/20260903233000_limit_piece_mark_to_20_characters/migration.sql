-- Ajusta primero cualquier dato histórico para que el cambio de tipo sea seguro.
UPDATE `Piece`
SET `mark` = LEFT(`mark`, 20)
WHERE CHAR_LENGTH(`mark`) > 20;

ALTER TABLE `Piece`
  MODIFY `mark` VARCHAR(20) NOT NULL;
