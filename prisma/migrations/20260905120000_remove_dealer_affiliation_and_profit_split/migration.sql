-- Dealer mode remains the only commercial dealer classification. Removing
-- the affiliation column does not delete or reclassify any existing user.
DROP INDEX `User_dealerMode_dealerAffiliation_idx` ON `User`;
CREATE INDEX `User_dealerMode_idx` ON `User`(`dealerMode`);

ALTER TABLE `User`
  DROP COLUMN `dealerAffiliation`;

-- Estimates keep only the dealer mode and pricing inputs required by the
-- established payment/order flow.
ALTER TABLE `Estimate`
  DROP COLUMN `dealerAffiliationSnapshot`;

-- netProfit and netProfitReal already contain the complete estimated and real
-- material profit. The former company-split columns are therefore redundant.
ALTER TABLE `Order`
  DROP COLUMN `dealerAffiliationSnapshot`,
  DROP COLUMN `impactMarkupRate`,
  DROP COLUMN `factoryPriceWithMarkup`,
  DROP COLUMN `impactProfit`,
  DROP COLUMN `authenticProfit`,
  DROP COLUMN `factoryPriceWithMarkupReal`,
  DROP COLUMN `impactProfitReal`,
  DROP COLUMN `authenticProfitReal`;
