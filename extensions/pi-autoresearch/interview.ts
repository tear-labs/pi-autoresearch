/**
 * Guided experiment planning ("interview mode") for autoresearch.
 *
 * A fresh session that does not yet have `.auto/prompt.md` starts here instead
 * of jumping straight into the loop: the agent refines the objective with the
 * user one focused question at a time (each with recommended options), then
 * presents a confirmable plan contract. Only a confirmed plan materializes into
 * `.auto/prompt.md` / `.auto/measure.sh` and flips the extension into loop mode.
 *
 * The interaction shape follows pi-goal-x's goal-drafting flow (MIT,
 * https://github.com/tmonk/pi-goal-x): structured questionnaire dialogs plus a
 * confirm / keep-refining / cancel review step. Everything in this file is pure
 * or UI-only so it stays unit-testable without an extension host.
 */

export const INTERVIEW_ENTRY = "pi-autoresearch-interview";
export const INTERVIEW_ENTRY_VERSION = 1;

export const ASK_QUESTION_TOOL_NAME = "ask_experiment_question";
export const PROPOSE_PLAN_TOOL_NAME = "propose_experiment_plan";

/** Modal-ish UI surface these dialogs need; satisfied by pi's ExtensionContext. */
export interface InterviewUiHost {
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
}

// ---------------------------------------------------------------------------
// Questionnaire
// ---------------------------------------------------------------------------

export interface InterviewQuestion {
  id: string;
  question: string;
  /** Extra detail rendered under the question, e.g. what the agent already inferred. */
  context?: string;
  options: string[];
  /** Zero-based index of the option to mark as recommended. */
  recommended?: number;
  allowCustom?: boolean;
}

export interface InterviewAnswer {
  id: string;
  question: string;
  answer: string;
  wasCustom: boolean;
}

export interface InterviewResult {
  answers: InterviewAnswer[];
  cancelled: boolean;
  unavailable: boolean;
}

export const CUSTOM_ANSWER_LABEL = "Write my own answer";
export const DIALOG_UNAVAILABLE_HINT =
  "This host cannot display interview dialogs. Ask the same questions in chat instead, then call the tool again with the answers.";

/** Numbered, deduplicated, recommendation-clamped questions. */
export function normalizeQuestions(raw: readonly InterviewQuestion[]): InterviewQuestion[] {
  const seen = new Set<string>();
  return raw.map((question, index) => {
    let id = (question.id ?? "").trim() || `q${index + 1}`;
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const options = (question.options ?? []).map((option) => option.trim()).filter((option) => option.length > 0);
    const recommended =
      question.recommended !== undefined && question.recommended >= 0 && question.recommended < options.length
        ? question.recommended
        : undefined;
    return {
      id,
      question: question.question.trim(),
      ...(question.context?.trim() ? { context: question.context.trim() } : {}),
      options,
      ...(recommended !== undefined ? { recommended } : {}),
      allowCustom: question.allowCustom ?? true,
    };
  });
}

/** Echo the Q&A back to the model so the answers survive a context reset. */
export function formatInterviewAnswers(result: InterviewResult): string {
  return result.answers.map((answer) => `**Q:** ${answer.question}\n**A:** ${answer.answer}`).join("\n\n---\n\n");
}

/**
 * Run the questions as sequential dialogs.
 *
 * pi's `select`/`input` primitives are used instead of a bespoke TUI component:
 * they render in the terminal UI *and* in pi-web's RPC host, and they never
 * capture scrollback the way a tall custom overlay can.
 */
