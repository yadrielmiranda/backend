-- Retira la relación de los códigos de verificación.
ALTER TABLE `AgreementChallenge` DROP FOREIGN KEY `AgreementChallenge_agreementId_fkey`;

-- Elimina el correo de verificación que ya no se utiliza.
ALTER TABLE `EstimateAgreement` DROP COLUMN `signerEmail`;

-- Elimina los códigos de verificación por correo.
DROP TABLE `AgreementChallenge`;
