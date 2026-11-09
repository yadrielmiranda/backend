-- Keep the existing six integer digits and retain fractional markup precision.
-- Existing role rates and historical estimate snapshots are not recalculated.
ALTER TABLE `Role` MODIFY `markup` DECIMAL(24, 18) NOT NULL DEFAULT 0;
