import Decimal from "decimal.js";
import { computeGlassOptionSurcharge } from "./glass-option-surcharge";

describe("computeGlassOptionSurcharge", () => {
  it("uses geometric inches and applies A to area, B to perimeter and C once", () => {
    const result = computeGlassOptionSurcharge(
      new Decimal(24),
      new Decimal(36),
      new Decimal(2),
      new Decimal(3),
      new Decimal(4),
    );

    // 2ft x 3ft => 6ft² and 10ft perimeter.
    expect(result.toString()).toBe("46");
  });

  it("rejects non-positive physical dimensions", () => {
    expect(() =>
      computeGlassOptionSurcharge(
        new Decimal(0),
        new Decimal(36),
        new Decimal(1),
        new Decimal(1),
        new Decimal(1),
      ),
    ).toThrow("Surcharge dimensions must be greater than zero.");
  });

  it("applies fixed C once to every physical component", () => {
    const first = computeGlassOptionSurcharge(
      new Decimal(12),
      new Decimal(12),
      new Decimal(0),
      new Decimal(0),
      new Decimal(5),
    );
    const second = computeGlassOptionSurcharge(
      new Decimal(12),
      new Decimal(12),
      new Decimal(0),
      new Decimal(0),
      new Decimal(5),
    );

    expect(first.add(second).toString()).toBe("10");
  });
});
