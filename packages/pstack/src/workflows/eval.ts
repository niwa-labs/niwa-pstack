// Eval: the lead frames what is under test and writes the rubric, held back from the candidates, and an organic
// prompt; each variant answers the cases in a session of its own harness, blind to the others, and a judge of
// another vendor grades every answer by a label it cannot trace to a model. The best variant is recommended, or none
// on a tie.

import { evalSuite } from "@niwa-labs/flow-eval";
import type { ScriptApi } from "@niwa-labs/script";

import { playbookInput } from "./lib/inputs.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/eval.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({
  success: z.string().min(1).max(2000),
  rubric: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), text: z.string().min(1).max(500) })).min(3).max(6),
  cases: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), prompt: z.string().min(1).max(4000) })).min(1).max(10),
});

export default workflow(
  {
    name: "pstack-eval",
    description: "Compare variants blind on a rubric they never see",
    input: playbookInput().extend({
      variants: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), z.string().min(1)).describe("The variants under test, each the harness its candidates run on"),
    }),
    output: z.strictObject({
      status: z.literal("judged"),
      success: z.string(),
      rubric: z.array(z.strictObject({ id: z.string(), text: z.string() })),
      table: z.record(z.string(), z.record(z.string(), z.number().nullable())),
      recommend: z.string().nullable(),
    }),
    uses: ["pstack.roles", "session.start.*"],
    phases: [
      { title: "Frame", detail: "What is under test, the rubric and the organic prompt" },
      { title: "Run", detail: "Each variant answers, blind, and a judge grades" },
    ],
  },
  async ({ task, repo, variants }) => {
    const seats = await roles();
    phase("Frame");
    const frame = await api().agent(
      brief(stepTag("eval", "frame"), text, task, ["Name what counts as success, a rubric of three to six criteria for the judge only, and the organic prompts the candidates get, as cases."]),
      { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: framed, label: "frame" },
    );
    phase("Run");
    const judge = seats.judge ?? seats.reviewer;
    const result = await evalSuite("suite", {
      cases: frame.cases,
      variants,
      run: async (harness, one) => (await api().agent(one.prompt, { harness, mode: "ask", cwd: repo.local })).answer,
      rubric: frame.rubric,
      graders: [{ harness: judge.harness, vendor: judge.vendor ?? judge.harness }],
      vendorOf: (variant) => variants[variant] ?? variant,
    });
    return { status: "judged" as const, success: frame.success, rubric: frame.rubric, table: result.table, recommend: result.recommend };
  },
);
