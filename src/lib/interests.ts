import type { ActivityEvent, Interest } from "./domain";

const MODEL_NAMES = ["LBX", "UX", "NX", "RX", "RZ", "GX", "LX", "LM", "LS", "ES", "IS", "LC", "RC"];

interface Candidate {
  key: string;
  name: string;
  category: Interest["category"];
  weight: number;
}

function candidatesFor(event: ActivityEvent): Candidate[] {
  const source = `${event.title} ${event.url}`.toUpperCase();
  const weight = event.type === "link_clicked" ? 0.2 : 0.14;
  const candidates: Candidate[] = [];

  for (const model of MODEL_NAMES) {
    const pattern = new RegExp(`(^|[^A-Z])${model}([^A-Z]|$)`);
    if (pattern.test(source)) {
      candidates.push({ key: `model:${model.toLowerCase()}`, name: model, category: "model", weight });
    }
  }

  const bodyTypes: Array<[RegExp, string, string]> = [
    [/SUV/, "body:suv", "SUV"],
    [/SEDAN|セダン/, "body:sedan", "セダン"],
    [/COUPE|クーペ/, "body:coupe", "クーペ"],
    [/ELECTRIC|EV|電気自動車/, "feature:ev", "電気自動車"],
    [/HYBRID|ハイブリッド/, "feature:hybrid", "ハイブリッド"],
  ];

  for (const [pattern, key, name] of bodyTypes) {
    if (pattern.test(source)) {
      candidates.push({
        key,
        name,
        category: key.startsWith("body") ? "body" : "feature",
        weight,
      });
    }
  }

  return candidates;
}

export function mergeInterests(current: Interest[], event: ActivityEvent): Interest[] {
  const now = event.occurredAt;
  const merged = current.map((interest) => ({ ...interest, evidenceIds: [...interest.evidenceIds] }));

  for (const candidate of candidatesFor(event)) {
    const existing = merged.find((interest) => interest.key === candidate.key);
    if (existing) {
      if (!existing.evidenceIds.includes(event.id)) {
        existing.evidenceIds.push(event.id);
        existing.score = Math.min(1, Number((existing.score + candidate.weight).toFixed(2)));
        existing.updatedAt = now;
      }
      continue;
    }

    merged.push({
      id: crypto.randomUUID(),
      key: candidate.key,
      name: candidate.name,
      category: candidate.category,
      score: candidate.weight,
      evidenceIds: [event.id],
      updatedAt: now,
    });
  }

  return merged.sort((left, right) => right.score - left.score);
}