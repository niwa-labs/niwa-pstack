// Refactoring: the lead names the contract, the pin that holds it, and the shape the code should have; the owner
// lane pins the behaviour first and moves the structure under it.

import type { ScriptApi } from "@niwa-labs/script";

import { runBuiltin } from "./lib/catalog.ts";
import { changedSchema, frame } from "./lib/change.ts";
import { compareArchitecture } from "./lib/decision-architecture.ts";
import { deliverDecision } from "./lib/decision-delivery.ts";
import { playbookInput } from "./lib/inputs.ts";
import { reshape } from "./lib/refactor-evidence.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/refactoring.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({ contract: z.string().min(1).max(4000), pin: z.string().min(1).max(2000), target: z.string().min(1).max(4000) });
const handoff = z.strictObject({ route: z.enum(["feature", "figure-it-out"]), why: z.string().min(1).max(4000) });
const redirected = handoff.extend({ kind: z.literal("handoff"), offer: z.boolean().optional() });
const scope = z.discriminatedUnion("kind", [framed.extend({ kind: z.literal("reshape"), crossesBoundary: z.boolean() }), redirected]);
const broadFrame = framed.extend({ oneWayDesign: z.boolean() });
const input = playbookInput().extend({ figureItOut: z.boolean().optional() });

export default workflow(
  {
    name: "pstack-refactoring",
    description: "Reshape code behind a pinned contract",
    input,
    output: z.union([
      changedSchema().extend({ framed, receipts: z.array(z.string()) }),
      handoff.extend({
        status: z.literal("handoff"), continuation: z.json().optional(),
        next: z.strictObject({ playbook: z.enum(["feature", "refactoring"]), args: input }),
      }),
      z.strictObject({ status: z.literal("stopped"), why: z.string(), framed, receipts: z.array(z.string()) }),
    ]),
    uses: [
      "pstack.roles",
      "session.start.*",
      "harness.list",
      "session.start",
      "session.ask",
      "session.end",
      "pstack.author.options",
      "box.net@{repo.host}",
      "git.worktree.create",
      "proc.run@{worktrees}/*",
      "pstack.pr.bind",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "forge.checks.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
      "request.ask",
      "workflow.list",
      "workflow.start",
    ],
    phases: [
      { title: "Frame", detail: "The lead frames the work, read-only" },
      { title: "Build", detail: "An owner lane carries it to a verified pull request" },
    ],
  },
  async ({ task, repo, worktrees, base, figureItOut }) => {
    const seats = await roles();
    const lane = { playbook: text, repo, base, worktrees, roles: seats, task };
    const execute = async (got: import("zod").z.output<typeof framed>, broad = false) => {
      phase("Build");
      const prepared = await reshape({ ...lane, ...got, broad });
      if (prepared.status === "stopped") return { ...prepared, framed: got };
      const done = await deliverDecision("change", {
        ...lane,
        receipts: prepared.receipts,
        verification: [`Contract: ${got.contract}`, `Independently prove equivalence on the real artifact. Pin: ${got.pin}`, ...prepared.receipts],
      }, prepared.artifact);
      return { ...done, framed: got, receipts: prepared.receipts };
    };
    const redirect = async ({ route, why, offer }: import("zod").z.output<typeof redirected>) => {
      const explanation = "\n\nRefactoring discovered: " + why;
      const args = { repo, base, worktrees, task: task.slice(0, Math.max(0, 4000 - explanation.length)) + explanation.slice(0, 4000) };
      const next = route === "feature" ? { playbook: "feature" as const, args }
        : { playbook: "refactoring" as const, args: { ...args, figureItOut: true } };
      const result = { status: "handoff" as const, route, why, next };
      if (!(figureItOut && route === "figure-it-out") &&
          (!offer || !await api().ask.confirm(`Continue to ${route}?\n\n${why}`, { label: "handoff-" + route }))) return result;
      if (route === "feature") {
        const built = await runBuiltin("feature", "feature", args);
        return { ...result, continuation: z.json().parse(built) };
      }
      const { oneWayDesign, ...shaped } = await frame(text, {
        task, repo, roles: seats, schema: broadFrame, label: "figure-it-out", ask: [
          "Trace and quantify the cross-cutting reshape. Frame the unchanged behavior, a falsifiable baseline capture, and the structure to change. Lead with the most uncertain phases. Obtain architectural advice first for irreversible boundary decisions.",
          "Set oneWayDesign when there is an irreversible or contested boundary decision. Mechanical work with a settled shape needs no new consultation.",
          why,
        ],
      });
      if (oneWayDesign) {
        const { advice } = await compareArchitecture({
          playbook: text, task, cwd: repo.local, seats,
          context: JSON.stringify({ shaped, why }),
        });
        shaped.target = advice.shape;
      }
      return execute(shaped, true);
    };
    phase("Frame");
    if (figureItOut) return redirect({ kind: "handoff", route: "figure-it-out", why: task });
    const scopeDecision = await frame(text, { task, repo, roles: seats, schema: scope, ask: [
      "For a focused reshape, name the behavior contract, the test or harness that pins it, and the target shape. Mark crossesBoundary true if the target crosses a function boundary.",
      "For a redesign that changes behavior, return a feature handoff. For large or cross-cutting structural work, return a figure-it-out handoff. Set offer to ask whether the owner wants the continuation in this run.",
    ] });
    if (scopeDecision.kind === "handoff") return redirect(scopeDecision);
    const { kind: _kind, crossesBoundary, ...got } = scopeDecision;
    if (crossesBoundary) {
      const target = await api().ask({
        ...seatOptions(seats.reviewer), mode: "ask", cwd: repo.local,
        schema: z.strictObject({ target: framed.shape.target, contested: z.boolean().optional() }), label: "architect",
      }, brief(stepTag("refactoring", "architect"), text, task, [
        "Act as the delegated architect. Trace the boundary and its callers. Specify the target types, signatures, ownership, migration wave and equivalence checks. Work read-only and preserve the pinned contract.",
        "Mark contested when viable competing shapes remain.",
        JSON.stringify(got),
      ]));
      const proposed = target.contested ? await compareArchitecture({
        playbook: text, task, cwd: repo.local, seats, context: JSON.stringify({ ...got, prior: target.target }),
      }) : target;
      const lead = await frame(text, { task, repo, roles: seats, schema: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("reshape"), target: framed.shape.target }), redirected,
      ]), label: "approve-shape", ask: [
        "Choose the final behavior-preserving structure using the architect's evidence, or return a handoff if the proposed shape needs broader design work.",
        JSON.stringify({ ...got, proposed }),
      ] });
      if (lead.kind === "handoff") return redirect(lead);
      got.target = lead.target;
    }
    return execute(got);
  },
);