export async function runQuestionnaire(host: InterviewUiHost, raw: readonly InterviewQuestion[]): Promise<InterviewResult> {
  const unavailable = (): InterviewResult => ({ answers: [], cancelled: true, unavailable: true });
  const questions = normalizeQuestions(raw);
  if (!host.hasUI || typeof host.ui?.select !== "function") return unavailable();
  if (questions.length === 0) return { answers: [], cancelled: false, unavailable: false };

  const needsInput = questions.some((question) => question.options.length === 0 || question.allowCustom !== false);
  if (needsInput && typeof host.ui.input !== "function") return unavailable();

  const answers: InterviewAnswer[] = [];
  for (const question of questions) {
    const prompt = question.context ? `${question.question}\n\n${question.context}` : question.question;
    let answer: string | undefined;
    let wasCustom = question.options.length === 0;

    if (!wasCustom) {
      // Numbered labels keep duplicate or misleading option text unambiguous.
      const labels = question.options.map(
        (option, index) => `${index + 1}. ${option}${question.recommended === index ? "  (recommended)" : ""}`,
      );
      const customLabel = `${labels.length + 1}. ${CUSTOM_ANSWER_LABEL}`;
      const offered = question.allowCustom === false ? labels : [...labels, customLabel];
      const picked = await host.ui.select(prompt, offered);
      if (picked === undefined) return { answers, cancelled: true, unavailable: false };
      if (!offered.includes(picked)) throw new Error(`The host returned an unknown interview choice: ${picked}`);
      wasCustom = question.allowCustom !== false && picked === customLabel;
      if (!wasCustom) answer = question.options[labels.indexOf(picked)];
    }

    if (wasCustom) {
      // Whitespace alone is not an answer; re-ask until something real arrives.
      do {
        answer = (await host.ui.input(prompt, "Type your answer"))?.trim();
      } while (answer === "");
    }
    if (answer === undefined) return { answers, cancelled: true, unavailable: false };
    answers.push({ id: question.id, question: question.question, answer, wasCustom });
  }
  return { answers, cancelled: false, unavailable: false };
}

// ---------------------------------------------------------------------------
// Plan contract
// ---------------------------------------------------------------------------

export type PlanDirection = "lower" | "higher";

export interface ExperimentPlan {
  /** One sentence: what we are optimizing, on which workload. */
  objective: string;
  /** The concrete thing each iteration runs — benchmark, test suite, script. */
  workload: string;
  /** Command the loop runs every iteration (usually `./.auto/measure.sh`). */
  command: string;
  metricName: string;
  metricUnit: string;
  direction: PlanDirection;
  secondaryMetrics: string[];
  filesInScope: string[];
  offLimits: string[];
  constraints: string[];
  /** Hard correctness gates for `.auto/checks.sh`; empty means no checks file. */
  checks: string[];
  maxIterations: number | null;
}

export type PlanValidation =
  | { ok: true; plan: ExperimentPlan }
  | { ok: false; problems: string[] };

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = asText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Validate a proposed plan. The metric name check is not cosmetic: `measure.sh`
 * emits `METRIC name=value` and the parser splits on whitespace, so a metric
 * name containing a space silently produces no primary metric at all.
 */
export function validatePlan(raw: unknown): PlanValidation {
  const input = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];

  const objective = asText(input.objective);
  const workload = asText(input.workload);
  const command = asText(input.command);
  const metricName = asText(input.metricName);
  const metricUnit = asText(input.metricUnit);
  const direction = asText(input.direction);

  if (!objective) problems.push("objective is empty — state what is being optimized in one sentence.");
  if (!command) problems.push("command is empty — the loop needs a command to run each iteration.");
  if (!metricName) problems.push("metricName is empty — the primary metric must have a name.");
  if (/\s/.test(metricName)) {
    problems.push(`metricName "${metricName}" contains whitespace; measure.sh emits METRIC name=value, so names must be a single token (e.g. "${metricName.replace(/\s+/g, "_")}").`);
  }
  if (direction !== "lower" && direction !== "higher") {
    problems.push('direction must be "lower" or "higher".');
  }
  if (!workload) problems.push("workload is empty — say what each iteration actually measures.");

  const maxIterationsRaw = input.maxIterations;
  let maxIterations: number | null = null;
  if (maxIterationsRaw !== undefined && maxIterationsRaw !== null && maxIterationsRaw !== "") {
    const parsed = typeof maxIterationsRaw === "number" ? maxIterationsRaw : Number(maxIterationsRaw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      problems.push("maxIterations must be a positive integer or omitted.");
    } else {
      maxIterations = parsed;
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    plan: {
      objective,
      workload,
      command,
      metricName,
      metricUnit,
      direction: direction as PlanDirection,
      secondaryMetrics: asTextList(input.secondaryMetrics),
      filesInScope: asTextList(input.filesInScope),
      offLimits: asTextList(input.offLimits),
      constraints: asTextList(input.constraints),
      checks: asTextList(input.checks),
      maxIterations,
    },
  };
}

