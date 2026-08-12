import { describe, expect, it } from "vitest";
import { displayPointToFrame } from "./browser-frame";

describe("displayPointToFrame", () => {
  it("maps an equally sized display to frame coordinates", () => {
    expect(displayPointToFrame(720, 450, { left: 0, top: 0, width: 1440, height: 900 }, { width: 1440, height: 900 }))
      .toEqual({ x: 720, y: 450 });
  });

  it("maps through horizontal letterboxing", () => {
    expect(displayPointToFrame(500, 250, { left: 0, top: 0, width: 1000, height: 500 }, { width: 800, height: 800 }))
      .toEqual({ x: 400, y: 400 });
    expect(displayPointToFrame(100, 250, { left: 0, top: 0, width: 1000, height: 500 }, { width: 800, height: 800 }))
      .toBeNull();
  });

  it("maps through vertical letterboxing", () => {
    expect(displayPointToFrame(400, 500, { left: 0, top: 0, width: 800, height: 1000 }, { width: 800, height: 400 }))
      .toEqual({ x: 400, y: 200 });
    expect(displayPointToFrame(400, 100, { left: 0, top: 0, width: 800, height: 1000 }, { width: 800, height: 400 }))
      .toBeNull();
  });

  it("preserves subpixel precision for a small color swatch", () => {
    const point = displayPointToFrame(311.25, 213.75, { left: 10, top: 20, width: 720, height: 450 }, { width: 1440, height: 900 });
    expect(point?.x).toBeCloseTo(602.5);
    expect(point?.y).toBeCloseTo(387.5);
  });
});