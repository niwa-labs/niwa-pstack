// The upstream sync: it takes the snapshot in a worktree of its own, then measures the map and has an author work on
// what the report shows, round after round, until the map is settled or the rounds are spent. What would change a
// workflow goes to the owner. The map tool is a stand-in that reads its numbers from a file, so the loop is tried
// by itself; the tool itself is tried in mapping.test.ts.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventually } from "@niwa-labs/testing";

import { UNGATED, gatedOf } from "../src/catalog.ts";
import { builtins, commitFile, gitIn, pstackHost, registeredAll } from "./support.ts";
import type { HarnessCall, PstackHost } from "./support.ts";

const hosts: PstackHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

/** What the stand-in tool does: its commands read and write the files of the worktree they run in. */
const TOOL = `#!/bin/sh
dir=packages/pstack/upstream
cmd=$1
shift
case "$cmd" in
  refresh) echo "taken $1" > $dir/taken; echo "snapshot taken at 1111111111111111111111111111111111111111" ;;
  check)
    echo '{}' > .upstream-map-report.json
    touched=$(cat $dir/touched)
    printf '{"problems":0,"coverage":%s,"entries":10,"unchanged":%s,"touched":%s,"gone":0,"uncovered":0}\\n' "$(cat $dir/coverage)" "$((10 - touched))" "$touched" ;;
  advance) echo advance >> $dir/log ;;
  assemble) mkdir -p packages/pstack/src/workflows/texts; echo '{"name":"bug-fix"}' > packages/pstack/src/workflows/texts/bug-fix.json ;;
  *) echo "unknown command $cmd"; exit 2 ;;
esac
`;

/** A host whose repository holds the stand-in tool, and the files of a snapshot with two entries touched. */
async function synced(touched = 2, coverage = 96): Promise<PstackHost> {
  const made = await pstackHost({ benny: false });
  hosts.push(made);
  mkdirSync(join(made.repo, "packages", "pstack", "upstream"), { recursive: true });
  mkdirSync(join(made.repo, "packages", "pstack", "src", "workflows", "texts"), { recursive: true });
  writeFileSync(join(made.repo, "packages", "pstack", "upstream", "touched"), `${String(touched)}\n`);
  writeFileSync(join(made.repo, "packages", "pstack", "upstream", "coverage"), `${String(coverage)}\n`);
  writeFileSync(join(made.repo, "packages", "pstack", "upstream", "log"), "start\n");
  writeFileSync(join(made.repo, "packages", "pstack", "src", "workflows", "texts", "keep.json"), "{}\n");
  commitFile(made.repo, "tool.sh", TOOL);
  gitIn(made.repo, "add", "-A");
  gitIn(made.repo, "commit", "-q", "-m", "files of a snapshot");
  await registeredAll(made.host, gatedOf(false).length + UNGATED.length);
  return made;
}

/** Start the sync and wait for its end. */
async function sync(made: PstackHost, args: Record<string, unknown> = {}): Promise<any> {
  const id = (await builtins(made.host))["upstream-sync"]?.id;
  const ended = (await made.host.call("workflow.start" as never, {
    id,
    args: { repo: { local: made.repo }, worktrees: made.worktrees, base: "main", upstream: { checkout: "/nowhere/upstream" }, tool: ["sh", "tool.sh"], ...args },
    wait: true,
    timeoutMs: 120_000,
  } as never)) as { outcome?: { status: string; result?: unknown }; reason?: string };
  if (ended.outcome?.status !== "done") throw new Error(`the sync did not finish: ${JSON.stringify(ended).slice(0, 2000)}`);
  return ended.outcome.result;
}

/** What the author does in a round: settle the touched entries and commit. */
const settles = (call: HarnessCall): string => {
  const cwd = call.cwd as string;
  writeFileSync(join(cwd, "packages", "pstack", "upstream", "touched"), "0\n");
  return commitFile(cwd, "packages/pstack/upstream/touched", "0\n");
};

const said = (sha: string, decisions: Array<{ question: string; why: string }> = []) => ({ summary: "settled", decisions, sha });

