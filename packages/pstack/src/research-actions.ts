import { action, actionRef, ArtifactRefSchema } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";
import { z } from "zod";

import type { researchSettings } from "./extensions.ts";

// The report lives in Niwa's artifact store. The researcher returns the Markdown through its
// structured answer, so its sandbox needs no write access to the repo or to the artifact store.
const report = actionRef("pstack.feature.research.report", {
  description: "Persist Feature research as a Markdown artifact and read it back for the planner.",
  input: z.strictObject({ repo: z.string().min(1), markdown: z.string().trim().min(1).max(12000) }),
  output: z.strictObject({ artifact: ArtifactRefSchema, markdown: z.string() }),
  target: ({ repo }) => repo,
});

export function registerResearch(api: Pick<PluginApi, "action" | "artifacts">, settings: ReturnType<typeof researchSettings>): void {
  api.action(action("pstack.feature.research.settings", {
    description: "Read the host's ordered Feature research contributions.",
    input: z.strictObject({}),
    output: z.array(z.strictObject({
      name: z.string(),
      kind: z.literal("codeResearch"),
      harness: z.string(),
      model: z.string().optional(),
      effort: z.string().optional(),
    })),
    recovery: "repeat",
    effect: "read",
    world: "niwa",
    run: () => settings,
  }));
  api.action(action(report, {
    recovery: "repeat",
    idempotent: true,
    effect: "write",
    world: "local",
    run({ markdown }) {
      const artifact = api.artifacts.put(markdown, "text/markdown");
      const stored = new TextDecoder("utf-8", { fatal: true }).decode(api.artifacts.read(artifact));
      if (stored !== markdown) throw new Error(`Feature research artifact ${artifact.digest} did not match the report`);
      return { artifact, markdown: stored };
    },
  }));
}
