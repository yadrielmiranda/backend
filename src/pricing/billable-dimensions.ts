import { BadRequestException } from "@nestjs/common";
import { BillableHeightMode } from "@prisma/client";
import Decimal from "decimal.js";

type ResolveBillablePricingDimensionsInput = {
  actualWidthIn: Decimal;
  actualHeightIn: Decimal;
  minimumBillableWidthIn: unknown;
  minimumBillableHeightIn: unknown;
  billableHeightMode?: BillableHeightMode | null;
  billableHeightPercentOfWidth?: unknown;
  billableHeightFixedIn?: unknown;
};

export type BillablePricingDimensions = {
  widthIn: Decimal;
  heightIn: Decimal;
};

function applyBillableMinimum(
  actualValue: Decimal,
  minimumValue: unknown,
  dimensionLabel: "width" | "height",
): Decimal {
  if (minimumValue == null || minimumValue === "") {
    return actualValue;
  }

  const minimum = new Decimal(String(minimumValue));

  if (!minimum.isFinite() || minimum.lte(0)) {
    throw new BadRequestException(
      `Minimum billable ${dimensionLabel} must be greater than zero.`,
    );
  }

  return Decimal.max(actualValue, minimum);
}

export function resolveBillablePricingDimensions({
  actualWidthIn,
  actualHeightIn,
  minimumBillableWidthIn,
  minimumBillableHeightIn,
  billableHeightMode = BillableHeightMode.ACTUAL_HEIGHT,
  billableHeightPercentOfWidth,
  billableHeightFixedIn,
}: ResolveBillablePricingDimensionsInput): BillablePricingDimensions {
  if (!actualWidthIn.isFinite() || actualWidthIn.lte(0)) {
    throw new BadRequestException(
      "Actual width used for pricing must be greater than zero.",
    );
  }

  const widthIn = applyBillableMinimum(
    actualWidthIn,
    minimumBillableWidthIn,
    "width",
  );

  const mode = billableHeightMode ?? BillableHeightMode.ACTUAL_HEIGHT;

  if (mode === BillableHeightMode.FIXED) {
    if (billableHeightFixedIn == null || billableHeightFixedIn === "") {
      throw new BadRequestException(
        "Billable Height Fixed Value is required when Billable Height is Fixed Value.",
      );
    }

    const heightIn = new Decimal(String(billableHeightFixedIn));

    if (!heightIn.isFinite() || heightIn.lt(0)) {
      throw new BadRequestException(
        "Billable Height Fixed Value must be zero or greater.",
      );
    }

    // A fixed commercial value, including zero, must not be replaced by the
    // minimum billable height.
    return { widthIn, heightIn };
  }

  let rawHeightIn: Decimal;

  switch (mode) {
    case BillableHeightMode.ACTUAL_HEIGHT:
      rawHeightIn = actualHeightIn;
      break;
    case BillableHeightMode.WIDTH_PERCENTAGE: {
      if (
        billableHeightPercentOfWidth == null ||
        billableHeightPercentOfWidth === ""
      ) {
        throw new BadRequestException(
          "Billable Height Percentage of Width is required.",
        );
      }

      const percentage = new Decimal(String(billableHeightPercentOfWidth));

      if (!percentage.isFinite() || percentage.lte(0)) {
        throw new BadRequestException(
          "Billable Height Percentage of Width must be greater than zero.",
        );
      }

      rawHeightIn = actualWidthIn.mul(percentage).div(100);
      break;
    }
    default:
      throw new BadRequestException("Unsupported Billable Height mode.");
  }

  if (!rawHeightIn.isFinite() || rawHeightIn.lte(0)) {
    throw new BadRequestException(
      "Height used for pricing must be greater than zero.",
    );
  }

  return {
    widthIn,
    heightIn: applyBillableMinimum(
      rawHeightIn,
      minimumBillableHeightIn,
      "height",
    ),
  };
}
