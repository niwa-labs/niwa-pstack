/**
 * The forensic playbooks: the lead, in a read-only session, holds hypotheses against evidence and answers the status
 * of each, with the cause when exactly one survived. A cause with no confirmed hypothesis behind it is no cause.
 */

import { zod } from "./inputs.ts";
import { HELPER_ACTIONS, api, roles, seatOptions, stepTag } from "./script.ts";
import type { Repo } from "./script.ts";
import { brief } from "./texts.ts";
import type { PlaybookText } from "./texts.ts";

export function forensicsSchema() {
  const z = zod();
  return z.strictObject({
    status: z.enum(["found", "open"]),
    cause: z.string().nullable(),
    hypotheses: z.array(z.strictObject({ claim: z.string().min(1).max(1000), status: z.enum(["confirmed", "refuted", "open"]), evidence: z.string().max(2000) })).min(1).max(20),
  });
}

/** Ask the lead for the hypotheses and their status, and hold the cause to a confirmed one. */
export async function forensics(playbook: PlaybookText, opts: { task: string; repo: Repo; extra: string[] }) {
  const z = zod();
  const seats = await roles();
  const answer = z.strictObject({ cause: z.string().max(2000).nullable(), hypotheses: forensicsSchema().shape.hypotheses });
  const found = await api().ask(
    { ...seatOptions(seats.lead), mode: "ask", cwd: opts.repo.local, schema: answer, label: "investigate", visible: HELPER_ACTIONS },
    brief(stepTag(playbook.name, "investigate"), playbook, opts.task, [
      "Work read-only. Form the candidate hypotheses and hold each against evidence; mark each confirmed, refuted or open with the evidence.",
      "Answer the cause only when one confirmed hypothesis is it.",
      ...opts.extra,
    ]),
  );
  const [confirmed, ...others] = found.hypotheses.filter((one) => one.status === "confirmed");
  const cause = confirmed && others.length === 0 && confirmed.evidence.trim() !== "" ? confirmed.claim : null;
  return { status: cause === null ? ("open" as const) : ("found" as const), cause, hypotheses: found.hypotheses };
}
