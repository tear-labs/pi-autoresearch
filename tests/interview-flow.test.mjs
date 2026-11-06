import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";
import { PLAN_CANCEL, PLAN_CONFIRM, PLAN_REFINE } from "../extensions/pi-autoresearch/interview.ts";

const INTERVIEW_ENTRY = "pi-autoresearch-interview";
const LOOP_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];
const INTERVIEW_TOOLS = ["ask_experiment_question", "propose_experiment_plan"];

const GOOD_PLAN = {
  objective: "Cut the parser benchmark wall time",
  workload: "node bench/parse.mjs over the fixture corpus",
  command: "./.auto/measure.sh",
  metric_name: "parse_ms",
  metric_unit: "ms",
  direction: "lower",
  secondary_metrics: ["fixture_count"],
  files_in_scope: ["src/parser.mjs"],
  off_limits: ["bench/"],
  constraints: ["no new dependencies"],
  checks: [],
  max_iterations: 10,
};

function createHarness({ cwd, picks = [], inputs = [] } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const appendedEntries = [];
  const sentMessages = [];
  const notifications = [];
  const dialogs = [];
  let activeTools = [];
  const pickQueue = [...picks];
  const inputQueue = [...inputs];

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next) {
      activeTools = [...next];
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
  });

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    async waitForIdle() {},
    sessionManager: {
      getSessionId: () => `flow:${cwd}`,
      getBranch: () => [],
    },
    ui: {
      async select(title, options) {
        dialogs.push({ title, options });
        const next = pickQueue.shift();
        if (next === undefined) return undefined;
        return typeof next === "number" ? options[next] : next;
      },
      async input(title) {
        dialogs.push({ title, input: true });
        return inputQueue.shift();
      },
      setWidget() {},
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return { appendedEntries, commands, dialogs, handlers, notifications, sentMessages, tools, ctx, activeTools: () => activeTools };
}

async function startInterview(cwd) {
  const harness = createHarness({ cwd });
  await harness.commands.get("autoresearch").handler("optimize the parser benchmark", harness.ctx);
  assert.deepEqual(harness.activeTools().sort(), [...INTERVIEW_TOOLS].sort(), "interview phase withholds the loop tools");
  return harness;
}

async function runTool(harness, name, params) {
  const tool = harness.tools.get(name);
  assert.ok(tool, `${name} is registered`);
  const updates = [];
  const result = await tool.execute("call-1", params, undefined, (update) => updates.push(update), harness.ctx);
  return { result, updates };
}

const textOf = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

