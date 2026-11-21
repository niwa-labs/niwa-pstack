// Upstream sync: take a new snapshot of upstream's pstack and carry pstack's map of it to the new text. The snapshot
// is refreshed in a worktree of its own; then, round after round, a deterministic tool measures the map (what the
// map covers, and what became of each entry's ranges on both sides) and an author boxed to the worktree works on what
// the report shows: it maps uncovered text, follows touched and gone entries into our code and texts, and drops what
// it does not take, with the reason. The tool measures and concludes nothing; every conclusion is the author's. The
// loop ends when the coverage reaches its minimum and no entry is touched or gone, or after a bounded number of
// rounds. What would change what a workflow does is the owner's to decide, and goes to the owner as a question. The
// run ends on a branch of commits: the workflows it changed come in as candidates, and the suite tries them.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { gitOut, linesOf } from "./lib/git.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import type { SessionAddress } from "./lib/script.ts";
import { askSession } from "./lib/sessions.ts";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

/** The numbers the tool prints for a script, as `check --summary` gives them. */
interface Summary {
  problems: number;
  coverage: number;
  entries: number;
  unchanged: number;
  touched: number;
  gone: number;
  uncovered: number;
}

/** What a command answered: its exit and the end of its output. */
interface Ran {
  exit: number | null;
  out: string;
}

/** Run a command in the worktree. */
async function run(key: string, cwd: string, cmd: readonly string[]): Promise<Ran> {
  const ran = (await api().call("proc.run", { cmd, cwd, timeout: 600_000 }, { label: key })) as { exit: number | null; tail: string };
  return { exit: ran.exit, out: ran.tail };
}

/** The tool's summary: the last line of its output that is a JSON object. */
function summaryOf(ran: Ran): Summary {
  const line = linesOf(ran.out).filter((one) => one.startsWith("{")).at(-1);
  if (line === undefined) throw new Error(`the map tool printed no summary (exit ${String(ran.exit)}): ${ran.out.trim().slice(-500)}`);
  const found = JSON.parse(line) as Summary;
  return { problems: found.problems, coverage: found.coverage, entries: found.entries, unchanged: found.unchanged, touched: found.touched, gone: found.gone, uncovered: found.uncovered };
}

/** Whether the map is where the sync wants it: sound, covering enough, and nothing touched or gone. */
const settled = (summary: Summary, min: number): boolean => summary.problems === 0 && summary.coverage >= min && summary.touched === 0 && summary.gone === 0;

const answered = z.strictObject({
  summary: z.string().min(1).max(4000).describe("What was changed, linked and dropped this round, and why"),
  decisions: z.array(z.strictObject({ question: z.string().min(1).max(1000), why: z.string().min(1).max(2000) })).max(20).describe("What would change what a prompt or a workflow does: left alone, for the owner"),
  sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).describe("The commit made this round; the head when nothing was changed"),
});

