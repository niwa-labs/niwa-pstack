// The upstream sync: it takes the snapshot in a worktree of its own, then measures the map and has an author work on
// what the report shows, round after round, until the map is settled or the rounds are spent. What would change a
// workflow goes to the owner. The tool and git run on the host, through the plugin's actions, on a tiny package folder
// and a tiny upstream checkout; the author is a fake that edits files as a boxed author can.

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventually } from "@niwa-labs/testing";

import { GATED, SYNC, UNGATED, gatedOf, scriptOf } from "../src/catalog.ts";
import { builtins, commitFile, gitIn, pstackHost, registeredAll } from "./support.ts";
import type { HarnessCall, PstackHost } from "./support.ts";
import { commitFiles } from "./mapping-support.ts";
import { UPSTREAM_FILES_V1, seedPackage, upstreamCheckout } from "./package-layout.ts";

const hosts: PstackHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

const WORKER = "skills/poteto-mode/worker.md";
const BUG_FIX = "skills/poteto-mode/playbooks/bug-fix.md";
const MAPPING = "packages/pstack/upstream/mapping.json";

/** A host whose repository holds a package folder that maps an upstream checkout, and the checkout. */
async function synced(kinds: Parameters<typeof seedPackage>[3] = {}): Promise<{ made: PstackHost; up: { dir: string; commit: string } }> {
  const made = await pstackHost({ benny: false });
  hosts.push(made);
  const up = await upstreamCheckout();
  seedPackage(made.repo, up.dir, up.commit, kinds);
  await registeredAll(made.host, gatedOf(false).length + UNGATED.length);
  return { made, up };
}

/** Start the sync and wait for its end. */
async function sync(made: PstackHost, up: { dir: string }, args: Record<string, unknown> = {}): Promise<any> {
  // The sync is gated: until the suite promoted it, a built-in's candidate is started only by a run of pstack's own, so the
  // script is run on its file, as its own rights, here. The suite's scenario starts it as a candidate.
  const ended = (await made.host.call("workflow.start" as never, {
    file: scriptOf(SYNC),
    args: { repo: { local: made.repo }, worktrees: made.worktrees, base: "main", upstream: { checkout: up.dir }, ...args },
    wait: true,
    timeoutMs: 120_000,
  } as never)) as { outcome?: { status: string; result?: unknown }; reason?: string };
  if (ended.outcome?.status !== "done") throw new Error(`the sync did not finish: ${JSON.stringify(ended).slice(0, 2000)}`);
  return ended.outcome.result;
}

/** What the measurement left in the worktree for the author. */
const reportOf = (call: HarnessCall): any => JSON.parse(readFileSync(join(call.cwd as string, ".upstream-map-report.json"), "utf8"));

/** What a boxed author does: it edits files and answers; it cannot commit. The ids of the touched entries are settled as carried. */
const accepts = (call: HarnessCall) => ({ summary: "settled", decisions: [], accept: reportOf(call).entries.filter((one: { status: string }) => one.status === "touched").map((one: { id: string }) => one.id) });

/** Upstream rewords the worker rules: the entry that holds them is touched. */
const reword = (up: { dir: string }): string => commitFiles(up.dir, { [WORKER]: "Work for the operator, always.\n" }, "reword");

test("the author settles what the report shows, and the texts are assembled from the map once it is settled", async () => {
  const { made, up } = await synced();
  const next = reword(up);
  made.harnesses.answers["upstream-sync:round"] = accepts;
  const result = await sync(made, up);

  expect(result.status).toBe("synced");
  expect(result.upstream).toBe(next);
  expect(result.summary).toMatchObject({ problems: 0, textProblems: 0, touched: 0, coverage: 100 });
  expect(result.rounds).toHaveLength(1);
  expect(result.changed).toContain("packages/pstack/src/workflows/texts/worker.json");
  const subjects = gitIn(result.worktree, "log", "--format=%s", "main..HEAD").split("\n");
  expect(subjects).toEqual(["Assemble the playbook texts from the map", "Record the upstream ranges that did not change", `Take upstream pstack at ${next.slice(0, 9)}`]);
  expect(JSON.parse(readFileSync(join(result.worktree, "packages/pstack/src/workflows/texts/worker.json"), "utf8")).text).toBe("Work for the operator, always.\n");
  expect(gitIn(result.worktree, "ls-files", ".upstream-map-report.json")).toBe("");
  expect(gitIn(result.worktree, "rev-parse", "HEAD")).toBe(result.head);

  const asked = made.harnesses.of("upstream-sync:round");
  expect(asked).toHaveLength(1);
  expect(asked[0]?.harness).toBe("author");
  expect(asked[0]?.cwd).toBe(result.worktree);
  expect(asked[0]?.prompt).toContain(".upstream-map-report.json");
  expect(asked[0]?.prompt).toContain('"touched":1');
  expect(asked[0]?.prompt).toContain("`accept`");
  // The upstream checkout was only read.
  expect(gitIn(up.dir, "status", "--porcelain")).toBe("");
}, 120_000);

