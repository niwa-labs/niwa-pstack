// Investigation: a read-only answer to a question about the code, with the sources it rests on. The lead traces
// the code in the local clone and answers; nothing is changed and no pull request is opened.

import type { ScriptApi } from "@niwa-labs/script";

import { playbookInput } from "./lib/inputs.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/investigation.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const answer = z.strictObject({
  summary: z.string().min(1).max(4000),
  sources: z.array(z.strictObject({ file: z.string().min(1), line: z.number().int().positive() })).max(20),
});

export default workflow(
  {
    name: "pstack-investigation",
    description: "Answer a question about the code with cited sources",
    input: playbookInput(),
    output: z.strictObject({ status: z.literal("answered"), answer }),
    uses: ["pstack.roles", "session.start.*"],
    phases: [{ title: "Trace", detail: "The lead traces the code and answers with its sources" }],
  },
  async ({ task, repo }) => {
    const seats = await roles();
    phase("Trace");
    const found = await api().agent(brief(stepTag("investigation", "trace"), text, task, ["Work read-only. Cite each claim with a file and a line."]), {
      ...seatOptions(seats.lead),
      mode: "ask",
      cwd: repo.local,
      schema: answer,
      label: "trace",
    });
    return { status: "answered" as const, answer: found };
  },
);
