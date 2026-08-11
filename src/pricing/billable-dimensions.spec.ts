import { BillableHeightMode } from "@prisma/client";
import Decimal from "decimal.js";

import { resolveBillablePricingDimensions } from "./billable-dimensions";

describe("resolveBillablePricingDimensions", () => {
  const resolve = (
    overrides: Partial<
      Parameters<typeof resolveBillablePricingDimensions>[0]
    > = {},
  ) =>
    resolveBillablePricingDimensions({
      actualWidthIn: new Decimal(50),
      actualHeightIn: new Decimal(30),
      minimumBillableWidthIn: null,
      minimumBillableHeightIn: null,
      billableHeightMode: BillableHeightMode.ACTUAL_HEIGHT,
      billableHeightPercentOfWidth: null,
      billableHeightFixedIn: null,
      ...overrides,
    });

  it("uses actual height and applies both independent minimums", () => {
    const result = resolve({
      minimumBillableWidthIn: 60,
      minimumBillableHeightIn: 40,
    });

    expect(result.widthIn.toString()).toBe("60");
    expect(result.heightIn.toString()).toBe("40");
  });

  it("uses 100% of raw width as height before independent minimums", () => {
    const result = resolve({
      actualHeightIn: new Decimal(0),
      minimumBillableWidthIn: 60,
      billableHeightMode: BillableHeightMode.WIDTH_PERCENTAGE,
      billableHeightPercentOfWidth: 100,
    });

    expect(result.widthIn.toString()).toBe("60");
    expect(result.heightIn.toString()).toBe("50");
  });

  it("uses 50% of the raw width as height", () => {
    const result = resolve({
      actualHeightIn: new Decimal(0),
      billableHeightMode: BillableHeightMode.WIDTH_PERCENTAGE,
      billableHeightPercentOfWidth: 50,
    });

    expect(result.widthIn.toString()).toBe("50");
    expect(result.heightIn.toString()).toBe("25");
  });

  it("preserves a fixed height of zero even when a height minimum exists", () => {
    const result = resolve({
      minimumBillableHeightIn: 40,
      billableHeightMode: BillableHeightMode.FIXED,
      billableHeightFixedIn: 0,
    });

    expect(result.widthIn.toString()).toBe("50");
    expect(result.heightIn.toString()).toBe("0");
  });

  it("supports changing the fixed height without a code change", () => {
    const result = resolve({
      billableHeightMode: BillableHeightMode.FIXED,
      billableHeightFixedIn: 5,
    });

    expect(result.heightIn.toString()).toBe("5");
  });

  it("supports changing the width percentage without a code change", () => {
    const result = resolve({
      actualHeightIn: new Decimal(0),
      billableHeightMode: BillableHeightMode.WIDTH_PERCENTAGE,
      billableHeightPercentOfWidth: 40,
    });

    expect(result.heightIn.toString()).toBe("20");
  });

  it("rejects FIXED mode without a fixed value", () => {
    expect(() =>
      resolve({
        billableHeightMode: BillableHeightMode.FIXED,
        billableHeightFixedIn: null,
      }),
    ).toThrow("Billable Height Fixed Value is required");
  });
});
