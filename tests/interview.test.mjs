import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOM_ANSWER_LABEL,
  INTERVIEW_ENTRY,
  INTERVIEW_ENTRY_VERSION,
  PLAN_CANCEL,
  PLAN_CONFIRM,
  PLAN_REFINE,
  confirmedPlanSteer,
  formatInterviewAnswers,
  interviewSystemPromptSection,
  isInterviewLive,
  normalizeQuestions,
  readInterviewEntry,
  renderPlan,
  renderPlanSummary,
  reviewPlan,
  runQuestionnaire,
  validatePlan,
} from "../extensions/pi-autoresearch/interview.ts";

const PLAN = {
  objective: "Minimize unit test wall-clock time for the pi-autoresearch package",
  workload: "pnpm test (the whole node --test suite)",
  command: "./.auto/measure.sh",
  metricName: "total_ms",
  metricUnit: "ms",
  direction: "lower",
  secondaryMetrics: ["test_count"],
  filesInScope: ["extensions/pi-autoresearch/index.ts", "extensions/pi-autoresearch/jsonl.ts"],
  offLimits: ["tests/"],
  constraints: ["no new dependencies"],
  checks: ["pnpm test must pass"],
  maxIterations: 50,
};

function plan(overrides = {}) {
  const result = validatePlan({ ...PLAN, ...overrides });
  assert.equal(result.ok, true, `fixture plan must validate: ${JSON.stringify(result.problems ?? [])}`);
  return result.plan;
}

/** Minimal stand-in for pi's dialog surface. */
function fakeHost({ picks = [], inputs = [], hasUI = true } = {}) {
  const dialogs = [];
  const selectQueue = [...picks];
  const inputQueue = [...inputs];
  return {
    hasUI,
    dialogs,
    ui: {
      async select(title, options) {
        dialogs.push({ title, options });
        const next = selectQueue.shift();
        if (next === undefined) return undefined;
        return typeof next === "number" ? options[next] : next;
      },
      async input(title) {
        dialogs.push({ title, input: true });
        return inputQueue.shift();
      },
    },
  };
}

test("normalizeQuestions trims, de-duplicates ids and clamps the recommendation", () => {
  const [first, second, third] = normalizeQuestions([
    { id: "", question: "  Which workload?  ", options: [" a ", "", "b"], recommended: 7 },
    { id: "q1", question: "Second?", options: [] },
    { id: "q1", question: "Third?", options: ["x"], recommended: 0, allowCustom: false },
  ]);

  assert.equal(first.id, "q1");
  assert.equal(first.question, "Which workload?");
  assert.deepEqual(first.options, ["a", "b"]);
  assert.equal(first.recommended, undefined, "out-of-range recommendations are dropped");
  assert.equal(first.allowCustom, true);

  assert.equal(second.id, "q1-2", "duplicate ids get a suffix");
  assert.deepEqual(second.options, []);

  assert.equal(third.id, "q1-3");
  assert.equal(third.recommended, 0);
  assert.equal(third.allowCustom, false);
});

test("a questionnaire returns the picked option and offers the recommendation marker", async () => {
  const host = fakeHost({ picks: [1] });
  const result = await runQuestionnaire(host, [
    {
      id: "workload",
      question: "What should each iteration measure?",
      context: "I found node --test in package.json.",
      options: ["The full suite", "Only jsonl tests"],
      recommended: 0,
    },
  ]);

  assert.equal(result.cancelled, false);
  assert.equal(result.unavailable, false);
  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].answer, "Only jsonl tests");
  assert.equal(result.answers[0].wasCustom, false);

  const [dialog] = host.dialogs;
  assert.equal(dialog.title, "What should each iteration measure?\n\nI found node --test in package.json.");
  assert.deepEqual(dialog.options, [
    "1. The full suite  (recommended)",
    "2. Only jsonl tests",
    `3. ${CUSTOM_ANSWER_LABEL}`,
  ]);
});

test("a custom answer is collected through the input dialog, re-asked while blank", async () => {
  const host = fakeHost({ picks: [2], inputs: ["   ", "p95 latency at batch 8"] });
  const result = await runQuestionnaire(host, [
    { id: "metric", question: "Which metric?", options: ["mean latency", "max latency"], recommended: 0 },
  ]);

  assert.equal(result.answers[0].answer, "p95 latency at batch 8");
  assert.equal(result.answers[0].wasCustom, true);
  assert.equal(harnessInputs(host), 2, "a blank answer re-asks");
});

