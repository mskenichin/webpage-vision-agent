import { describe, expect, it } from "vitest";
import { combineTaskConstraints, normalizeStepConstraintIds, parseNextTaskStep, parseTaskPlan, taskExecutionGoal, taskStepExecutionGoal, type TaskStep } from "./task-mode";

function step(id: string, instruction: string, description: string): TaskStep {
  return {
    id,
    instruction,
    constraints: [{
      id: `${id}-constraint`,
      target: { kind: "page", label: description },
      operator: "visible",
      evidence: ["screenshot", "page_text"],
      description,
    }],
  };
}

describe("task mode planning", () => {
  it("parses goal constraints without predicting future UI steps", () => {
    const plan = parseTaskPlan(`\`\`\`json
      {"summary":"ISの見積もりを作成する","goalConstraints":[{"id":"grade-selected","target":{"kind":"selection","label":"グレード"},"operator":"equals","expected":"F SPORT","evidence":["screenshot"],"description":"選択中グレードがF SPORT"},{"id":"estimate-visible","target":{"kind":"page","label":"見積金額"},"operator":"visible","evidence":["screenshot","page_text"],"description":"見積金額が表示されている"}]}
    \`\`\``);

    expect(plan.goalConstraints).toHaveLength(2);
    expect(plan.goalConstraints[1].description).toContain("見積金額");
  });

  it("rejects empty or oversized goal constraints", () => {
    expect(() => parseTaskPlan('{"summary":"test","goalConstraints":[]}')).toThrow();
    const constraints = Array.from({ length: 21 }, (_, index) => step(`${index}`, "操作", "確認").constraints[0]);
    expect(() => parseTaskPlan(JSON.stringify({ summary: "test", goalConstraints: constraints }))).toThrow();
  });

  it("rejects transient selection UI visibility as a task success condition", () => {
    expect(() => parseTaskPlan(JSON.stringify({
      summary: "見積もりを設定する",
      goalConstraints: [{
          id: "grade-ui",
          target: { kind: "selection", label: "グレード" },
          operator: "visible",
          evidence: ["screenshot"],
          description: "グレード選択UIが表示されている",
      }],
    }))).toThrow(/一時的な操作UI/);
  });

  it("parses exactly one next semantic task step", () => {
    const next = parseNextTaskStep(`{"id":"grade","instruction":"F SPORTを選択済みにする","constraints":[{"id":"grade-selected","target":{"kind":"selection","label":"グレード"},"operator":"equals","expected":"F SPORT","evidence":["screenshot","page_text"],"description":"グレードがF SPORTである"}]}`);

    expect(next.id).toBe("grade");
    expect(next.constraints).toHaveLength(1);
    expect(() => parseNextTaskStep(JSON.stringify([next, next]))).toThrow();
  });

  it("deduplicates identical constraints for one combined verifier call", () => {
    const constraint = step("grade", "F SPORTを選択する", "グレードがF SPORT").constraints[0];

    expect(combineTaskConstraints([constraint], [constraint])).toEqual([constraint]);
  });

  it("rejects conflicting constraint IDs before combined verification", () => {
    const first = step("grade", "F SPORTを選択する", "グレードがF SPORT").constraints[0];
    const conflicting = { ...first, description: "別の成功条件" };

    expect(() => combineTaskConstraints([first], [conflicting])).toThrow("TASK_CONSTRAINT_ID_COLLISION:grade-constraint");
  });

  it("normalizes dynamic step IDs that collide with goal constraints", () => {
    const dynamicStep = step("grade", "F SPORTを選択する", "グレードがF SPORT");
    const goalConstraint = { ...dynamicStep.constraints[0], description: "最終グレードがF SPORT" };
    const normalized = normalizeStepConstraintIds(dynamicStep, [goalConstraint]);

    expect(normalized.constraints[0].id).not.toBe(goalConstraint.id);
    expect(combineTaskConstraints(normalized.constraints, [goalConstraint])).toHaveLength(2);
  });

  it("adds a zero-count guard for optional selections outside an all-selected category", () => {
    const plan = parseTaskPlan(JSON.stringify({
      summary: "メーカーオプションをすべて選択する",
      goalConstraints: [{
        id: "all-manufacturer-options",
        target: { kind: "collection", label: "メーカーオプション" },
        operator: "all_available_selected",
        expected: "選択可能な項目すべて",
        evidence: ["screenshot", "page_text"],
        description: "選択可能なメーカーオプションがすべて選択されている",
      }],
    }));

    expect(plan.goalConstraints).toContainEqual(expect.objectContaining({
      id: "unrequested-optional-selections",
      operator: "count_equals",
      expected: 0,
    }));
    expect(plan.goalConstraints.at(-1)?.description).toContain("メーカーオプション");
  });

  it("does not duplicate an existing unrequested-selection guard", () => {
    const plan = parseTaskPlan(JSON.stringify({
      summary: "指定カテゴリだけを選択する",
      goalConstraints: [
        {
          id: "all-requested",
          target: { kind: "collection", label: "指定カテゴリ" },
          operator: "all_available_selected",
          evidence: ["screenshot"],
          description: "指定カテゴリをすべて選択する",
        },
        {
          id: "no-others",
          target: { kind: "collection", label: "指定カテゴリ以外" },
          operator: "count_equals",
          expected: 0,
          evidence: ["screenshot"],
          description: "要求外の追加項目が0件である",
        },
      ],
    }));

    expect(plan.goalConstraints).toHaveLength(2);
  });

  it("keeps the original request and explicit success condition in every execution goal", () => {
    const goal = taskExecutionGoal(
      "ISのFスポーツを白にして全メーカーオプションを付ける",
      step("color", "白を選択する", "選択中カラー名が白系"),
      3,
    );

    expect(goal).toContain("全体のユーザー要求: ISのFスポーツを白にして全メーカーオプションを付ける");
    expect(goal).toContain("現在のサブタスク (3): 白を選択する");
    expect(goal).toContain("構造化制約:");
    expect(goal).toContain("選択中カラー名が白系");
  });

  it("serializes generic exclusion and count constraints for the executor", () => {
    const goal = taskExecutionGoal(
      "在庫ありの商品を3件比較し、広告枠は含めない",
      {
        id: "compare",
        instruction: "比較対象を選択する",
        constraints: [
          {
            id: "three-products",
            target: { kind: "collection", label: "比較対象" },
            operator: "count_equals",
            expected: 3,
            evidence: ["screenshot", "page_text"],
            description: "比較対象が3件である",
          },
          {
            id: "exclude-sponsored",
            target: { kind: "selection", label: "広告枠" },
            operator: "not_selected",
            evidence: ["screenshot"],
            description: "広告枠が選択されていない",
          },
        ],
      },
      1,
    );

    expect(goal).toContain('"operator":"count_equals","expected":3');
    expect(goal).toContain('"operator":"not_selected"');
    expect(goal).toContain('"id":"exclude-sponsored"');
  });

  it("keeps global zero-count exclusions in every interactive execution goal", () => {
    const goal = taskExecutionGoal(
      "メーカーオプションを全部付ける",
      step("select-options", "メーカーオプションを選択する", "メーカーオプションが選択済み"),
      4,
      [{
        id: "unrequested-optional-selections",
        target: { kind: "collection", label: "ユーザー要求に含まれない追加オプション" },
        operator: "count_equals",
        expected: 0,
        evidence: ["screenshot", "page_text"],
        description: "要求外の任意追加オプションが0件である",
      }],
    );

    expect(goal).toContain("常時維持する除外制約:");
    expect(goal).toContain('"id":"unrequested-optional-selections"');
  });

  it("uses deterministic model routing before executing the compound request", () => {
    const original = "ISのFスポーツで、ボディカラーを白にして、メーカーオプションを全部付けた見積もりが見たい";
    const navigation = taskStepExecutionGoal(
      original,
      step("open-is", "ISの価格とグレードを表示する", "ISの価格・グレードページが表示されている"),
      1,
      "https://lexus.jp/",
    );
    const selection = taskStepExecutionGoal(
      original,
      step("grade", "F SPORTを選択する", "選択中グレードがF SPORT"),
      2,
      "https://lexus.jp/models/is/features/price_package/",
    );

    expect(navigation).toBe("ISの価格とグレードを表示する");
    expect(selection).toContain(`全体のユーザー要求: ${original}`);
  });

  it("does not treat starting an estimate as model-page navigation", () => {
    const original = "ISのFスポーツで白を選んだ見積もりが見たい";
    const goal = taskStepExecutionGoal(
      original,
      step("estimate", "ISモデルページから見積もりシミュレーションを開始する", "ISの仕様を選択できる見積もり画面が表示されている"),
      2,
      "https://lexus.jp/models/is/",
    );

    expect(goal).toContain(`全体のユーザー要求: ${original}`);
    expect(goal).toContain("現在のサブタスク (2): ISモデルページから見積もりシミュレーションを開始する");
  });
});