test("a map that is settled at the start needs no round, and its texts, which lag it, are assembled", async () => {
  const { made, up } = await synced();
  const result = await sync(made, up);
  expect(result.status).toBe("synced");
  expect(result.rounds).toEqual([]);
  expect(result.summary).toMatchObject({ touched: 0, textProblems: 0 });
  expect(made.harnesses.of("upstream-sync:round")).toEqual([]);
  expect(existsSync(join(result.worktree, "packages/pstack/src/workflows/texts/bug-fix.json"))).toBe(true);
}, 120_000);

test("a round that settles nothing while the map is unsettled stops the run as stalled, and the texts are not assembled", async () => {
  const { made, up } = await synced();
  reword(up);
  made.harnesses.answers["upstream-sync:round"] = () => ({ summary: "looked", decisions: [], accept: [] });
  const result = await sync(made, up);

  expect(result.status).toBe("stalled");
  expect(result.summary.touched).toBe(1);
  expect(result.rounds).toHaveLength(1);
  expect(result.changed).not.toContain("packages/pstack/src/workflows/texts/worker.json");
}, 120_000);

test("the rounds are bounded: what is left after them is reported, not worked on further", async () => {
  const { made, up } = await synced();
  reword(up);
  let tries = 0;
  made.harnesses.answers["upstream-sync:round"] = (call) => {
    tries += 1;
    writeFileSync(join(call.cwd as string, "packages/pstack", `notes-${String(tries)}.md`), "tried\n");
    return { summary: "tried", decisions: [], accept: [] };
  };
  const result = await sync(made, up, { rounds: 2 });

  expect(result.status).toBe("unfinished");
  expect(result.rounds).toHaveLength(2);
  expect(result.summary.touched).toBe(1);
  expect(made.harnesses.of("upstream-sync:round")).toHaveLength(2);
  // What the author edited is committed for it, as it cannot commit.
  expect(gitIn(result.worktree, "ls-files", "packages/pstack/notes-1.md")).toBe("packages/pstack/notes-1.md");
}, 120_000);

test("a coverage below the minimum is worked on like a touched entry", async () => {
  const { made, up } = await synced();
  commitFiles(up.dir, { [BUG_FIX]: `${UPSTREAM_FILES_V1[BUG_FIX]}\nA new paragraph that nothing maps yet.\n` }, "add a paragraph");
  made.harnesses.answers["upstream-sync:round"] = (call) => {
    const report = reportOf(call);
    const bug = report.coverage.files.find((one: { file: string }) => one.file === "poteto-mode/playbooks/bug-fix.md");
    const gap = bug.uncovered.at(-1) as { start: number; end: number };
    const path = join(call.cwd as string, MAPPING);
    const map = JSON.parse(readFileSync(path, "utf8")) as { entries: Array<Record<string, any>> };
    const own = map.entries.find((one) => one["id"] === "bug-fix:01") as Record<string, any>;
    map.entries.push({ id: "bug-fix:02", upstream: { ...own["upstream"], commit: report.upstream.commit, range: [gap.start, gap.end] }, ours: own["ours"], kind: "prompt" });
    writeFileSync(path, JSON.stringify(map));
    return { summary: "mapped the paragraph", decisions: [], accept: [] };
  };
  const result = await sync(made, up, { min: 100 });
  expect(result.status).toBe("synced");
  expect(result.summary.coverage).toBe(100);
  expect(made.harnesses.of("upstream-sync:round")[0]?.prompt).toContain("must reach 100%");
  expect(JSON.parse(readFileSync(join(result.worktree, "packages/pstack/src/workflows/texts/bug-fix.json"), "utf8")).text).toContain("A new paragraph");
}, 120_000);

test("what would change a workflow is asked of the owner once, and its answer is carried out in a last round", async () => {
  const { made, up } = await synced();
  reword(up);
  made.harnesses.answers["upstream-sync:round"] = (call) =>
    call.prompt.includes("The owner answered")
      ? (writeFileSync(join(call.cwd as string, "packages/pstack/owner.md"), "done\n"), { summary: "carried out", decisions: [], accept: [] })
      : { ...accepts(call), decisions: [{ question: "Deliver the autonomy rules to every session?", why: "It would change every prompt." }] };
  const running = sync(made, up);
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
  expect(gitIn(result.worktree, "ls-files", "packages/pstack/owner.md")).toBe("packages/pstack/owner.md");
}, 120_000);

