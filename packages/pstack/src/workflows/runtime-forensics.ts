// Runtime forensics: the lead watches the program run, instruments it where its state is unclear, and answers which
// hypotheses the runtime evidence confirmed, refuted or left open, and the cause when one is left. Nothing is changed.

import type { ScriptApi } from "@niwa-labs/script";

import { forensics, forensicsSchema } from "./lib/forensics.ts";
import { playbookInput } from "./lib/inputs.ts";
import text from "./texts/runtime-forensics.json";

declare const workflow: ScriptApi["workflow"];
declare function phase(title: string): void;

export default workflow(
  {
    name: "pstack-runtime-forensics",
    description: "Find the cause of a symptom from the program running",
    input: playbookInput(),
    output: forensicsSchema(),
    uses: ["pstack.roles", "session.start.*", "harness.list", "session.start", "session.ask", "session.end"],
    phases: [{ title: "Observe", detail: "Hypotheses held against runtime evidence" }],
  },
  async ({ task, repo }) => {
    phase("Observe");
    return await forensics(text, { task, repo, extra: ["Get runtime evidence for each hypothesis: run it, log it, read it as it runs."] });
  },
);
