-- Update the explanation without changing the configured limit or unit.
UPDATE `GlobalParameter`
SET `description` = 'Material-only estimates without payments require 100% upfront at or below this amount. Set 0 to disable.'
WHERE `key` = 'MATERIAL_ONLY_UPFRONT_THRESHOLD';
