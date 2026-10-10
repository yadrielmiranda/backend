-- Preserve four-decimal inch boundaries without reducing the seven integer digits.
ALTER TABLE `pricing_ranges`
    MODIFY `minWidthIn` DECIMAL(11, 4) NULL,
    MODIFY `maxWidthIn` DECIMAL(11, 4) NULL,
    MODIFY `minHeightIn` DECIMAL(11, 4) NULL,
    MODIFY `maxHeightIn` DECIMAL(11, 4) NULL;
