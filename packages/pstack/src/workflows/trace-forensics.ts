// Trace forensics: a read-only reading of a trace. The lead holds every hypothesis against what the trace shows and
// answers which are confirmed, refuted or still open, and the cause when one is left.

import type { ScriptApi } from "@niwa-labs/script";

import { forensics, forensicsSchema } from "./lib/forensics.ts";
import { playbookInput } from "./lib/inputs.ts";
import text from "./texts/trace-forensics.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

export default workflow(
  {
    name: "pstack-trace-forensics",
    description: "Read a trace for the cause of a symptom",
    input: playbookInput().extend({ trace: z.string().min(1).max(2000).describe("Where the trace is: a path in the clone, or how to get it") }),
    output: forensicsSchema(),
    uses: ["pstack.roles", "session.start.*", "harness.list", "session.start", "session.ask", "session.end"],
    phases: [{ title: "Read", detail: "Every hypothesis held against the trace" }],
  },
  async ({ task, repo, trace }) => {
    phase("Read");
    return await forensics(text, { task, repo, extra: [`The trace: ${trace}`] });
  },
);
