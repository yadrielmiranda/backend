-- Los PDF de términos se utilizaron solamente en pruebas locales.
-- Elimina esas versiones y sus aceptaciones de prueba; conserva las versiones de texto.
START TRANSACTION;

UPDATE `PlatformTermsState` AS s
INNER JOIN `PlatformTermsVersion` AS v ON v.`id` = s.`currentVersionId`
SET s.`currentVersionId` = NULL
WHERE v.`content` IS NULL;

DELETE a FROM `PlatformTermsAcceptance` AS a
INNER JOIN `PlatformTermsVersion` AS v ON v.`id` = a.`versionId`
WHERE v.`content` IS NULL;

DELETE FROM `PlatformTermsVersion` WHERE `content` IS NULL;

COMMIT;

ALTER TABLE `PlatformTermsVersion`
    DROP INDEX `PlatformTermsVersion_fileKey_key`,
    DROP COLUMN `fileKey`,
    DROP COLUMN `fileHash`,
    MODIFY `content` LONGTEXT NOT NULL;
