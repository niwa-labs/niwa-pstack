/**
 * The ports of Benny: what he needs of the host besides pstack itself, as typed contracts that plugins of the owner
 * implement. pstack ships no implementation. A provider plugin offers its port at one of the offer keys below and
 * registers the actions of the port under the names here; pstack reads the offers when it is installed, so a host
 * that lacks a port refuses to enable Benny and names it. A provider is installed before pstack.
 *
 * Three ports: the issue tracker his triage dedupes against and files into, the channel reports come in on and his
 * verdict goes back to, and the control of the product his reproduction drives.
 */

import { actionRef } from "@niwa-labs/core";
import { offerKey } from "@niwa-labs/plugin";
import type { OfferKey } from "@niwa-labs/plugin";
import { z } from "zod";

/** What a provider says of itself when it offers a port. */
export interface PortOffer {
  readonly description: string;
}

/** Where a plugin offers the issue tracker port. */
export const BENNY_TRACKER: OfferKey<PortOffer> = offerKey("pstack.benny.tracker", "pstack");
/** Where a plugin offers the report channel port. */
export const BENNY_CHANNEL: OfferKey<PortOffer> = offerKey("pstack.benny.channel", "pstack");
/** Where a plugin offers the product control port. */
export const BENNY_CONTROL: OfferKey<PortOffer> = offerKey("pstack.benny.control", "pstack");

/** The ports, each with what a host that lacks it is told. */
export const BENNY_PORTS = [
  { key: BENNY_TRACKER, name: "issue tracker", actions: "benny.tracker.*" },
  { key: BENNY_CHANNEL, name: "report channel", actions: "benny.channel.*" },
  { key: BENNY_CONTROL, name: "product control", actions: "benny.control.*" },
] as const;

const text = z.string().min(1);

// ---- The issue tracker ----

/** An issue of the tracker, as a search shows it. */
export const TrackerIssue = z.strictObject({
  id: text,
  url: text,
  title: text,
  state: z.enum(["open", "closed"]),
  /** The sources (report addresses or links) already linked to the issue. */
  sources: z.array(z.string()),
});
export type TrackerIssue = z.infer<typeof TrackerIssue>;

export const bennyTrackerFind = actionRef("benny.tracker.find", {
  description:
    "Search the issue tracker for issues like a report: by text (an error signature, an area, a symptom), by state, and by a source (the report's own address or link, to learn whether it is already linked to an issue). " +
    "Read-only. Answers the issues found, each with its state and the sources linked to it; none is an empty list.",
  input: z.strictObject({ text: text, state: z.enum(["open", "closed", "any"]).default("any"), source: text.optional() }),
  output: z.strictObject({ items: z.array(TrackerIssue) }),
});

export const bennyTrackerCreate = actionRef("benny.tracker.create", {
  description:
    "Create an issue for a report: a title, a self-contained body, the source it came from (it must link back to the report), and labels. " +
    "The provider resolves its own team, project and status; it invents none the owner did not configure. Answers the new issue's id and url.",
  input: z.strictObject({ title: text, body: text, source: text, labels: z.array(text).optional() }),
  output: z.strictObject({ id: text, url: text }),
});

export const bennyTrackerComment = actionRef("benny.tracker.comment", {
  description:
    "Add a note to an existing issue, with the source of a report that recurs: a short recurrence note and a link back. " +
    "It changes nothing else of the issue: no reopening, relabelling or reassigning.",
  input: z.strictObject({ id: text, note: text, source: text.optional() }),
  output: z.strictObject({ ok: z.literal(true) }),
});

export const bennyTrackerLinkPr = actionRef("benny.tracker.link-pr", {
  description:
    "Link a pull request to an issue, in the way the tracker supports (its pull request syntax or a link). `pr` is the pull request's subject as pstack names it (`host/path/pr/7`) or its url. " +
    "It does not close the issue.",
  input: z.strictObject({ id: text, pr: text }),
  output: z.strictObject({ ok: z.literal(true) }),
});

// ---- The report channel ----

export const bennyChannelReply = actionRef("benny.channel.reply", {
  description:
    "Post one reply in the thread of a report, on the channel it came in on. `source` is the channel's own address of the report, the one it handed to `benny.report`; " +
    "the reply goes there and nowhere else: never a new root message, another channel or a direct message. Answers the id of the message posted.",
  input: z.strictObject({ source: text, text: text }),
  output: z.strictObject({ id: text }),
});