export default workflow(
  {
    name: "pstack-upstream-sync",
    description: "Carry the upstream map to a new snapshot of upstream",
    input: z.strictObject({
      repo: z.strictObject({ local: z.string().min(1).describe("The real path of the local clone of the pstack repository") }),
      worktrees: z.string().min(1).describe("The real path of the folder niwa keeps its worktrees in, <home>/worktrees"),
      base: z.string().min(1).default("main"),
      upstream: z.strictObject({
        checkout: z.string().min(1).describe("The real path of a checkout of upstream's pstack folder; it is read, never written"),
        commit: z.string().min(1).optional().describe("The commit of it to take; its HEAD by default"),
      }),
      tool: z.array(z.string().min(1)).min(1).default(["bun", "packages/pstack/scripts/upstream-map.ts"]).describe("The command of the map tool, run in the worktree"),
      min: z.number().min(0).max(100).default(95).describe("The share of upstream's characters the map must cover, in percent"),
      rounds: z.number().int().min(1).max(10).default(4).describe("How many rounds the author gets before the run reports what is left"),
    }),
    output: z.strictObject({
      status: z.enum(["synced", "unfinished", "stalled"]),
      upstream: z.string(),
      worktree: z.string(),
      branch: z.string(),
      head: z.string(),
      summary: z.strictObject({ problems: z.number(), coverage: z.number(), entries: z.number(), unchanged: z.number(), touched: z.number(), gone: z.number(), uncovered: z.number() }),
      rounds: z.array(z.strictObject({ round: z.number(), before: z.string(), summary: z.string() })),
      decisions: z.array(z.strictObject({ question: z.string(), why: z.string(), answer: z.string() })),
      changed: z.array(z.string()),
    }),
    uses: ["pstack.roles", "pstack.author.start", "session.ask", "git.worktree.create", "proc.run@{worktrees}/*", "request.ask"],
    phases: [
      { title: "Refresh", detail: "The snapshot is taken from the checkout, in a worktree" },
      { title: "Carry", detail: "The tool measures, the author works on what it shows, until the map is settled" },
      { title: "Decide", detail: "What would change a workflow goes to the owner" },
      { title: "Record", detail: "The texts are assembled from the map and committed" },
    ],
  },
  async ({ repo, base, upstream, tool, min, rounds }) => {
    const seats = await roles();
    const wt = await makeWorktree({ repo: repo.local, base, description: "Carry the map of upstream's pstack to a new snapshot" });
    const report = ".upstream-map-report.json";
    const commit = async (key: string, message: string, paths: readonly string[]): Promise<void> => {
      await gitOut(`${key}-add`, wt.path, ["add", "--", ...paths]);
      if ((await gitOut(`${key}-staged`, wt.path, ["diff", "--cached", "--name-only"])) !== "") await gitOut(`${key}-commit`, wt.path, ["commit", "-q", "-m", message]);
    };
    const measure = async (key: string): Promise<Summary> => summaryOf(await run(key, wt.path, [...tool, "check", "--summary", "--out", report, "--upstream", upstream.checkout]));
    const record = async (key: string, message: string): Promise<void> => {
      const ran = await run(`${key}-advance`, wt.path, [...tool, "advance", "--upstream", upstream.checkout]);
      if (ran.exit !== 0) throw new Error(`the map tool failed to advance: ${ran.out.trim().slice(-500)}`);
      await commit(key, message, ["packages/pstack/upstream"]);
    };

    phase("Refresh");
    const refreshed = await run("refresh", wt.path, [...tool, "refresh", upstream.checkout, ...(upstream.commit === undefined ? [] : [upstream.commit])]);
    if (refreshed.exit !== 0) throw new Error(`the snapshot was not taken: ${refreshed.out.trim().slice(-500)}`);
    const taken = /snapshot taken at ([0-9a-f]+)/.exec(refreshed.out)?.[1] ?? "";
    await commit("snapshot", `Take upstream pstack at ${taken.slice(0, 9)}`, ["packages/pstack/upstream"]);

    phase("Carry");
    const author = (await api().call("pstack.author.start", { place: wt.path }, { label: "author" })) as { ref: string; address: SessionAddress };
    const log: Array<{ round: number; before: string; summary: string }> = [];
    const asked: Array<{ question: string; why: string }> = [];
    let status: "synced" | "unfinished" | "stalled" = "unfinished";
    let summary = await measure("measure-0");
    const work = async (key: string, round: number, say: string[]): Promise<boolean> => {
      const before = await gitOut(`${key}-before`, wt.path, ["rev-parse", "HEAD"]);
      const said = await askSession(
        key,
        author.ref,
        [
          stepTag("upstream-sync", "round"),
          "",
          `You carry pstack's map of the upstream playbooks to a new snapshot of upstream. Work in ${wt.path}, on the branch ${wt.branch}.`,
          "The map is packages/pstack/upstream/mapping.json: entries { id, upstream, ours, kind, note }. A range is [start, end) in characters of a file at a commit, and nothing quoted is stored.",
          "The kinds: prompt, a block that goes into a prompt as upstream wrote it; adapted, a block our own text replaces in a prompt (the text is in the file the entry links to); code, a block that code of ours implements; dropped, a block we do not take, with the reason in its note. Dropped counts as covered. `ours` links an entry to the ranges that carry it.",
          `The tool measures the map and decides nothing: \`${tool.join(" ")} check\` prints the report (the whole of it is in ${report}, as JSON). It reports the coverage of upstream's characters per file with the uncovered ranges, and for each entry whether it is unchanged, touched (with the old and the new text of the range) or gone, on the upstream side and on ours.`,
          `The map is measured when it is at the commit of this worktree, so commit your work. Settle each entry the report shows, then ${tool.join(" ")} accept <id> records an entry at the positions its ranges were carried to; edit the entry by hand to link other ranges or to change its kind.`,
          `Settle: first the problems the report lists, if any; then map each uncovered range (prompt, adapted, code or dropped with a note), follow each touched entry into our code and texts, and link again or drop each gone one. The coverage must reach ${String(min)}% and no entry may stay touched or gone.`,
          "Carry what upstream changed verbatim where our text is its text. A change that would alter what a prompt or a workflow does is not yours to make: leave it, and answer it as a decision with the reason.",
          ...say,
          "",
          `The report now: ${JSON.stringify(summary)}`,
          "Answer what you did this round, the decisions left for the owner, and the commit.",
        ].join("\n"),
        answered,
      );
      for (const one of said.decisions) if (!asked.some((seen) => seen.question === one.question)) asked.push(one);
      log.push({ round, before, summary: said.summary });
      const after = await gitOut(`${key}-after`, wt.path, ["rev-parse", "HEAD"]);
      return after !== before;
    };
    for (let round = 1; round <= rounds && !settled(summary, min); round += 1) {
      const moved = await work(`round-${String(round)}`, round, []);
      await record(`carry-${String(round)}`, "Record the upstream ranges that did not change");
      summary = await measure(`measure-${String(round)}`);
      if (!moved && !settled(summary, min)) {
        status = "stalled";
        break;
      }
    }

    phase("Decide");
    const decisions: Array<{ question: string; why: string; answer: string }> = [];
    for (const [index, one] of asked.entries()) {
      decisions.push({ ...one, answer: await api().ask.text([`The sync of upstream's pstack leaves this to you: ${one.question}`, "", one.why].join("\n"), { label: `decision-${String(index)}` }) });
    }
    if (decisions.length > 0 && status !== "stalled") {
      await work("decided", log.length + 1, ["The owner answered what you left to them. Carry out each answer, and leave nothing of it undone:", ...decisions.map((one) => `- ${one.question}: ${one.answer}`)]);
      await record("carry-decided", "Record the upstream ranges that did not change");
      summary = await measure("measure-decided");
    }
    if (settled(summary, min)) status = "synced";

    phase("Record");
    if (status === "synced") {
      const assembled = await run("assemble", wt.path, [...tool, "assemble", "--upstream", upstream.checkout]);
      if (assembled.exit !== 0) throw new Error(`the texts were not assembled from the map: ${assembled.out.trim().slice(-500)}`);
      await commit("texts", "Assemble the playbook texts from the map", ["packages/pstack/src/workflows/texts"]);
    }
    const head = await gitOut("head", wt.path, ["rev-parse", "HEAD"]);
    const changed = linesOf(await gitOut("changed", wt.path, ["diff", "--name-only", `${base}...${head}`, "--", "packages/pstack/src"]));
    return { status, upstream: taken, worktree: wt.path, branch: wt.branch, head, summary, rounds: log, decisions, changed };
  },
);
