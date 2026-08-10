import { describe, expect, it } from "vitest";
import { vehicleModelRequest, vehicleModelUrl } from "./browser-task";

describe("vehicleModelRequest", () => {
  it("recognizes an explicit Japanese model-page request", () => {
    expect(vehicleModelRequest("ISのモデルページを表示してください。")).toBe("IS");
    expect(vehicleModelRequest("LBXを開いて")).toBe("LBX");
  });

  it("does not mistake iOS or conversational mentions for a navigation request", () => {
    expect(vehicleModelRequest("iOSのページを表示してください。")).toBeNull();
    expect(vehicleModelRequest("ISとESの違いを教えて")).toBeNull();
  });

  it("builds only the known Lexus model URL", () => {
    expect(vehicleModelUrl("IS")).toBe("https://lexus.jp/models/is/");
  });
});