test("the author settles what the report shows, and the texts are assembled from the map once it is settled", async () => {
  const made = await synced();
  made.harnesses.answers["upstream-sync:round"] = (call) => said(settles(call));
  const result = await sync(made);

  expect(result.status).toBe("synced");
  expect(result.upstream).toBe("1111111111111111111111111111111111111111");
  expect(result.summary).toMatchObject({ touched: 0, coverage: 96 });
  expect(result.rounds).toHaveLength(1);
  expect(result.changed).toContain("packages/pstack/src/workflows/texts/bug-fix.json");
  const subjects = gitIn(result.worktree, "log", "--format=%s", "main..HEAD").split("\n");
  expect(subjects).toEqual(["Assemble the playbook texts from the map", "Record the upstream ranges that did not change", "change packages/pstack/upstream/touched", "Take upstream pstack at 111111111"]);
  expect(gitIn(result.worktree, "ls-files", ".upstream-map-report.json")).toBe("");
  expect(gitIn(result.worktree, "rev-parse", "HEAD")).toBe(result.head);

  const asked = made.harnesses.of("upstream-sync:round");
  expect(asked).toHaveLength(1);
  expect(asked[0]?.harness).toBe("author");
  expect(asked[0]?.cwd).toBe(result.worktree);
  expect(asked[0]?.prompt).toContain(".upstream-map-report.json");
  expect(asked[0]?.prompt).toContain('"touched":2');
  expect(asked[0]?.prompt).toContain("sh tool.sh accept <id>");
}, 120_000);

test("a map that is settled at the start needs no round", async () => {
  const made = await synced(0, 97);
  const result = await sync(made);
  expect(result.status).toBe("synced");
  expect(result.rounds).toEqual([]);
  expect(made.harnesses.of("upstream-sync:round")).toEqual([]);
}, 120_000);

test("a round that changes nothing while the map is unsettled stops the run as stalled, and the texts are not assembled", async () => {
  const made = await synced();
  made.harnesses.answers["upstream-sync:round"] = (call) => said(gitIn(call.cwd as string, "rev-parse", "HEAD"));
  const result = await sync(made);

  expect(result.status).toBe("stalled");
  expect(result.summary.touched).toBe(2);
  expect(result.rounds).toHaveLength(1);
  expect(result.changed).not.toContain("packages/pstack/src/workflows/texts/bug-fix.json");
}, 120_000);

test("the rounds are bounded: what is left after them is reported, not worked on further", async () => {
  const made = await synced();
  let tries = 0;
  made.harnesses.answers["upstream-sync:round"] = (call) => {
    tries += 1;
    return said(commitFile(call.cwd as string, `notes-${String(tries)}.md`, "tried\n"));
  };
  const result = await sync(made, { rounds: 2 });

  expect(result.status).toBe("unfinished");
  expect(result.rounds).toHaveLength(2);
  expect(result.summary.touched).toBe(2);
  expect(made.harnesses.of("upstream-sync:round")).toHaveLength(2);
}, 120_000);

test("a coverage below the minimum is worked on like a touched entry", async () => {
  const made = await synced(0, 80);
  made.harnesses.answers["upstream-sync:round"] = (call) => {
    const cwd = call.cwd as string;
    return said(commitFile(cwd, "packages/pstack/upstream/coverage", "96\n"));
  };
  const result = await sync(made);
  expect(result.status).toBe("synced");
  expect(result.summary.coverage).toBe(96);
  expect(made.harnesses.of("upstream-sync:round")[0]?.prompt).toContain("must reach 95%");
}, 120_000);

test("what would change a workflow is asked of the owner once, and its answer is carried out in a last round", async () => {
  const made = await synced();
  made.harnesses.answers["upstream-sync:round"] = (call) =>
    call.prompt.includes("The owner answered")
      ? said(commitFile(call.cwd as string, "owner.md", "done\n"))
      : said(settles(call), [{ question: "Deliver the autonomy rules to every session?", why: "It would change every prompt." }]);
  const running = sync(made);
  let id: string | undefined;
  await eventually(
    async () => {
      const open = (await made.asOwner("request.open", {})) as { items?: Array<{ id: string }>; requests?: Array<{ id: string }> };
      id = (open.items ?? open.requests ?? [])[0]?.id;
      return id !== undefined;
    },
    30_000,
    "the owner was not asked",
  );
  await made.asOwner("request.answer", { id, answer: { text: "Yes, deliver them." } });
  const result = await running;

  expect(result.status).toBe("synced");
  expect(result.decisions).toEqual([{ question: "Deliver the autonomy rules to every session?", why: "It would change every prompt.", answer: "Yes, deliver them." }]);
  const rounds = made.harnesses.of("upstream-sync:round");
  expect(rounds).toHaveLength(2);
  expect(rounds[1]?.prompt).toContain("- Deliver the autonomy rules to every session?: Yes, deliver them.");
  expect(gitIn(result.worktree, "ls-files", "owner.md")).toBe("owner.md");
}, 120_000);
