/**
 * The texts the scripts give their sessions: a playbook as upstream wrote it, with the worker rules that every
 * session started for the operator works under.
 */

import worker from "../texts/worker.json";

/** A playbook text, as the snapshot gives it. */
export interface PlaybookText {
  name: string;
  title: string;
  text: string;
}

/** The brief of a session: its step, the worker rules, the playbook it works in, and the task. */
export function brief(tag: string, playbook: PlaybookText, task: string, extra: readonly string[] = []): string {
  return [tag, "", "Perform only the assigned step. The playbook describes the full workflow. Other seats and the workflow own its other steps. Use only tools available to your seat.", "", ...extra, "", worker.text.trim(), "", `You work in the ${playbook.title} playbook:`, "", playbook.text.trim(), "", `Task: ${task}`].join("\n");
}
