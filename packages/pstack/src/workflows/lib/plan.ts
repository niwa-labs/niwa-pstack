/**
 * The nodes of a plan as the playbooks that run one read them: each item, with the nodes it waits for, which the plan
 * keeps in the item's note (`after a, b; files x`).
 */

import type { PlanView } from "./go.ts";

/** A node to run: its id, its text, its state in the plan, and the nodes it waits for. */
export interface RunNode {
  id: string;
  text: string;
  state: string;
  after: string[];
}

/** The nodes of a plan that are still to be done, in the plan's order. */
export function openNodes(plan: PlanView): RunNode[] {
  return plan.items
    .filter((item) => item.state === "open" || item.state === "planned")
    .map((item) => {
      const after = /(?:^|;\s*)after ([^;]+)/.exec(item.note ?? "")?.[1];
      return { id: item.id, text: item.text, state: item.state, after: after === undefined ? [] : after.split(",").map((one) => one.trim()).filter(Boolean) };
    });
}