// One wider than the longest label ("secondary metrics:") so every row keeps a gap.
const PLAN_LABEL_WIDTH = 19;

function planField(label: string, value: string): string {
  const pad = label.padEnd(PLAN_LABEL_WIDTH);
  const lines = value.split("\n");
  const first = `${pad}${lines[0] ?? ""}`;
  const rest = lines.slice(1).map((line) => `${" ".repeat(PLAN_LABEL_WIDTH)}${line}`);
  return [first, ...rest].join("\n");
}

function planList(label: string, values: string[], empty: string): string {
  if (values.length === 0) return planField(label, `— (${empty})`);
  const bullets = values.map((value, index) => `${index === 0 ? "" : "\n"}  • ${value}`).join("");
  return planField(label, bullets);
}

/** Human review block: everything the user is being asked to approve. */
export function renderPlan(plan: ExperimentPlan): string {
  const directionWord = plan.direction === "lower" ? "lower is better" : "higher is better";
  const metric = `${plan.metricName}${plan.metricUnit ? ` (${plan.metricUnit})` : ""} — ${directionWord}`;
  return [
    "EXPERIMENT PLAN (nothing runs until you confirm)",
    "",
    planField("objective:", plan.objective),
    planField("workload:", plan.workload),
    planField("command:", plan.command),
    planField("primary metric:", metric),
    planList("secondary metrics:", plan.secondaryMetrics, "none"),
    planList("files in scope:", plan.filesInScope, "agent decides"),
    planList("off limits:", plan.offLimits, "nothing declared"),
    planList("constraints:", plan.constraints, "none"),
    planList("checks:", plan.checks, "no .auto/checks.sh"),
    planField("max iterations:", plan.maxIterations === null ? "unbounded" : String(plan.maxIterations)),
  ].join("\n");
}

/**
 * Compact review prompt for the modal.
 *
 * The dialog title is rendered inline in a fixed-height region, so it must stay
 * short; the full plan is published to the transcript with a tool update before
 * the dialog opens.
 */