test("an option-less question is asked as free text", async () => {
  const host = fakeHost({ inputs: ["score the parser on the fixtures"] });
  const result = await runQuestionnaire(host, [{ id: "goal", question: "What exactly should improve?", options: [] }]);

  assert.equal(result.answers[0].answer, "score the parser on the fixtures");
  assert.equal(result.answers[0].wasCustom, true);
});

test("allowCustom: false offers no write-your-own option", async () => {
  const host = fakeHost({ picks: [0] });
  await runQuestionnaire(host, [{ id: "a", question: "Pick", options: ["one", "two"], allowCustom: false }]);
  assert.deepEqual(host.dialogs[0].options, ["1. one", "2. two"]);
});

test("dismissing a question cancels and keeps the answers collected so far", async () => {
  const host = fakeHost({ picks: [0, -1] });
  const result = await runQuestionnaire(host, [
    { id: "a", question: "First?", options: ["yes", "no"] },
    { id: "b", question: "Second?", options: ["yes", "no"] },
  ]);

  assert.equal(result.cancelled, true);
  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].id, "a");
  assert.equal(formatInterviewAnswers(result), "**Q:** First?\n**A:** yes");
});

test("a host without dialogs reports unavailable instead of throwing", async () => {
  const result = await runQuestionnaire(fakeHost({ hasUI: false }), [{ id: "a", question: "First?", options: ["yes"] }]);
  assert.equal(result.unavailable, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.answers.length, 0);
});

test("reviewPlan maps the three choices and treats dismissal as keep-refining", async () => {
  assert.equal((await reviewPlan(fakeHost({ picks: [PLAN_CONFIRM] }), "plan")).decision, "confirm");
  assert.equal((await reviewPlan(fakeHost({ picks: [PLAN_REFINE] }), "plan")).decision, "refine");
  assert.equal((await reviewPlan(fakeHost({ picks: [PLAN_CANCEL] }), "plan")).decision, "cancel");
  assert.equal((await reviewPlan(fakeHost({ picks: [-1] }), "plan")).decision, "refine", "escape never traps the user");
  assert.equal((await reviewPlan(fakeHost({ hasUI: false }), "plan")).unavailable, true);
});

test("the review dialog shows the rendered plan, not a bare prompt", async () => {
  const host = fakeHost({ picks: [PLAN_CONFIRM] });
  await reviewPlan(host, renderPlan(plan()));
  assert.ok(host.dialogs[0].title.includes("EXPERIMENT PLAN"));
  assert.ok(host.dialogs[0].title.includes(PLAN.objective));
});

test("validatePlan accepts a complete plan and normalizes lists", () => {
  const result = validatePlan({ ...PLAN, secondaryMetrics: [" test_count ", "test_count", ""] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.secondaryMetrics, ["test_count"]);
  assert.equal(result.plan.maxIterations, 50);
});

test("validatePlan rejects whitespace in the metric name, because METRIC parsing would break", () => {
  const result = validatePlan({ ...PLAN, metricName: "total ms" });
  assert.equal(result.ok, false);
  const problems = result.problems.join("\n");
  assert.match(problems, /contains whitespace/);
  assert.match(problems, /total_ms/, "the message shows the fixed token");
});

test("validatePlan reports every missing required field, not just the first", () => {
  const result = validatePlan({ direction: "sideways" });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 5);
  const problems = result.problems.join("\n");
  for (const needle of [/objective is empty/, /command is empty/, /metricName is empty/, /direction must be/, /workload is empty/]) {
    assert.match(problems, needle);
  }
});

test("validatePlan rejects a non-positive iteration cap and accepts unbounded", () => {
  assert.equal(validatePlan({ ...PLAN, maxIterations: 0 }).ok, false);
  assert.equal(validatePlan({ ...PLAN, maxIterations: 2.5 }).ok, false);
  assert.equal(validatePlan({ ...PLAN, maxIterations: "abc" }).ok, false);
  assert.equal(plan({ maxIterations: null }).maxIterations, null);
});

