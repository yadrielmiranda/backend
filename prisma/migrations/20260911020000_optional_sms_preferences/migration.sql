-- Separa la preferencia promocional SIN reiniciar el SMS de servicio ni el historial.
ALTER TABLE `SmsConsent`
    ADD COLUMN `promotionsEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `promotionsConsentVersion` VARCHAR(64) NULL,
    ADD COLUMN `promotionsConsentText` TEXT NULL,
    ADD COLUMN `promotionsConsentedAt` DATETIME(3) NULL,
    ADD COLUMN `promotionsRevokedAt` DATETIME(3) NULL;

ALTER TABLE `SmsConsentEvent`
    ADD COLUMN `category` VARCHAR(16) NULL;

-- Conserva las promociones que ya habían sido aceptadas. Copia la fecha y prueba
-- originales, NO registra una nueva aceptación ni altera RegistrationConsent.
-- STOP, cambios de teléfono y bajas anteriores siguen teniendo efecto.
INSERT INTO `SmsConsent` (
    `userId`, `phone`, `enabled`, `promotionsEnabled`,
    `promotionsConsentVersion`, `promotionsConsentText`,
    `promotionsConsentedAt`, `updatedAt`
)
SELECT
    r.`userId`, r.`phone`, false, true,
    r.`consentVersion`, r.`consentText`, r.`createdAt`, r.`createdAt`
FROM `RegistrationConsent` r
JOIN `User` u ON u.`id` = r.`userId`
LEFT JOIN `SmsConsent` s ON s.`userId` = r.`userId`
WHERE r.`promotionalSmsAccepted` = true
  AND u.`isActive` = true AND u.`deletedAt` IS NULL
  AND u.`phone` = r.`phone`
  AND (s.`userId` IS NULL OR s.`phone` = r.`phone`)
  AND NOT EXISTS (
      SELECT 1 FROM `SmsPhoneBlock` b WHERE b.`phone` = r.`phone`
  )
  AND NOT EXISTS (
      SELECT 1 FROM `SmsConsentEvent` e
      WHERE e.`createdAt` >= r.`createdAt`
        AND (
            (e.`action` IN ('PHONE_CHANGED', 'ACCOUNT_DISABLED') AND e.`userId` = r.`userId`)
            OR (e.`action` = 'PROVIDER_STOP' AND e.`phone` = r.`phone`)
        )
  )
ON DUPLICATE KEY UPDATE
    `promotionsEnabled` = true,
    `promotionsConsentVersion` = VALUES(`promotionsConsentVersion`),
    `promotionsConsentText` = VALUES(`promotionsConsentText`),
    `promotionsConsentedAt` = VALUES(`promotionsConsentedAt`);
