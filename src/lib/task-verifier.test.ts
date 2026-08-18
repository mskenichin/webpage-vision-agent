import { describe, expect, it } from "vitest";
import { failedConstraintResults, parseVerificationResult, verifierConfig, type TaskConstraint } from "./task-verifier";

const constraints: TaskConstraint[] = [
  {
    id: "grade",
    target: { kind: "selection", label: "グレード" },
    operator: "equals",
    expected: "F SPORT",
    evidence: ["screenshot", "page_text"],
    description: "選択中グレードがF SPORTである",
  },
  {
    id: "dealer-options",
    target: { kind: "collection", label: "選択済み販売店オプション" },
    operator: "count_equals",
    expected: 0,
    evidence: ["screenshot"],
    description: "選択済み販売店オプションが0件である",
  },
];

describe("task verifier", () => {
  it("uses the dedicated models with 30 and 45 second timeouts", () => {
    const previousPrimary = process.env.AZURE_TASK_VERIFIER_MODEL;
    const previousFallback = process.env.AZURE_TASK_VERIFIER_FALLBACK_MODEL;
    process.env.AZURE_TASK_VERIFIER_MODEL = "fast-model";
    process.env.AZURE_TASK_VERIFIER_FALLBACK_MODEL = "quality-model";
    try {
      expect(verifierConfig()).toEqual({
        primary: "fast-model",
        fallback: "quality-model",
        primaryTimeoutMs: 30_000,
        fallbackTimeoutMs: 45_000,
      });
    } finally {
      if (previousPrimary === undefined) delete process.env.AZURE_TASK_VERIFIER_MODEL;
      else process.env.AZURE_TASK_VERIFIER_MODEL = previousPrimary;
      if (previousFallback === undefined) delete process.env.AZURE_TASK_VERIFIER_FALLBACK_MODEL;
      else process.env.AZURE_TASK_VERIFIER_FALLBACK_MODEL = previousFallback;
    }
  });

  it("parses structured constraint results", () => {
    expect(parseVerificationResult(`\`\`\`json
      {"results":[{"id":"grade","passed":true,"evidence":"F SPORTに選択表示"}]}
    \`\`\``).results[0]).toMatchObject({ id: "grade", passed: true });
  });

  it("treats failed and missing results as unmet constraints", () => {
    const failed = failedConstraintResults(constraints, {
      results: [{ id: "grade", passed: true, evidence: "F SPORTに選択表示" }],
    });

    expect(failed).toHaveLength(1);
    expect(failed[0].constraint.id).toBe("dealer-options");
    expect(failed[0].evidence).toContain("返されませんでした");
  });
});