test("the interview asks a question and echoes the answer back to the agent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "as-flow-"));
  try {
    const harness = await startInterview(cwd);
    harness.ctx.ui.select = async (_title, options) => options[0];

    const { result } = await runTool(harness, "ask_experiment_question", {
      question: "Which metric should we optimize?",
      options: ["Wall time", "Memory"],
      allow_custom: true,
    });

    const text = textOf(result);
    assert.match(text, /Wall time/);
    assert.match(text, /propose_experiment_plan/);
    assert.equal(harness.commands.size, 1);
    assert.deepEqual(harness.activeTools().sort(), [...INTERVIEW_TOOLS].sort(), "asking a question never starts the loop");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("confirming the plan swaps in the loop tools and steers the agent with the contract", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "as-flow-"));
  try {
    const harness = createHarness({ cwd, picks: [PLAN_CONFIRM] });
    await harness.commands.get("autoresearch").handler("optimize the parser benchmark", harness.ctx);

    const { result, updates } = await runTool(harness, "propose_experiment_plan", GOOD_PLAN);
    const text = textOf(result);

    assert.match(text, /EXPERIMENT PLAN/);
    assert.match(text, /Confirmed/);
    // The full plan reaches the transcript before the modal opens.
    assert.equal(updates.length, 1);
    assert.match(textOf(updates[0]), /EXPERIMENT PLAN/);
    assert.match(textOf(updates[0]), /files in scope/);
    assert.deepEqual(harness.activeTools().sort(), [...LOOP_TOOLS].sort(), "the loop tools are live after confirmation");

    const entry = harness.appendedEntries.at(-1);
    assert.equal(entry.customType, INTERVIEW_ENTRY);
    assert.equal(entry.data.phase, "confirmed");
    assert.equal(entry.data.plan.metricName, "parse_ms");
    assert.equal(entry.data.plan.direction, "lower");
    assert.equal(entry.data.settledAt !== undefined, true);

    const steer = harness.sentMessages.at(-1);
    assert.equal(steer.options.deliverAs, "steer");
    assert.match(steer.content, /^PLAN CONFIRMED/);
    assert.match(steer.content, /metric_name="parse_ms"/);
    assert.match(steer.content, /"maxIterations": 10/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the review dialog shows the plan before the user decides", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "as-flow-"));
  try {
    const harness = createHarness({ cwd, picks: [PLAN_CONFIRM] });
    await harness.commands.get("autoresearch").handler("optimize the parser benchmark", harness.ctx);

    await runTool(harness, "propose_experiment_plan", GOOD_PLAN);

    const [review] = harness.dialogs;
    // The modal stays compact; the plan itself is in the tool update above it.
    assert.match(review.title, /Approve this experiment plan\?/);
    assert.match(review.title, /Cut the parser benchmark wall time/);
    assert.match(review.title, /parse_ms \(ms\) — lower is better/);
    assert.doesNotMatch(review.title, /EXPERIMENT PLAN/, "the plan is not duplicated into the dialog title");
    assert.deepEqual(review.options, [PLAN_CONFIRM, PLAN_REFINE, PLAN_CANCEL]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("keep-refining returns the requested change and stays in the interview", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "as-flow-"));
  try {
    const harness = createHarness({ cwd, picks: [PLAN_REFINE], inputs: ["use p50, not mean latency"] });
    await harness.commands.get("autoresearch").handler("optimize the parser benchmark", harness.ctx);

    const { result } = await runTool(harness, "propose_experiment_plan", GOOD_PLAN);
    const text = textOf(result);

    assert.match(text, /> use p50, not mean latency/);
    assert.match(text, /propose again/);
    assert.deepEqual(harness.activeTools().sort(), [...INTERVIEW_TOOLS].sort(), "still interviewing");
    assert.equal(harness.appendedEntries.some((entry) => entry.customType === INTERVIEW_ENTRY && entry.data.phase === "confirmed"), false);
    assert.equal(harness.sentMessages.length, 1, "no steer is sent while refining");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancelling the review turns autoresearch off without creating a session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "as-flow-"));
  try {
    const harness = createHarness({ cwd, picks: [PLAN_CANCEL] });
    await harness.commands.get("autoresearch").handler("optimize the parser benchmark", harness.ctx);

    const { result } = await runTool(harness, "propose_experiment_plan", GOOD_PLAN);
    assert.match(textOf(result), /Autoresearch mode is OFF/);
    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.appendedEntries.at(-1).customType, INTERVIEW_ENTRY);
    assert.equal(harness.appendedEntries.at(-1).data.phase, "cancelled");
    assert.equal(harness.appendedEntries.at(-1).data.settledAt !== undefined, true);
    assert.equal(harness.sentMessages.length, 1, "only the activation kickoff was sent");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an invalid plan is rejected before any dialog is shown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "as-flow-"));
  try {
    const harness = await startInterview(cwd);

    const { result } = await runTool(harness, "propose_experiment_plan", { ...GOOD_PLAN, metric_name: "parse ms" });
    const text = textOf(result);

    assert.match(text, /cannot be proposed yet/);
    assert.match(text, /contains whitespace/);
    assert.equal(harness.dialogs.length, 0, "no confirm dialog for an invalid plan");
    assert.deepEqual(harness.activeTools().sort(), [...INTERVIEW_TOOLS].sort());
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("both interview tools refuse to act outside the interview phase", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "as-flow-"));
  try {
    const harness = createHarness({ cwd });
    // No /autoresearch: nothing is active at all.
    const asked = await runTool(harness, "ask_experiment_question", { question: "Anything?", options: ["yes"] });
    assert.match(textOf(asked.result), /No setup interview is active/);
    const proposed = await runTool(harness, "propose_experiment_plan", GOOD_PLAN);
    assert.match(textOf(proposed.result), /nothing to confirm/);
    assert.equal(harness.dialogs.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a headless host still activates the session but skips the interview phase", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "as-flow-"));
  try {
    const harness = createHarness({ cwd });
    harness.ctx.hasUI = false;
    await harness.commands.get("autoresearch").handler("optimize the parser benchmark", harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), [...LOOP_TOOLS].sort());
    assert.equal(harness.appendedEntries.some((entry) => entry.customType === INTERVIEW_ENTRY), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
