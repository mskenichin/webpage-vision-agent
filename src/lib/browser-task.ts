import { browserManager } from "./browser";
import { runComputerUse } from "./computer-use";
import { store } from "./store";

export type VehicleModel = "LBX" | "UX" | "NX" | "RX" | "RZ" | "GX" | "LX" | "LM" | "LS" | "ES" | "IS" | "LC" | "RC";

export function vehicleModelRequest(prompt: string): VehicleModel | null {
  if (!/見せ|開い|表示|ページ|サイト/i.test(prompt)) return null;
  const match = prompt.toUpperCase().match(/(?:^|[^A-Z])(LBX|UX|NX|RX|RZ|GX|LX|LM|LS|ES|IS|LC|RC)(?=$|[^A-Z])/);
  return match?.[1] as VehicleModel | undefined ?? null;
}

export function vehicleModelUrl(model: VehicleModel) {
  return `https://lexus.jp/models/${model.toLowerCase()}/`;
}

export async function runBrowserTask(goal: string) {
  const model = vehicleModelRequest(goal);
  if (!model) return runComputerUse(goal);

  const targetUrl = vehicleModelUrl(model);
  const alreadyAtTarget = store.snapshot().currentUrl === targetUrl;
  if (!alreadyAtTarget) {
    await browserManager.execute({ type: "navigate", url: targetUrl, actor: "agent" });
  }
  const currentUrl = store.snapshot().currentUrl;
  if (currentUrl !== targetUrl) throw new Error("BROWSER_NAVIGATION_INCOMPLETE");
  return { ok: true, steps: alreadyAtTarget ? 0 : 1, currentUrl, message: `${model}のモデルページを表示しました。` };
}