import { BadRequestException } from "@nestjs/common";
import { resolvePiecePanelCount } from "./panel-count-resolver";

describe("resolvePiecePanelCount", () => {
  it("uses the fixed configuration value when the request omits panelCount", () => {
    expect(
      resolvePiecePanelCount({
        fixedPanelCount: 3,
        requiresPanelCount: false,
        requestedPanelCount: null,
      }),
    ).toBe(3);
  });

  it("uses the fixed configuration value instead of a conflicting request", () => {
    expect(
      resolvePiecePanelCount({
        fixedPanelCount: 2,
        requiresPanelCount: true,
        requestedPanelCount: 9,
      }),
    ).toBe(2);
  });

  it("uses a valid manual value when the configuration requires it", () => {
    expect(
      resolvePiecePanelCount({
        fixedPanelCount: null,
        requiresPanelCount: true,
        requestedPanelCount: 4,
      }),
    ).toBe(4);
  });

  it("clears a stale request when the configuration does not use panelCount", () => {
    expect(
      resolvePiecePanelCount({
        fixedPanelCount: null,
        requiresPanelCount: false,
        requestedPanelCount: 5,
      }),
    ).toBeNull();
  });

  it("rejects an invalid fixed configuration value", () => {
    expect(() =>
      resolvePiecePanelCount({
        fixedPanelCount: 0,
        requiresPanelCount: false,
        requestedPanelCount: null,
      }),
    ).toThrow(BadRequestException);
  });

  it("rejects a missing manual value when panelCount is required", () => {
    expect(() =>
      resolvePiecePanelCount({
        fixedPanelCount: null,
        requiresPanelCount: true,
        requestedPanelCount: null,
      }),
    ).toThrow(BadRequestException);
  });
});
