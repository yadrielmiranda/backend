-- Dealer remains the authorization role. These columns classify dealer
-- accounts commercially without changing the existing RBAC model.
ALTER TABLE `User`
  ADD COLUMN `dealerMode` ENUM('EXTERNAL', 'INTERNAL') NULL,
  ADD COLUMN `dealerAffiliation` ENUM('IMPACT', 'AUTHENTIC') NULL;

UPDATE `User` AS `u`
INNER JOIN `Role` AS `r` ON `r`.`id` = `u`.`idRole`
SET
  `u`.`dealerMode` = 'EXTERNAL',
  `u`.`dealerAffiliation` = 'IMPACT'
WHERE `r`.`name` = 'dealer';

CREATE INDEX `User_dealerMode_dealerAffiliation_idx`
  ON `User`(`dealerMode`, `dealerAffiliation`);

-- Estimates only keep stable inputs needed to create a payment/order. All
-- material profit reporting is stored on Order.
ALTER TABLE `Estimate`
  ADD COLUMN `dealerModeSnapshot` ENUM('EXTERNAL', 'INTERNAL') NULL,
  ADD COLUMN `dealerAffiliationSnapshot` ENUM('IMPACT', 'AUTHENTIC') NULL,
  ADD COLUMN `ownerMarkupSnapshot` DECIMAL(24, 18) NOT NULL DEFAULT 0;

UPDATE `Estimate` AS `e`
INNER JOIN `User` AS `u` ON `u`.`id` = `e`.`idUser`
INNER JOIN `Role` AS `r` ON `r`.`id` = `u`.`idRole`
SET
  `e`.`dealerModeSnapshot` = CASE
    WHEN `r`.`name` = 'dealer' THEN `u`.`dealerMode`
    ELSE NULL
  END,
  `e`.`dealerAffiliationSnapshot` = CASE
    WHEN `r`.`name` = 'dealer' THEN `u`.`dealerAffiliation`
    ELSE NULL
  END,
  `e`.`ownerMarkupSnapshot` = CASE
    WHEN `r`.`name` = 'dealer' AND `u`.`dealerMode` = 'INTERNAL' THEN 0
    ELSE COALESCE(`u`.`markupOverride`, `r`.`markup`, 0)
  END;

-- Material financial snapshots and the Impact/Authentic split.
ALTER TABLE `Order`
  ADD COLUMN `saleSubtotal` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `dealerModeSnapshot` ENUM('EXTERNAL', 'INTERNAL') NULL,
  ADD COLUMN `dealerAffiliationSnapshot` ENUM('IMPACT', 'AUTHENTIC') NULL,
  ADD COLUMN `impactMarkupRate` DECIMAL(24, 18) NOT NULL DEFAULT 0,
  ADD COLUMN `factoryPriceWithMarkup` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `impactProfit` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `authenticProfit` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `factoryPriceWithMarkupReal` DECIMAL(12, 2) NULL,
  ADD COLUMN `impactProfitReal` DECIMAL(12, 2) NULL,
  ADD COLUMN `authenticProfitReal` DECIMAL(12, 2) NULL;

