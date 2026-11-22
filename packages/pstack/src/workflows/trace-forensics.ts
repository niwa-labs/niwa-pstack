import type { ScriptApi } from "@niwa-labs/script";

import { forensicsSchema } from "./lib/forensics.ts";
import { playbookInput } from "./lib/inputs.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import { reduceTrace, traceCaptureSchema } from "./lib/trace-reduction.ts";
import text from "./texts/trace-forensics.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const attribution = z.strictObject({ symbol: z.string(), file: z.string(), line: z.number().int().positive() });
const route = z.enum(["bug-fix", "perf-issue"]);
const pairs = z.strictObject({
  path: z.string().min(1), surface: z.string().min(1), driver: z.string().min(1), condition: z.string().min(1),
});
const reading = forensicsSchema().omit({ status: true }).extend({
  source: attribution.optional(), route: route.optional(), observed: z.string().optional(),
});
const evidenceSchema = z.strictObject({
  before: traceCaptureSchema(), after: traceCaptureSchema().nullable(),
  beforeQuery: traceCaptureSchema().nullable(), query: traceCaptureSchema().nullable(),
  paired: pairs.nullable(), source: attribution.nullable().optional(), observed: z.string(), pairConfirmed: z.boolean(),
});

export default workflow(
  {
    name: "pstack-trace-forensics",
    description: "Read fixed captures for the cause of a symptom",
    input: playbookInput().extend({ trace: z.string().min(1).max(2000), paired: pairs.optional() }),
    output: forensicsSchema().extend({ evidence: evidenceSchema, handoff: z.strictObject({ playbook: route, task: z.string() }).nullable(), checkpoint: z.string() }),
    uses: ["pstack.roles", "session.start.*", "session.ask", "session.end", "proc.run@{repo.local}"],
    phases: [{ title: "Read" }, { title: "Attribute" }],
  },
  async ({ task, repo, trace, paired }) => {
    phase("Read");
    const before = await reduceTrace("trace-before", repo.local, trace);
    const after = paired ? await reduceTrace("trace-paired", repo.local, paired.path) : null;
    const seats = await roles();
    phase("Attribute");
    const found = await api().ask(
      { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: reading, label: "investigate" },
      brief(stepTag("trace-forensics", "investigate"), text, task, [
        `The trace: ${trace}`,
        "Read fixed captures only. Use the reduced SQLite query rows and source symbols. Cite file, function and line. Identify what the control changed and route a verified diagnosis to Bug fix or Perf issue.",
        JSON.stringify({ before: before.reduced, after: after?.reduced, paired }),
      ]),
    );
    const source = found.source;
    const first = before.reduced;
    const second = after?.reduced;
    const beforeQuery = first && source ? await reduceTrace("trace-original-frame", repo.local, trace, source) : null;
    const weight = beforeQuery?.reduced?.sha256 === first?.sha256 ? beforeQuery?.reduced?.focus ?? 0 : 0;
    const query = weight > 0 && source && paired && second ? await reduceTrace("trace-paired-frame", repo.local, paired.path, source) : null;
    const followup = query?.reduced;
    const pairConfirmed = !!(first && second && followup && first.format === second.format && first.sha256 !== second.sha256 &&
      followup.sha256 === second.sha256 && first.weight > 0 && second.weight > 0 && followup.focus !== null &&
      weight > followup.focus && weight / first.weight > followup.focus / second.weight);
    const confirmed = found.hypotheses.filter((one) => one.status === "confirmed" && one.evidence.trim() !== "");
    const cause = pairConfirmed && confirmed.length === 1 && found.cause === confirmed[0]?.claim ? found.cause : null;
    return {
      status: cause ? "found" as const : "open" as const, cause,
      hypotheses: cause ? found.hypotheses : found.hypotheses.map((one) => ({ ...one, status: one.status === "confirmed" ? "open" as const : one.status })),
      evidence: { before, after, beforeQuery, query, paired: paired ?? null, source: weight > 0 ? source : null, observed: found.observed ?? "", pairConfirmed },
      handoff: cause && found.route ? { playbook: found.route, task: `${task}\n${cause} at ${source?.file}:${source?.line}. Captures: ${trace}, ${paired?.path}.` } : null,
      checkpoint: "throughput checkpoint: n/a, read-only forensics",
    };
  },
);
