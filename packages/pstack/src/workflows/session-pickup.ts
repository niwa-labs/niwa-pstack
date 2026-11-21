// Session pickup: a cold start from the trail. The run reads what niwa keeps of the work, the plan and what was
// attested on it, and the lead answers where it stands, what is verified, and the first action; the trail is taken as
// it is, not proven again.

import type { ScriptApi } from "@niwa-labs/script";

import { goSubject } from "../policy.ts";
import { playbookInput } from "./lib/inputs.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/session-pickup.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const pickup = z.strictObject({
  where: z.string().min(1).max(4000),
  verified: z.array(z.string().max(1000)).max(30),
  next: z.string().min(1).max(2000),
});

export default workflow(
  {
    name: "pstack-session-pickup",
    description: "Pick up work from the trail niwa keeps of it",
    input: playbookInput().extend({ plan: z.string().min(1).max(200).optional().describe("The plan the work follows, when it has one") }),
    output: z.strictObject({ status: z.literal("picked-up"), plan: z.json().optional(), pickup }),
    uses: ["pstack.roles", "session.start.*", "plan.get", "evidence.list"],
    phases: [
      { title: "Read", detail: "The plan and what was attested on it" },
      { title: "Resume", detail: "Where it stands and the first action" },
    ],
  },
  async ({ task, repo, plan: of }) => {
    phase("Read");
    const trail: string[] = [];
    let plan: { of: string; rev: number; items: Array<{ id: string; text: string; state: string }> } | undefined;
    if (of !== undefined) {
      plan = (await api().call("plan.get", { of }, { label: "plan" })) as NonNullable<typeof plan>;
      trail.push(`The plan ${plan.of}, revision ${String(plan.rev)}:`, ...plan.items.map((item) => `- ${item.id} (${item.state}): ${item.text}`));
      for (const item of plan.items) {
        const listed = (await api().call("evidence.list", { subject: goSubject(plan, item.id) }, { label: `go-${item.id}` })) as { items: unknown[] };
        trail.push(`- ${item.id}: ${String(listed.items.length)} attestation(s) of the go on this revision`);
      }
    }
    const recent = (await api().call("evidence.list", { limit: 50 }, { label: "evidence" })) as { items: Array<{ subject: string; claim: unknown; author: unknown }> };
    trail.push("What was attested:", ...recent.items.map((one) => `- ${one.subject}: ${JSON.stringify(one.claim)} by ${JSON.stringify(one.author)}`));
    phase("Resume");
    const seats = await roles();
    const got = await api().agent(
      brief(stepTag("session-pickup", "resume"), text, task, ["The trail is authoritative: do not prove it again.", "", ...trail, "", "Answer where the work stands, what is verified, and the first action."]),
      { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: pickup, label: "resume" },
    );
    return { status: "picked-up" as const, ...(plan === undefined ? {} : { plan: plan as never }), pickup: got };
  },
);
