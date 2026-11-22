import { recoverPublishedLane } from "./autopilot-recovery.ts";
import { gitOut } from "./git.ts";
import { zod } from "./inputs.ts";
import { deliver, prHeadPipeline } from "./lane.ts";
import { api, forgeRepo, seatOptions, stepTag } from "./script.ts";

type Delivery = Parameters<typeof deliver>[1];
type Progress = Parameters<NonNullable<Delivery["progress"]>>[0];

/** A bounded owner lane with an hourly observer scoped to the same worktree and PR. */
export async function supervisedDelivery(key: string, opts: Delivery) {
  let progress: Progress | undefined;
  const done = await api().scope(key, { onExit: "cancel", deadline: "8h", onDeadline: "skip" }, async scope => {
    const owner = scope.start("owner", () => deliver(key, { ...opts, progress: value => { progress = value; } }));
    scope.start("audit", async () => {
      let previous: string | undefined;
      let unchanged = 0;
      for (let tick = 1; ; tick++) {
        await api().sleep("1h", { label: `${key}-audit-sleep-${tick}` });
        const snapshot = await observe(`${key}-audit-${tick}`, opts, progress);
        unchanged = snapshot === previous ? unchanged + 1 : 0;
        if (snapshot !== previous || unchanged === 1) {
          api().log(`${key}: ${snapshot}${unchanged === 1 ? " (unchanged for an hour)" : ""}`);
        }
        previous = snapshot;
      }
    });
    const first = await scope.next();
    if (first?.key === "audit" && !first.result.ok && first.result.error.name !== "Cancelled") {
      throw Object.assign(new Error(first.result.error.message), { name: first.result.error.name });
    }
    return owner.settled();
  });
  if (!done) {
    if (progress?.pr) {
      const snapshot = progress;
      const recovered = await api().moveOnAfter(`${key}-recover`, "2h", () => recoverPublishedLane(`${key}-recover`, opts, snapshot));
      if (recovered) return { delivered: recovered } as const;
    }
    const location = progress === undefined ? "" : ` Worktree: ${progress.wt.path}.${progress.pr ? ` PR: ${progress.pr.number}.` : ""}`;
    return { reason: `Owner timed out.${location}` } as const;
  }
  if (!done.ok) {
    if (done.error.name === "Cancelled") throw Object.assign(new Error(done.error.message), { name: "Cancelled" });
    const location = progress === undefined ? "" : ` Worktree: ${progress.wt.path}.${progress.pr ? ` PR: ${progress.pr.number}.` : ""}`;
    return { reason: `${done.error.message}${location}` } as const;
  }
  return { delivered: done.value } as const;
}

async function observe(key: string, opts: Delivery, progress: Progress | undefined): Promise<string> {
  if (!progress) return "waiting for an authoring worktree";
  const head = await gitOut(`${key}-head`, progress.wt.path, ["rev-parse", "HEAD"]);
  const dirty = await gitOut(`${key}-status`, progress.wt.path, ["status", "--porcelain"]);
  const detail = `${progress.stage} in ${progress.wt.path} at ${head}${dirty ? " (dirty)" : ""}`;
  if (!progress.pr) return detail;
  const checks = await api().call("forge.checks.read", { repo: forgeRepo(opts.repo), number: progress.pr.number }, { label: `${key}-checks` }) as {
    head: string; state: string; pipeline?: number;
  };
  return `${detail}, PR ${progress.pr.number} at ${checks.head}, CI ${checks.state}${checks.pipeline === undefined ? "" : ` (${checks.pipeline})`}${checks.head === progress.pr.head ? "" : " (head moved since verification started)"}`;
}

/** Inspect the exact patch independently, then ask for a fresh owner decision on a proved relaxation. */
export async function countersign(key: string, opts: Delivery, done: NonNullable<Awaited<ReturnType<typeof supervisedDelivery>>["delivered"]>) {
  const z = zod();
  const head = done.pr.head;
  const cwd = done.built.wt.path;
  const fork = await gitOut(`${key}-fork`, cwd, ["merge-base", "HEAD", opts.base]);
  const review = await api().ask({
    ...seatOptions(opts.roles.reviewer), mode: "ask", cwd, label: `${key}-review`, visible: [],
    schema: z.strictObject({ kind: z.enum(["unchanged", "relaxed", "disabled", "unproved"]), proof: z.string().trim().min(1).max(4000) }),
  }, [
    stepTag(opts.playbook.name, "gate-review"),
    `Inspect the exact patch ${fork}..${head} for ${done.pr.subject}. The worktree and all forge state must remain unchanged.`,
    "Identify any gate that is disabled or soft-failed, including by configuration or changed invocation, and report disabled.",
    "For a gate relaxation, such as a budget or allowlist, independently run the relevant gate and prove what protection still holds. Return relaxed with the exact change, command and result. Return unproved if you cannot show this.",
    "Return unchanged only after inspecting the committed patch for these changes. Cite what you checked.",
  ].join("\n"));
  if (await gitOut(`${key}-head`, cwd, ["rev-parse", "HEAD"]) !== head ||
      await gitOut(`${key}-status`, cwd, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    return { decision: "blocked", proof: "The checkout moved during gate review." } as const;
  }
  if (review.kind === "disabled" || review.kind === "unproved") return { decision: "blocked", proof: review.proof } as const;
  if (review.kind === "relaxed" && !await api().ask.confirm(
    `Countersign the gate relaxation for ${done.pr.subject} at ${head}?\n\nIndependent review:\n${review.proof}`,
    { label: `${key}-confirm` },
  )) return { decision: "declined", proof: review.proof } as const;
  const params = { repo: forgeRepo(opts.repo), number: done.pr.number };
  const pipeline = await prHeadPipeline(`${key}-head-ci`, { ...params, repo: opts.repo, sha: head });
  const pr = await api().call("forge.pr.read", params, { label: `${key}-pr` }) as { head: string; base: string; state: string; autoMerge: boolean };
  if (pipeline?.state !== "success" ||
      pr.head !== head || pr.base !== opts.base || pr.state !== "open" || pr.autoMerge) {
    return { decision: "blocked", proof: "The reviewed PR, its target, or its green head CI changed during gate review." } as const;
  }
  return { decision: review.kind === "relaxed" ? "approved" : "unchanged", proof: review.proof } as const;
}
