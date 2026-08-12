import { describe, expect, it } from "vitest";
import { browserTaskRequest, vehicleModelRequest, vehicleModelUrl } from "./browser-task";

describe("vehicleModelRequest", () => {
  it("recognizes an explicit Japanese model-page request", () => {
    expect(vehicleModelRequest("ISのモデルページを表示してください。")).toBe("IS");
    expect(vehicleModelRequest("LBXを開いて")).toBe("LBX");
  });

  it("recognizes a request for information about one model", () => {
    expect(vehicleModelRequest("ISのパッケージについて知りたい")).toBe("IS");
    expect(vehicleModelRequest("ISについて教えて")).toBe("IS");
    expect(browserTaskRequest("ISのパッケージについて知りたい")).toEqual({
      model: "IS",
      targetUrl: "https://lexus.jp/models/is/features/price_package/",
    });
  });

  it("does not mistake iOS or conversational mentions for a navigation request", () => {
    expect(vehicleModelRequest("iOSのページを表示してください。")).toBeNull();
    expect(vehicleModelRequest("ISとESの違いを教えて")).toBeNull();
  });

  it("builds only the known Lexus model URL", () => {
    expect(vehicleModelUrl("IS")).toBe("https://lexus.jp/models/is/");
  });

  it("opens model discovery for conversational vehicle requests", () => {
    expect(browserTaskRequest("家族5人で使いやすいSUVを探したい")).toEqual({
      model: null,
      targetUrl: "https://lexus.jp/models/",
    });
    expect(browserTaskRequest("燃費の良い車をおすすめして")).toEqual({
      model: null,
      targetUrl: "https://lexus.jp/models/",
    });
  });

  it("uses the current model for a contextual follow-up", () => {
    expect(browserTaskRequest("価格も見たい", "https://lexus.jp/models/nx/features/interior/")).toEqual({
      model: "NX",
      targetUrl: "https://lexus.jp/models/nx/features/price_package/",
    });
  });

  it("delegates an unknown model section instead of returning to the model top", () => {
    expect(browserTaskRequest("特別仕様車の詳細を教えて", "https://lexus.jp/models/is/features/driving/"))
      .toBeNull();
  });

  it("normalizes Japanese speech recognition of model names", () => {
    expect(browserTaskRequest("エヌエックスの内装を見せて")).toEqual({
      model: "NX",
      targetUrl: "https://lexus.jp/models/nx/features/interior/",
    });
  });
});