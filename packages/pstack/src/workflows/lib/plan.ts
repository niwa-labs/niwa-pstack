/**
 * The nodes of a plan as the playbooks that run one read them: each item, with the nodes it waits for, which the plan
 * keeps in the item's note (`after a, b; files x`).
 */

import type { PlanView } from "./go.ts";

export const INTERACTION_REVIEW = "- [ ] Operator review before merge: ";

/** A node to run: its id, its text, its state in the plan, and the nodes it waits for. */
export interface RunNode {
  id: string;
  text: string;
  state: string;
  after: string[];
}

/** The nodes of a plan that are still to be done, in the plan's order. */
export function openNodes(plan: PlanView): RunNode[] {
  const seen = new Set<string>();
  return plan.items
    .map((item) => {
      const after = /(?:^|;\s*)after ([^;]+)/.exec(item.note ?? "")?.[1];
      const dependencies = after === undefined ? [] : after.split(",").map((one) => one.trim()).filter(Boolean);
      if (seen.has(item.id) || dependencies.some((id) => !seen.has(id))) throw new Error("Invalid landing order or duplicate plan node: " + item.id);
      seen.add(item.id);
      return { id: item.id, text: item.text, state: item.state, after: dependencies };
    })
    .filter((item) => item.state === "open" || item.state === "planned");
}