test("a map the author left broken is not a failed run: it is measured as a problem, and the next round mends it", async () => {
  const { made, up } = await synced();
  const good = readFileSync(join(made.repo, MAPPING), "utf8");
  commitFile(made.repo, MAPPING, '{"entries": [{"id": "x"');
  made.harnesses.answers["upstream-sync:round"] = (call) => {
    writeFileSync(join(call.cwd as string, MAPPING), good);
    return { summary: "mended the map", decisions: [], accept: [] };
  };
  const result = await sync(made, up);

  expect(result.status).toBe("synced");
  expect(result.rounds).toHaveLength(1);
  expect(made.harnesses.of("upstream-sync:round")[0]?.prompt).toContain('"problems":1');
}, 120_000);

test("texts the assembled map still cannot make equal to it are not a finished sync, though the map is settled", async () => {
  // A block of a playbook that goes into a text and is left out as code is a text problem that assembling does not mend.
  const { made, up } = await synced();
  const map = JSON.parse(readFileSync(join(made.repo, MAPPING), "utf8")) as { entries: Array<Record<string, any>> };
  const whole = map.entries.find((one) => one["id"] === "bug-fix:01") as Record<string, any>;
  const [start, end] = whole["upstream"].range as [number, number];
  map.entries.splice(map.entries.indexOf(whole), 1, { ...whole, upstream: { ...whole["upstream"], range: [start, 10] } }, { ...whole, id: "bug-fix:02", kind: "code", upstream: { ...whole["upstream"], range: [10, end] } });
  commitFile(made.repo, MAPPING, JSON.stringify(map));
  const result = await sync(made, up);
  expect(result.status).toBe("unfinished");
  expect(result.rounds).toEqual([]);
  expect(result.summary).toMatchObject({ problems: 0, touched: 0 });
  expect(result.summary.textProblems).toBeGreaterThan(0);
}, 120_000);

test("the sync is gated like the playbooks: a new version of it is a candidate that starts on nothing", async () => {
  expect(GATED.map((one) => one.name)).toContain(SYNC);
  expect(UNGATED.map((one) => one.name)).not.toContain(SYNC);
  const { made } = await synced();
  const id = (await builtins(made.host))[SYNC]?.id;
  await expect(made.host.call("workflow.start" as never, { id, args: {} } as never)).rejects.toThrow("candidate");
}, 60_000);

test("the sync runs its tool and git on the host: no step of it is a command in a box", async () => {
  const source = readFileSync(scriptOf(SYNC), "utf8");
  const uses = /uses: \[([^\]]*)\]/.exec(source)?.[1] ?? "";
  expect(uses).toContain("pstack.upstream.measure");
  expect(uses).not.toContain("proc.run");
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  expect(code).not.toMatch(/proc\.run|gitOut|lib\/git/);
});

test("the upstream actions refuse a place that is not one of niwa's worktrees, and write the checkout never", async () => {
  const { made, up } = await synced();
  const inputs = { checkout: up.dir };
  for (const place of [made.repo, made.worktrees, "/nowhere", ""]) {
    await expect(made.asOwner("pstack.upstream.refresh", { place, ...inputs })).rejects.toThrow();
    await expect(made.asOwner("pstack.upstream.measure", { place, ...inputs })).rejects.toThrow();
    await expect(made.asOwner("pstack.upstream.commit", { place, message: "m", paths: ["packages"] })).rejects.toThrow();
    await expect(made.asOwner("pstack.upstream.state", { place })).rejects.toThrow();
  }
  const wt = (await made.asOwner("git.worktree.create", { repo: made.repo, base: "main", description: "a worktree" })) as { path: string };
  // A package folder or a path that leads out of the worktree is refused too.
  await expect(made.asOwner("pstack.upstream.measure", { place: wt.path, package: "../repo/packages/pstack", ...inputs })).rejects.toThrow();
  await expect(made.asOwner("pstack.upstream.commit", { place: wt.path, message: "m", paths: ["/etc/hosts"] })).rejects.toThrow();
  // On a worktree they work, and the checkout stays as it was.
  const before = gitIn(up.dir, "status", "--porcelain=v2", "--branch");
  const measured = (await made.asOwner("pstack.upstream.measure", { place: wt.path, ...inputs })) as { problems: number; coverage: number };
  expect(measured).toMatchObject({ problems: 0, coverage: 100 });
  expect(await made.asOwner("pstack.upstream.refresh", { place: wt.path, ...inputs })).toEqual({ commit: up.commit });
  expect(gitIn(up.dir, "status", "--porcelain=v2", "--branch")).toBe(before);
  expect(existsSync(join(up.dir, ".upstream-map-report.json"))).toBe(false);
}, 120_000);
