ALTER TABLE `sys_conf`
  ADD COLUMN `billableHeightMode` ENUM(
    'ACTUAL_HEIGHT',
    'WIDTH_PERCENTAGE',
    'FIXED'
  ) NOT NULL DEFAULT 'ACTUAL_HEIGHT',
  ADD COLUMN `billableHeightPercentOfWidth` DECIMAL(10, 3) NULL,
  ADD COLUMN `billableHeightFixedIn` DECIMAL(10, 3) NULL;
