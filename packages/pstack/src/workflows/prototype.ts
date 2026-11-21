// Prototype: a throwaway instrument for one decision. The lead scopes the decision and the variants worth trying;
// an author boxed to a scratch worktree of its own builds each variant and observes the thing being decided, and the
// lead recommends one. Nothing is opened for review: the variants stay in their worktrees for the owner to look at.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { playbookInput } from "./lib/inputs.ts";
import { api, authorOptions, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/prototype.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const scoped = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("decide"),
    decision: z.string().min(1).max(2000),
    variants: z.array(z.strictObject({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/), idea: z.string().min(1).max(2000) })).min(2).max(5),
  }),
  z.strictObject({ kind: z.literal("none"), why: z.string().min(1).max(2000) }),
]);

export default workflow(
  {
    name: "pstack-prototype",
    description: "Settle a design decision with throwaway variants",
    input: playbookInput(),
    output: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("decided"),
        decision: z.string(),
        variants: z.array(z.strictObject({ name: z.string(), path: z.string(), observed: z.string() })),
        recommend: z.string(),
        why: z.string(),
      }),
      z.strictObject({ status: z.literal("no-decision"), why: z.string() }),
    ]),
    uses: ["pstack.roles", "session.start.*", "session.ask", "session.end", "pstack.author.options", "git.worktree.create"],
    phases: [
      { title: "Scope", detail: "The decision and the variants" },
      { title: "Build", detail: "Each variant in a scratch worktree, observed" },
      { title: "Recommend", detail: "The lead picks one" },
    ],
  },
  async ({ task, repo, base }) => {
    const seats = await roles();
    phase("Scope");
    const scope = await api().ask(
      { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: scoped, label: "scope" },
      brief(stepTag("prototype", "scope"), text, task, ["Name the decision the prototype exists to make and two to five variants. No decision: answer none and route to Feature."]),
    );
    if (scope.kind === "none") return { status: "no-decision" as const, why: scope.why };
    phase("Build");
    const built: Array<{ name: string; path: string; observed: string }> = [];
    for (const variant of scope.variants) {
      const wt = await makeWorktree({ repo: repo.local, base, description: `Prototype ${variant.name}: ${scope.decision}`.slice(0, 120) });
      const author = await api().session({ ...await authorOptions(`author-${variant.name}`, wt.path), label: `author-${variant.name}` });
      const seen = await author.ask(
        brief(stepTag("prototype", "build"), text, task, [`The decision: ${scope.decision}`, `Build the variant ${variant.name} as a throwaway in ${wt.path}: ${variant.idea}`, "Observe the thing being decided and answer what you saw."]),
        { schema: z.strictObject({ observed: z.string().min(1).max(4000) }), label: `build-${variant.name}` },
      );
      await author.end();
      built.push({ name: variant.name, path: wt.path, observed: seen.observed });
    }
    phase("Recommend");
    const names = scope.variants.map((one) => one.name) as [string, ...string[]];
    const picked = await api().ask(
      { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: z.strictObject({ recommend: z.enum(names), why: z.string().min(1).max(4000) }), label: "recommend" },
      brief(stepTag("prototype", "recommend"), text, task, [`The decision: ${scope.decision}`, ...built.map((one) => `- ${one.name}: ${one.observed}`), "Recommend one variant and say why."]),
    );
    return { status: "decided" as const, decision: scope.decision, variants: built, recommend: picked.recommend, why: picked.why };
  },
);
