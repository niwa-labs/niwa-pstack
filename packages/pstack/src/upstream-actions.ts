/**
 * The upstream sync's own steps, done by the plugin in a worktree of niwa. A real `proc.run` box reads only its own
 * directory, so it can read neither an upstream checkout nor the repository a worktree belongs to, and git does not
 * run in a worktree there; the tool and git therefore run here, on the host. Each step is held to a worktree of niwa
 * (checked before anything is read or written), reads the upstream checkout through git only, and writes inside the
 * worktree and nowhere else.
 */

import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { action } from "@niwa-labs/core";
import type { Action } from "@niwa-labs/core";
import { Git, openMap, recordMap, summaryOf, unreadable, writeAssembled } from "@niwa-labs/upstream-map";
import type { ToolContext } from "@niwa-labs/upstream-map";

import { worktreePlace, worktreesOf } from "./author.ts";
import { refreshUpstream, upstreamMapConfig } from "./upstream.ts";
import {
  pstackUpstreamAssemble,
  pstackUpstreamCommit,
  pstackUpstreamMeasure,
  pstackUpstreamRecord,
  pstackUpstreamRefresh,
  pstackUpstreamState,
} from "./upstream-records.ts";
import type { UpstreamSummary } from "./upstream-records.ts";

/** Where the full report of a measurement is written, in the worktree. */
export const REPORT_FILE = ".upstream-map-report.json";

/** A path that stays inside `place`: the real path of the worktree, and the path resolved from it. */
function inside(place: string, path: string, what: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.startsWith("-")) throw new Error(`${what} ${JSON.stringify(path)} must be a path inside the worktree`);
  const found = resolve(place, path);
  const back = relative(place, found);
  if (back === "" || back.startsWith("..") || isAbsolute(back)) throw new Error(`${what} ${JSON.stringify(path)} must be a path inside the worktree`);
  // A link inside the worktree must not lead out of it.
  if (existsSync(found) && !realpathSync(found).startsWith(place + sep)) throw new Error(`${what} ${JSON.stringify(path)} leads out of the worktree`);
  return found;
}

/** An upstream checkout: an existing folder. */
function checkoutOf(checkout: string): string {
  if (!isAbsolute(checkout) || !existsSync(checkout) || !statSync(checkout).isDirectory()) throw new Error(`the upstream checkout ${JSON.stringify(checkout)} is not a folder`);
  return realpathSync(checkout);
}

/** What the tool is given for a step: the package folder of the worktree, the worktree as the repository's root, the checkout. */
function contextOf(home: string, input: { place: string; package: string; checkout: string }): { place: string; ctx: ToolContext } {
  const place = worktreePlace("the upstream sync", input.place, worktreesOf(home));
  return { place, ctx: { ...upstreamMapConfig(inside(place, input.package, "the package folder")), root: place, checkout: checkoutOf(input.checkout) } };
}

/** The upstream sync's actions, for a host whose niwa home is `home()`. */
export function upstreamActions(home: () => string): Action<any, any>[] {
  return [
    action(pstackUpstreamRefresh, {
      recovery: "repeat",
      effect: "write",
      world: "local",
      run: (input) => {
        const { ctx } = contextOf(home(), input);
        const source = refreshUpstream(ctx.checkout as string, { upstream: ctx.paths.upstream, ...(input.commit === undefined ? {} : { commit: input.commit }) });
        return { commit: source.commit };
      },
    }),
    action(pstackUpstreamMeasure, {
      recovery: "repeat",
      effect: "write",
      world: "local",
      run: (input): UpstreamSummary => {
        const { place, ctx } = contextOf(home(), input);
        const report = join(place, REPORT_FILE);
        try {
          const opened = openMap(ctx);
          writeFileSync(report, `${JSON.stringify(opened.report, null, 2)}\n`);
          return summaryOf(opened.report);
        } catch (error) {
          // A map that cannot be read at all is a problem of the map, said as one: the author mends it.
          const said = unreadable(error);
          writeFileSync(report, `${JSON.stringify({ error: said.error }, null, 2)}\n`);
          return said;
        }
      },
    }),
    action(pstackUpstreamRecord, {
      recovery: "repeat",
      effect: "write",
      world: "local",
      run: (input) => {
        const { ctx } = contextOf(home(), input);
        try {
          const advanced = recordMap(ctx, "unchanged");
          return { recorded: advanced + (input.accept.length > 0 ? recordMap(ctx, input.accept) : 0) };
        } catch (error) {
          return { recorded: 0, refused: (error as Error).message.slice(0, 500) };
        }
      },
    }),
    action(pstackUpstreamAssemble, {
      recovery: "repeat",
      effect: "write",
      world: "local",
      run: (input) => ({ texts: writeAssembled(contextOf(home(), input).ctx) }),
    }),
    action(pstackUpstreamCommit, {
      recovery: "repeat",
      effect: "write",
      world: "local",
      run: (input) => {
        const place = worktreePlace("the upstream sync", input.place, worktreesOf(home()));
        const git = new Git(place);
        const paths = input.paths.map((one) => relative(place, inside(place, one, "the path")));
        git.out(["add", "--", ...paths]);
        const staged = git.out(["diff", "--cached", "--name-only"]).trim();
        if (staged !== "") git.out(["commit", "-q", "-m", input.message]);
        return { head: git.out(["rev-parse", "HEAD"]).trim(), committed: staged !== "" };
      },
    }),
    action(pstackUpstreamState, {
      recovery: "repeat",
      effect: "read",
      world: "local",
      run: (input) => {
        const place = worktreePlace("the upstream sync", input.place, worktreesOf(home()));
        const git = new Git(place);
        const head = git.out(["rev-parse", "HEAD"]).trim();
        const paths = input.paths.map((one) => relative(place, inside(place, one, "the path")));
        const changed = input.base === undefined ? [] : git.out(["diff", "--name-only", `${input.base}...${head}`, ...(paths.length > 0 ? ["--", ...paths] : [])]).split("\n").filter((line) => line !== "");
        return { head, changed };
      },
    }),
  ];
}