UPDATE `Order` AS `o`
INNER JOIN `Estimate` AS `e` ON `e`.`id` = `o`.`idEst`
SET
  `o`.`dealerModeSnapshot` = `e`.`dealerModeSnapshot`,
  `o`.`dealerAffiliationSnapshot` = `e`.`dealerAffiliationSnapshot`,
  `o`.`saleSubtotal` = CASE
    WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' THEN `e`.`customerPriceT`
    ELSE `e`.`priceT`
  END,
  `o`.`price` = CASE
    WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' THEN `e`.`customerPriceT`
    ELSE `e`.`priceT`
  END,
  `o`.`impactMarkupRate` = CASE
    WHEN `e`.`dealerAffiliationSnapshot` <> 'IMPACT' OR `e`.`dealerAffiliationSnapshot` IS NULL THEN 0
    WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' AND `e`.`priceT` > 0
      THEN (`e`.`customerPriceT` / `e`.`priceT`) - 1
    ELSE `e`.`ownerMarkupSnapshot`
  END,
  `o`.`factoryPriceWithMarkup` = ROUND(
    `o`.`rate` * (1 + CASE
      WHEN `e`.`dealerAffiliationSnapshot` <> 'IMPACT' OR `e`.`dealerAffiliationSnapshot` IS NULL THEN 0
      WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' AND `e`.`priceT` > 0
        THEN (`e`.`customerPriceT` / `e`.`priceT`) - 1
      ELSE `e`.`ownerMarkupSnapshot`
    END),
    2
  ),
  `o`.`impactProfit` = CASE
    WHEN `e`.`dealerAffiliationSnapshot` = 'IMPACT' THEN ROUND(
      (`o`.`rate` * (1 + CASE
        WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' AND `e`.`priceT` > 0
          THEN (`e`.`customerPriceT` / `e`.`priceT`) - 1
        ELSE `e`.`ownerMarkupSnapshot`
      END)) - `o`.`rate`,
      2
    )
    ELSE 0
  END,
  `o`.`authenticProfit` = ROUND(
    (CASE
      WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' THEN `e`.`customerPriceT`
      ELSE `e`.`priceT`
    END) - (`o`.`rate` * (1 + CASE
      WHEN `e`.`dealerAffiliationSnapshot` <> 'IMPACT' OR `e`.`dealerAffiliationSnapshot` IS NULL THEN 0
      WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' AND `e`.`priceT` > 0
        THEN (`e`.`customerPriceT` / `e`.`priceT`) - 1
      ELSE `e`.`ownerMarkupSnapshot`
    END)),
    2
  ),
  `o`.`netProfit` = ROUND(
    (CASE
      WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' THEN `e`.`customerPriceT`
      ELSE `e`.`priceT`
    END) - `o`.`rate`,
    2
  ),
  `o`.`factoryPriceWithMarkupReal` = CASE
    WHEN `o`.`rateReal` IS NULL THEN NULL
    ELSE ROUND(`o`.`rateReal` * (1 + CASE
      WHEN `e`.`dealerAffiliationSnapshot` <> 'IMPACT' OR `e`.`dealerAffiliationSnapshot` IS NULL THEN 0
      WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' AND `e`.`priceT` > 0
        THEN (`e`.`customerPriceT` / `e`.`priceT`) - 1
      ELSE `e`.`ownerMarkupSnapshot`
    END), 2)
  END,
  `o`.`impactProfitReal` = CASE
    WHEN `o`.`rateReal` IS NULL THEN NULL
    WHEN `e`.`dealerAffiliationSnapshot` = 'IMPACT' THEN ROUND(
      (`o`.`rateReal` * (1 + CASE
        WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' AND `e`.`priceT` > 0
          THEN (`e`.`customerPriceT` / `e`.`priceT`) - 1
        ELSE `e`.`ownerMarkupSnapshot`
      END)) - `o`.`rateReal`,
      2
    )
    ELSE 0
  END,
  `o`.`authenticProfitReal` = CASE
    WHEN `o`.`rateReal` IS NULL THEN NULL
    ELSE ROUND(
      (CASE
        WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' THEN `e`.`customerPriceT`
        ELSE `e`.`priceT`
      END) - (`o`.`rateReal` * (1 + CASE
        WHEN `e`.`dealerAffiliationSnapshot` <> 'IMPACT' OR `e`.`dealerAffiliationSnapshot` IS NULL THEN 0
        WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' AND `e`.`priceT` > 0
          THEN (`e`.`customerPriceT` / `e`.`priceT`) - 1
        ELSE `e`.`ownerMarkupSnapshot`
      END)),
      2
    )
  END,
  `o`.`netProfitReal` = CASE
    WHEN `o`.`rateReal` IS NULL THEN NULL
    ELSE ROUND(
      (CASE
        WHEN `e`.`dealerModeSnapshot` = 'INTERNAL' THEN `e`.`customerPriceT`
        ELSE `e`.`priceT`
      END) - `o`.`rateReal`,
      2
    )
  END;

-- Card payments remain the default. Manual methods are recorded only after
-- staff has verified that the funds are already available.
ALTER TABLE `payments`
  ADD COLUMN `payerType` ENUM('ACCOUNT_OWNER', 'CUSTOMER') NOT NULL DEFAULT 'ACCOUNT_OWNER',
  ADD COLUMN `payerName` VARCHAR(201) NULL,
  ADD COLUMN `payerEmail` VARCHAR(150) NULL,
  ADD COLUMN `payerPhone` VARCHAR(30) NULL,
  ADD COLUMN `paymentMethod` ENUM('CARD', 'CHECK', 'ZELLE', 'CASH', 'ACH', 'WIRE', 'OTHER') NOT NULL DEFAULT 'CARD',
  ADD COLUMN `paidAt` DATETIME(3) NULL,
  ADD COLUMN `manualReference` VARCHAR(150) NULL,
  ADD COLUMN `manualNote` VARCHAR(1000) NULL,
  ADD COLUMN `recordedById` INTEGER NULL;

UPDATE `payments` AS `p`
INNER JOIN `User` AS `u` ON `u`.`id` = `p`.`userId`
SET
  `p`.`payerName` = TRIM(CONCAT(`u`.`firstName`, ' ', `u`.`lastName`)),
  `p`.`payerEmail` = `u`.`email`,
  `p`.`payerPhone` = `u`.`phone`,
  `p`.`paidAt` = CASE WHEN `p`.`status` = 'PAID' THEN `p`.`updatedAt` ELSE NULL END;

CREATE INDEX `payments_recordedById_idx` ON `payments`(`recordedById`);

ALTER TABLE `payments`
  ADD CONSTRAINT `payments_recordedById_fkey`
  FOREIGN KEY (`recordedById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
