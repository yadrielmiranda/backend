import { Prisma } from "@prisma/client";
import {
  additionalServiceInputFromStoredLine,
  additionalServicePricingDimensions,
} from "./installation-additional-service";

describe("additional installation services", () => {
  it("uses only manually entered pricing dimensions", () => {
    expect(
      additionalServicePricingDimensions({
        serviceId: 7,
        widthIn: 60,
        occurrences: 2,
      }),
    ).toEqual({
      widthIn: 60,
      heightIn: undefined,
      areaSqFt: undefined,
      panelCount: undefined,
      lengthIn: undefined,
    });
  });

  it("preserves manual values when a quote is recalculated", () => {
    expect(
      additionalServiceInputFromStoredLine({
        serviceId: 8,
        widthIn: null,
        heightIn: null,
        areaSqFt: new Prisma.Decimal("8.5000"),
        panelCount: null,
        lengthIn: null,
        occurrences: 2,
        description: "Concrete cutting outside the estimate",
      }),
    ).toEqual({
      serviceId: 8,
      widthIn: undefined,
      heightIn: undefined,
      areaSqFt: 8.5,
      panelCount: undefined,
      lengthIn: undefined,
      occurrences: 2,
      description: "Concrete cutting outside the estimate",
    });
  });
});
