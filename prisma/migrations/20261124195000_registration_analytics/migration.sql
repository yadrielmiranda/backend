CREATE TABLE registration_analytics_attempts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  campaign VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ad VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stage TINYINT UNSIGNED NOT NULL,
  errors TINYINT UNSIGNED NOT NULL DEFAULT 0,
  opened_at DATETIME(3) NOT NULL,
  activity_at DATETIME(3) NOT NULL,
  INDEX registration_analytics_opened (opened_at)
) DEFAULT CHARACTER SET utf8mb4;
