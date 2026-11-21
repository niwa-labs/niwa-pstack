// Fake providers of Benny's three ports, in memory: they offer each port the way an owner's plugin would, implement
// every action of its contract, and write down what they were asked, so the tests can say what Benny did.

import { action } from "@niwa-labs/core";
import type { ActionRef } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";

import {
  BENNY_CHANNEL,
  BENNY_CONTROL,
  BENNY_TRACKER,
  bennyChannelNotify,
  bennyChannelReply,
  bennyControlBringUp,
  bennyControlCapabilities,
  bennyControlCleanup,
  bennyControlDrive,
  bennyControlInspect,
  bennyControlRecord,
  bennyControlScreenshot,
  bennyTrackerComment,
  bennyTrackerCreate,
  bennyTrackerFind,
  bennyTrackerLinkPr,
} from "../src/ports.ts";

/** One call a provider answered. */
export interface PortCall {
  action: string;
  input: unknown;
}

/** The fake providers, and what they were asked. */
export interface FakePorts {
  plugins: Plugin[];
  calls: PortCall[];
  /** The issues of the fake tracker, by id. */
  issues: Map<string, { id: string; url: string; title: string; state: "open" | "closed"; sources: string[]; prs: string[]; notes: string[] }>;
  /** The calls of an action, by its name. */
  of(name: string): PortCall[];
}

/** Providers that offer the three ports; `omit` leaves one out, as a host that lacks it would. */
export function fakePorts(omit: ReadonlyArray<"tracker" | "channel" | "control"> = []): FakePorts {
  const calls: PortCall[] = [];
  const issues: FakePorts["issues"] = new Map();
  const record = <I>(name: string, input: I): I => {
    calls.push({ action: name, input });
    return input;
  };
  const made: Plugin[] = [];
  if (!omit.includes("tracker")) {
    made.push(
      plugin("fake-tracker", (api) => {
        api.offer(BENNY_TRACKER, { description: "an in-memory issue tracker" });
        api.action(
          action(bennyTrackerFind, {
            recovery: "repeat",
            effect: "read",
            world: "niwa",
            run: (input) => {
              record("benny.tracker.find", input);
              const found = [...issues.values()].filter((one) => (input.state === "any" || one.state === input.state) && (one.title.includes(input.text) || (input.source !== undefined && one.sources.includes(input.source))));
              return { items: found.map(({ id, url, title, state, sources }) => ({ id, url, title, state, sources })) };
            },
          }),
        );
        api.action(
          action(bennyTrackerCreate, {
            recovery: "do-not-repeat",
            effect: "write",
            world: "niwa",
            run: (input) => {
              record("benny.tracker.create", input);
              const id = `ISSUE-${String(issues.size + 1)}`;
              issues.set(id, { id, url: `https://tracker.example/issue/${id}`, title: input.title, state: "open", sources: [input.source], prs: [], notes: [] });
              return { id, url: `https://tracker.example/issue/${id}` };
            },
          }),
        );
        api.action(
          action(bennyTrackerComment, {
            recovery: "do-not-repeat",
            effect: "write",
            world: "niwa",
            run: (input) => {
              record("benny.tracker.comment", input);
              const issue = issues.get(input.id);
              if (issue === undefined) throw new Error(`no issue ${input.id}`);
              issue.notes.push(input.note);
              if (input.source !== undefined) issue.sources.push(input.source);
              return { ok: true as const };
            },
          }),
        );
        api.action(
          action(bennyTrackerLinkPr, {
            recovery: "do-not-repeat",
            effect: "write",
            world: "niwa",
            run: (input) => {
              record("benny.tracker.link-pr", input);
              const issue = issues.get(input.id);
              if (issue === undefined) throw new Error(`no issue ${input.id}`);
              issue.prs.push(input.pr);
              return { ok: true as const };
            },
          }),
        );
      }),
    );
  }
  if (!omit.includes("channel")) {
    made.push(
      plugin("fake-channel", (api) => {
        api.offer(BENNY_CHANNEL, { description: "an in-memory report channel" });
        let posted = 0;
        api.action(
          action(bennyChannelReply, {
            recovery: "do-not-repeat",
            effect: "write",
            world: "niwa",
            run: (input) => {
              record("benny.channel.reply", input);
              posted += 1;
              return { id: `msg-${String(posted)}` };
            },
          }),
        );
        api.action(
          action(bennyChannelNotify, {
            recovery: "do-not-repeat",
            effect: "write",
            world: "niwa",
            run: (input) => {
              record("benny.channel.notify", input);
              posted += 1;
              return { id: `msg-${String(posted)}` };
            },
          }),
        );
      }),
    );
  }
  if (!omit.includes("control")) {
    made.push(
      plugin("fake-control", (api) => {
        api.offer(BENNY_CONTROL, { description: "an in-memory product control" });
        const stage = <I, O, In>(ref: ActionRef<I, O, In>, effect: "read" | "write", run: (input: I) => O) =>
          api.action(
            action(ref, {
              recovery: effect === "read" ? "repeat" : "do-not-repeat",
              effect,
              world: "local",
              run: (input) => {
                record(ref.name, input);
                return run(input);
              },
            }),
          );
        stage(bennyControlCapabilities, "read", () => ({ features: ["readme"], missing: [] }));
        stage(bennyControlBringUp, "write", () => ({ session: "app-1", markers: ["app:fixture"], confirmed: "the window title names the fixture" }));
        stage(bennyControlDrive, "write", () => ({ observed: "the page shows payroll" }));
        stage(bennyControlInspect, "read", () => ({ state: "heading: payroll" }));
        stage(bennyControlScreenshot, "write", (input) => ({ path: input.path, marker: "app:fixture" }));
        stage(bennyControlRecord, "write", (input) => ({ path: input.path }));
        stage(bennyControlCleanup, "write", () => ({ stopped: ["app-1"], retained: [] }));
      }),
    );
  }
  return { plugins: made, calls, issues, of: (name) => calls.filter((one) => one.action === name) };
}
