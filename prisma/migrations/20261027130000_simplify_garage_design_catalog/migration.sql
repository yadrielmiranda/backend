-- Design patterns use their name and image. Design colors use their name and hex color.
-- Preserve catalog records, IDs, compatibility links and saved piece references.
ALTER TABLE `design_patterns` DROP INDEX `design_patterns_code_key`, DROP COLUMN `code`;
ALTER TABLE `design_colors` DROP COLUMN `textureUrl`;
