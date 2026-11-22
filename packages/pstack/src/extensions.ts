import { z } from "zod";

import { SeatRole } from "./roles.ts";

const ExtensionName = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const ResearchSeat = SeatRole.omit({ vendor: true });
const Extension = z.strictObject({
  name: ExtensionName,
  feature: z.strictObject({
    beforePlan: ResearchSeat.extend({ kind: z.literal("codeResearch") }),
  }),
});

/** A named contribution to the Feature scenario, before the lead plans the change. */
export type PstackExtension = z.input<typeof Extension>;

export type CodeResearchOptions = z.input<typeof ResearchSeat> & { readonly name?: string };

/** Describe a code research contribution. Niwa starts it when Feature runs. */
export function codeResearch({ name = "code-research", ...seat }: CodeResearchOptions): PstackExtension {
  return Extension.parse({ name, feature: { beforePlan: { ...seat, kind: "codeResearch" } } });
}

export function researchSettings(extensions: readonly PstackExtension[]) {
  const seen = new Set<string>();
  return extensions.map((extension) => {
    const { name, feature } = Extension.parse(extension);
    if (seen.has(name)) throw new Error(`pstack: duplicate extension name "${name}"`);
    seen.add(name);
    return { name, ...feature.beforePlan };
  });
}