export function renderPlanSummary(plan: ExperimentPlan): string {
  const directionWord = plan.direction === "lower" ? "lower is better" : "higher is better";
  const rows = [
    ["objective", plan.objective],
    ["workload", plan.workload],
    ["command", plan.command],
    ["metric", `${plan.metricName}${plan.metricUnit ? ` (${plan.metricUnit})` : ""} — ${directionWord}`],
    ["iterations", plan.maxIterations === null ? "unbounded" : String(plan.maxIterations)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    "Approve this experiment plan?",
    "",
    ...rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
    "",
    "Scope, off limits, constraints and checks are listed in full above.",
  ].join("\n");
}

export type PlanDecision = "confirm" | "refine" | "cancel";

export const PLAN_CONFIRM = "Confirm — set this up and start the loop";
export const PLAN_REFINE = "Keep refining — I want to change something";
export const PLAN_CANCEL = "Cancel — do not start a session";

export interface PlanReview {
  decision: PlanDecision;
  unavailable: boolean;
}

/** Ask the user to approve the plan; escape means "keep refining", never "stuck". */
export async function reviewPlan(host: InterviewUiHost, prompt: string): Promise<PlanReview> {
  if (!host.hasUI || typeof host.ui?.select !== "function") return { decision: "refine", unavailable: true };
  const offered = [PLAN_CONFIRM, PLAN_REFINE, PLAN_CANCEL];
  const picked = await host.ui.select(prompt, offered);
  if (picked === undefined) return { decision: "refine", unavailable: false };
  if (picked === PLAN_CONFIRM) return { decision: "confirm", unavailable: false };
  if (picked === PLAN_CANCEL) return { decision: "cancel", unavailable: false };
  if (picked === PLAN_REFINE) return { decision: "refine", unavailable: false };
  throw new Error(`The host returned an unknown plan decision: ${picked}`);
}

/** The steer sent once the user confirms: file writes, then the loop. */
export function confirmedPlanSteer(plan: ExperimentPlan): string {
  return [
    "PLAN CONFIRMED — set the session up now.",
    "",
    renderPlan(plan),
    "",
    "Do this, in order:",
    "1. `mkdir -p .auto`, then write `.auto/prompt.md` from the plan above:",
    "   - the objective and workload verbatim,",
    "   - the primary metric with unit and direction, secondary metrics,",
    "   - `./.auto/measure.sh` as the command,",
    "   - every file in scope with a one-line note on what it does, plus off-limits and constraints,",
    "   - a `## What's Been Tried` section (empty is fine).",
    "2. Write `.auto/measure.sh` (`set -euo pipefail`) that runs the workload and prints `METRIC name=value` lines for the primary and secondary metrics.",
    plan.checks.length > 0
      ? "3. Write `.auto/checks.sh` (`set -euo pipefail`) for the declared checks. Keep output minimal — only errors should reach the agent."
      : "3. No `.auto/checks.sh`: the plan declared no correctness checks.",
    plan.maxIterations === null
      ? "4. No iteration cap."
      : `4. Write \`.auto/config.json\` with {"maxIterations": ${plan.maxIterations}}.`,
    "5. Commit `.auto/` files, check out the experiment branch if you have not already.",
    `6. Call init_experiment with name="${plan.metricName}", metric_name="${plan.metricName}", metric_unit="${plan.metricUnit}", direction="${plan.direction}".`,
    "7. Run the baseline with run_experiment, log it with log_experiment, then loop forever.",
    "Do not re-ask the questions the user already answered above.",
  ].join("\n");
}

/** System-prompt section that installs the interview protocol for this turn. */
export function interviewSystemPromptSection(): string {
  return [
    "",
    "",
    "## Autoresearch Setup (INTERVIEW PHASE)",
    "No plan has been confirmed for this session yet. Do NOT run experiments and do NOT write `.auto/prompt.md` until the plan is confirmed.",
    "1. Read the relevant source files first, cheaply, so you can propose concrete options instead of asking the user to do your reconnaissance.",
    "2. Ask focused questions with `ask_experiment_question` — one question per call, 2–5 concrete options, the one you recommend marked `recommended`. Ask only what you cannot infer from the repo, and prefer fewer, better questions over an interrogation.",
    "3. When you can state the objective, workload, command, primary metric (+unit, direction), scope, constraints and optional checks, call `propose_experiment_plan`. It shows the user the full plan and their confirm / keep-refining / cancel choice.",
    "4. If they keep refining, they will tell you (or the dialog text will) what to change: adjust the root cause, do not just re-word the same plan.",
    "5. On confirmation you receive the confirmed plan back — write the `.auto/` files and start the loop exactly as instructed.",
    "If the user asks to skip setup, they can restart with `/autoresearch --no-interview <goal>`; never skip the confirmation on your own initiative.", 
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Durable interview session (survives compaction / tree navigation)
// ---------------------------------------------------------------------------

export interface InterviewEntry {
  version: number;
  phase: "interview" | "confirmed" | "cancelled";
  topic: string;
  startedAt: string;
  plan?: ExperimentPlan;
  settledAt?: string;
}

interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Last interview entry on the branch; `null` when there is none. */
export function readInterviewEntry(branch: readonly BranchEntryLike[]): InterviewEntry | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== INTERVIEW_ENTRY) continue;
    const data = entry.data as InterviewEntry | undefined;
    if (!data || data.version !== INTERVIEW_ENTRY_VERSION) return null;
    return data;
  }
  return null;
}

/** An interview is live when the newest entry says so and nothing settled it. */
export function isInterviewLive(entry: InterviewEntry | null): boolean {
  return entry !== null && entry.phase === "interview" && !entry.settledAt;
}