export const bennyChannelNotify = actionRef("benny.channel.notify", {
  description:
    "Tell the owner something about Benny's work: a status, or the end of a reproduction, in the place the owner follows it (an operations thread, a chat). " +
    "With `source`, it relates to that report. Answers the id of the message posted.",
  input: z.strictObject({ text: text, source: text.optional() }),
  output: z.strictObject({ id: text }),
});

// ---- The product control ----

export const bennyControlCapabilities = actionRef("benny.control.capabilities", {
  description:
    "Say what the control can drive before a reproduction starts: the features (the sections of the feature map) it can drive, and the capabilities it lacks " +
    "among: bring up, drive, inspect, screenshot, record, cleanup. With `feature`, only that feature. Read-only.",
  input: z.strictObject({ feature: text.optional() }),
  output: z.strictObject({ features: z.array(z.string()), missing: z.array(z.string()) }),
});

export const bennyControlBringUp = actionRef("benny.control.bring-up", {
  description:
    "Start the product at a revision, built from `worktree`, in its test environment, with the feature's state it needs, and keep its captures in `artifacts`. " +
    "The control must tell the product apart from a similar window, a shell or a production instance: it answers how it confirmed the right one (`confirmed`) and the stable markers a later call can use. " +
    "Answers the session the other actions take.",
  input: z.strictObject({ revision: text, worktree: text, feature: text.optional(), artifacts: text }),
  output: z.strictObject({ session: text, markers: z.array(z.string()), confirmed: text }),
});

export const bennyControlDrive = actionRef("benny.control.drive", {
  description:
    "Do one real user action in the running product: a click, typing, a key, a scroll, a drag, a resize, a navigation, given in words as `step`; with `feature` and `state`, to reach a mapped state through safe fixtures. " +
    "It never sets internal state, calls hidden methods, writes storage or injects into the page to make a symptom: the symptom must come from the interaction. Answers what was observed to change.",
  input: z.strictObject({ session: text, step: text, feature: text.optional(), state: text.optional() }),
  output: z.strictObject({ observed: text }),
});

export const bennyControlInspect = actionRef("benny.control.inspect", {
  description:
    "Read the state of the running product to confirm what its interface shows: the accessibility tree, a view hierarchy, process state, logs, request status, exposed debug state. " +
    "Read-only: a query that would change state is a `benny.control.drive` and must be a real user action.",
  input: z.strictObject({ session: text, query: text }),
  output: z.strictObject({ state: text }),
});

export const bennyControlScreenshot = actionRef("benny.control.screenshot", {
  description:
    "Capture the product's window to `path`, with enough of its chrome to prove the right product is under test. Answers the file and the marker that identifies the product in the capture.",
  input: z.strictObject({ session: text, path: text }),
  output: z.strictObject({ path: text, marker: text }),
});

export const bennyControlRecord = actionRef("benny.control.record", {
  description:
    "Start or stop a screen recording of the product to `path`, around the whole path to the symptom. Answers the file, and when the recording started and stopped.",
  input: z.strictObject({ session: text, op: z.enum(["start", "stop"]), path: text }),
  output: z.strictObject({ path: text, startedAt: z.string().optional(), stoppedAt: z.string().optional() }),
});

export const bennyControlCleanup = actionRef("benny.control.cleanup", {
  description:
    "Stop what the control started for the session (the product, profiles, temporary workspaces, debug ports) and remove the disposable data. It never deletes the user's work. Answers what it stopped and what it kept.",
  input: z.strictObject({ session: text }),
  output: z.strictObject({ stopped: z.array(z.string()), retained: z.array(z.string()) }),
});

/** The actions of each port, as a script lists them in its `uses` and a session is shown them. */
export const TRACKER_ACTIONS = ["benny.tracker.find", "benny.tracker.create", "benny.tracker.comment", "benny.tracker.link-pr"] as const;
export const CHANNEL_ACTIONS = ["benny.channel.reply", "benny.channel.notify"] as const;
export const CONTROL_ACTIONS = [
  "benny.control.capabilities",
  "benny.control.bring-up",
  "benny.control.drive",
  "benny.control.inspect",
  "benny.control.screenshot",
  "benny.control.record",
  "benny.control.cleanup",
] as const;
