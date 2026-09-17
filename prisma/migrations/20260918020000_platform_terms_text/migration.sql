-- Conserva los PDF existentes; las nuevas versiones pueden guardar texto web.
ALTER TABLE `PlatformTermsVersion`
    MODIFY `fileKey` VARCHAR(100) NULL,
    MODIFY `fileHash` CHAR(64) NULL,
    ADD COLUMN `content` LONGTEXT NULL;