test("renderPlan shows every field the user is approving", () => {
  const text = renderPlan(plan());
  for (const needle of [
    "EXPERIMENT PLAN",
    PLAN.objective,
    PLAN.workload,
    PLAN.command,
    "total_ms (ms) — lower is better",
    "test_count",
    "extensions/pi-autoresearch/jsonl.ts",
    "tests/",
    "no new dependencies",
    "pnpm test must pass",
    "50",
  ]) {
    assert.ok(text.includes(needle), `plan text includes ${needle}`);
  }
});

test("renderPlan spells out empty optional sections instead of leaving blanks", () => {
  const text = renderPlan(plan({ secondaryMetrics: [], filesInScope: [], offLimits: [], constraints: [], checks: [], maxIterations: null }));
  assert.match(text, /secondary metrics:\s+— \(none\)/);
  assert.match(text, /checks:\s+— \(no \.auto\/checks\.sh\)/);
  assert.match(text, /max iterations:\s+unbounded/);
});

test("the confirmed steer restates the contract and the ordered setup steps", () => {
  const steer = confirmedPlanSteer(plan());
  assert.match(steer, /^PLAN CONFIRMED/);
  assert.ok(steer.includes(PLAN.objective), "objective is restated");
  assert.ok(steer.includes("EXPERIMENT PLAN"), "plan block is restated");
  assert.match(steer, /\.auto\/prompt\.md/);
  assert.match(steer, /\.auto\/measure\.sh/);
  assert.match(steer, /"maxIterations": 50/);
  assert.match(steer, /init_experiment/);
  assert.match(steer, /metric_name="total_ms"/);
  assert.match(steer, /direction="lower"/);
});

test("a plan without checks tells the agent not to write checks.sh", () => {
  const steer = confirmedPlanSteer(plan({ checks: [] }));
  assert.match(steer, /No `\.auto\/checks\.sh`/);
  assert.doesNotMatch(steer, /Write `\.auto\/checks\.sh`/);
});

test("an unbounded plan writes no iteration cap", () => {
  const steer = confirmedPlanSteer(plan({ maxIterations: null }));
  assert.match(steer, /No iteration cap/);
  assert.doesNotMatch(steer, /maxIterations/);
});

test("the review prompt stays compact because dialog titles render inline", () => {
  const prompt = renderPlanSummary(plan());
  assert.match(prompt, /Approve this experiment plan\?/);
  assert.match(prompt, /total_ms \(ms\) — lower is better/);
  assert.match(prompt, /iterations\s+50/);
  assert.ok(prompt.split("\n").length <= 10, "the modal prompt is at most 10 lines");
  assert.ok(prompt.length < 400, "the modal prompt is short");
});

test("the interview system prompt forbids experimenting before confirmation", () => {
  const section = interviewSystemPromptSection();
  for (const needle of [/INTERVIEW PHASE/, /Do NOT run experiments/, /ask_experiment_question/, /propose_experiment_plan/, /--no-interview/]) {
    assert.match(section, needle);
  }
});

test("readInterviewEntry takes the newest entry and ignores other custom types", () => {
  const older = { type: "custom", customType: INTERVIEW_ENTRY, data: { version: 1, phase: "interview", topic: "old", startedAt: "t0" } };
  const newer = {
    type: "custom",
    customType: INTERVIEW_ENTRY,
    data: { version: 1, phase: "confirmed", topic: "new", startedAt: "t1", settledAt: "t2" },
  };
  const other = { type: "custom", customType: "pi-autoresearch.activation", data: {} };

  assert.equal(readInterviewEntry([older, other, newer]).topic, "new");
  assert.equal(readInterviewEntry([]), null);
  assert.equal(readInterviewEntry([other]), null);
  assert.equal(readInterviewEntry([{ type: "custom", customType: INTERVIEW_ENTRY, data: { version: 99 } }]), null);
});

test("isInterviewLive is true only for an unsettled interview entry", () => {
  const live = { version: INTERVIEW_ENTRY_VERSION, phase: "interview", topic: "x", startedAt: "t0" };
  assert.equal(isInterviewLive(live), true);
  assert.equal(isInterviewLive({ ...live, settledAt: "t1" }), false);
  assert.equal(isInterviewLive({ ...live, phase: "confirmed" }), false);
  assert.equal(isInterviewLive(null), false);
});

function harnessInputs(host) {
  return host.dialogs.filter((dialog) => dialog.input).length;
}
