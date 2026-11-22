import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { frame } from "./lib/change.ts";
import { forensicsSchema } from "./lib/forensics.ts";
import { playbookInput } from "./lib/inputs.ts";
import { capture, captureFreshFile, evidenceSchema, exactCheckout } from "./lib/parity-proof.ts";
import { roles } from "./lib/script.ts";
import { reduceTrace, traceCaptureSchema } from "./lib/trace-reduction.ts";
import text from "./texts/runtime-forensics.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const detail = z.string().trim().min(1).max(4000);
const route = z.enum(["bug-fix", "perf-issue"]);
const plan = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("blocked"), why: detail }),
  z.strictObject({
    kind: z.literal("capture"), target: detail, surface: detail, driver: detail,
    signal: detail, path: detail, setup: detail, observe: detail, control: detail, cleanup: detail,
    expected: detail, controlExpected: detail,
  }),
]);
const sourceSchema = z.strictObject({ file: detail, symbol: detail, line: z.number().int().positive() }).nullable();
const diagnosis = forensicsSchema().omit({ status: true }).extend({ source: sourceSchema, route: route.nullable() });
const captureSchema = z.strictObject({
  target: detail, surface: detail, driver: detail, head: z.string(), worktree: z.string(),
  signal: evidenceSchema(), trace: traceCaptureSchema().nullable(),
});
const probeSchema = captureSchema.extend({ probe: evidenceSchema() });
const runtimeEvidence = z.union([z.null(), captureSchema, probeSchema, probeSchema.extend({
  source: sourceSchema, location: evidenceSchema().nullable(),
})]);
const checkpoint = "throughput checkpoint: n/a, read-only forensics";

export default workflow(
  {
    name: "pstack-runtime-forensics",
    description: "Find the cause of a symptom from the program running",
    input: playbookInput(),
    output: forensicsSchema().extend({ checkpoint: z.string(), evidence: runtimeEvidence, handoff: z.strictObject({ playbook: route, task: z.string() }).nullable() }),
    uses: ["pstack.roles", "session.start.*", "session.ask", "session.end", "git.worktree.create", "git.worktree.get", "proc.run@{worktrees}/*"],
    phases: [{ title: "Frame" }, { title: "Observe" }, { title: "Attribute" }],
  },
  async ({ task, repo, base }) => {
    const seats = await roles();
    phase("Frame");
    const got = await frame(text, { task, repo, roles: seats, label: "capture-plan", schema: plan, ask: [
      "Name the target, driver and matching surface. Give a boxed command and output path to capture a real CPU, heap or CDP artifact. Keep the original capture outside tracked files.",
      "Specify temporary setup, two repeatable observations of the same mechanism, a contrasting control, concrete expected output strings, and teardown. The observation/control commands run inside one process while the instrumentation is active. Block with a concrete reason if that target or driver is unavailable.",
    ] });
    const open = (why: string, evidence: typeof runtimeEvidence["_output"]) => ({
      status: "open" as const, cause: null, hypotheses: [{ claim: task, status: "open" as const, evidence: why }],
      evidence, handoff: null, checkpoint,
    });
    if (got.kind === "blocked") return open(got.why, null);
    if (got.controlExpected.includes(got.expected)) return open("Observation and control need distinct signals", null);
    if (got.path.startsWith("/") || got.path.split("/").some((part) => part === ".." || part === "." || !part)) {
      return open("Allocate a capture path inside the isolated worktree", null);
    }

    phase("Observe");
    const wt = await makeWorktree({ repo: repo.local, base, description: "Capture runtime behavior read only" });
    const head = await exactCheckout(wt, "runtime-base");
    const signal = await captureFreshFile("runtime-signal", wt.path, got.signal, got.path);
    const trace = signal.complete && signal.exit === 0 ? await reduceTrace("runtime-reduce", wt.path, got.path) : null;
    await exactCheckout(wt, "runtime-captured", head);
    if (!trace?.reduced?.count) return open("The matching driver did not write a fresh, readable runtime capture", {
      target: got.target, surface: got.surface, driver: got.driver, head, worktree: wt.path, signal, trace,
    });
    const probe = await capture("runtime-probe", wt.path, [
      "sh", "-c", [
        'trap \'rc=$?; trap - EXIT; set +e; sh -c "$4"; cleared=$?; printf "\\nCLEANUP=%s\\n" "$cleared"; [ "$cleared" -eq 0 ] || exit "$cleared"; exit "$rc"\' EXIT',
        'set -e',
        'sh -c "$1"',
        'printf "\\nOBSERVE-1\\n"; sh -c "$2"',
        'printf "\\nOBSERVE-2\\n"; sh -c "$2"',
        'printf "\\nCONTROL\\n"; sh -c "$3"',
      ].join("\n"), "runtime-probe", got.setup, got.observe, got.control, got.cleanup,
    ]);
    await exactCheckout(wt, "runtime-cleanup", head);
    const [first, repeated, control] = probe.tail.split(/\n(?:OBSERVE-1|OBSERVE-2|CONTROL)\n/).slice(1);
    const proved = trace?.reduced && trace.reduced.count > 0 && probe.complete && probe.exit === 0 && probe.tail.trimEnd().endsWith("CLEANUP=0") &&
      first?.includes(got.expected) && repeated?.includes(got.expected) && control?.includes(got.controlExpected) && !control.includes(got.expected);
    const evidence = { target: got.target, surface: got.surface, driver: got.driver, head, worktree: wt.path, signal, trace, probe };
    if (!proved) return open("The capture, repeated mechanism, contrasting observation or teardown was inconclusive", evidence);

    phase("Attribute");
    const found = await frame(text, { task, repo, roles: seats, label: "investigate", schema: diagnosis, ask: [
      "Map the measured mechanism to the allocating/scheduling source file, symbol and line. Resolve every plausible hypothesis from the observations. Choose Bug fix or Perf issue if the evidence supports a handoff.",
      JSON.stringify({ reduced: trace.reduced, mechanism: probe.tail }),
    ] });
    const confirmed = found.hypotheses.filter((one) => one.status === "confirmed" && one.evidence.trim() !== "");
    const source = found.source;
    const location = source ? await capture("runtime-source", wt.path, [
      "git", "show", `${head}:${source.file}`,
    ]) : null;
    const sourceExists = location?.exit === 0 && location.complete &&
      (location.artifact === null || location.artifact.size <= new TextEncoder().encode(location.tail).length) &&
      location.tail.split("\n").length >= (source?.line ?? Infinity);
    const cause = sourceExists && confirmed.length === 1 && found.cause === confirmed[0]?.claim ? found.cause : null;
    return {
      status: cause ? "found" as const : "open" as const, cause,
      hypotheses: cause ? found.hypotheses : found.hypotheses.map((one) => ({ ...one, status: one.status === "confirmed" ? "open" as const : one.status })),
      evidence: { ...evidence, source, location },
      handoff: cause && found.route ? { playbook: found.route, task: `${task}\n${cause} at ${source?.file}:${source?.line}. Capture: ${wt.path}/${got.path}.` } : null,
      checkpoint,
    };
  },
);
