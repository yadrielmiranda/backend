-- Add the configurable, non-refundable installation deposit.
ALTER TABLE `GlobalParameter`
  MODIFY `key` ENUM(
    'SALES_TAX',
    'ESTIMATE_VALID_DAYS',
    'INSTALLATION_DEPOSIT',
    'INSTALLATION_PERMIT_FEE',
    'CARD_SURCHARGE_PERCENT'
  ) NOT NULL;

ALTER TABLE `installation_jobs`
  ADD COLUMN `depositAmountSnapshot` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `depositTermsSnapshot` VARCHAR(1000) NULL,
  ADD COLUMN `depositTermsAcceptedAt` DATETIME(3) NULL,
  ADD COLUMN `cancellationReason` VARCHAR(1000) NULL,
  MODIFY `status` ENUM(
    'REQUESTED',
    'DEPOSIT_PAYMENT_PENDING',
    'MEASUREMENT_SCHEDULING',
    'MEASUREMENT_SCHEDULED',
    'MEASUREMENT_PENDING',
    'QUOTE_DRAFT',
    'ADMIN_APPROVAL_PENDING',
    'CUSTOMER_APPROVAL_PENDING',
    'APPROVED',
    'PERMIT_PAYMENT_PENDING',
    'PERMIT_PROCESSING',
    'MATERIAL_PAYMENT_PENDING',
    'MATERIAL_PAID',
    'INSTALLATION_PAYMENT_PENDING',
    'INSTALLATION_PAID',
    'SCHEDULING',
    'SCHEDULED',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELED'
  ) NOT NULL DEFAULT 'REQUESTED';

-- Remeasurement and installation appointments have independent histories.
ALTER TABLE `installation_appointments`
  ADD COLUMN `type` ENUM('REMEASUREMENT', 'INSTALLATION')
    NOT NULL DEFAULT 'INSTALLATION' AFTER `jobId`,
  DROP INDEX `installation_appointments_jobId_status_startsAt_idx`,
  ADD INDEX `installation_appointments_jobId_type_status_startsAt_idx`
    (`jobId`, `type`, `status`, `startsAt`);

ALTER TABLE `payments`
  MODIFY `type` ENUM(
    'MATERIAL',
    'INSTALLATION_DEPOSIT',
    'PERMIT',
    'INSTALLATION',
    'EXTRA'
  ) NOT NULL DEFAULT 'MATERIAL';
