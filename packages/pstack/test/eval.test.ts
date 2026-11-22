import { expect, test } from "bun:test";
import { join } from "node:path";

import { ROLES, defaultAnswers, pstackHost } from "./support.ts";

test("Eval with no common out-of-vendor judge withholds every grade and recommendation", async () => {
  const made = await pstackHost({
    benny: false, onlyBuiltins: ["eval"],
    roles: { ...ROLES, verifier: { harness: "verifier", vendor: "reviewer" }, judge: { harness: "judge", vendor: "judge" } },
  });
  try {
    made.harnesses.answers = defaultAnswers(made);
    const ran = await made.host.call("workflow.start" as never, {
      file: join(import.meta.dir, "../src/workflows/eval.ts"),
      args: { ...made.fixture, task: "Compare two replies", variants: { independent: "reviewer", ungraded: "judge" } },
      wait: true,
      timeoutMs: 30_000,
    } as never) as { outcome?: unknown };
    expect(ran.outcome).toMatchObject({
      status: "done",
      result: { status: "judged", decision: "incomplete", table: { independent: { readme: null }, ungraded: { readme: null } }, grades: [], recommend: null },
    });
    expect(made.harnesses.calls.some(({ prompt }) => prompt.startsWith("Grade all labeled outputs"))).toBe(false);
  } finally {
    await made.close();
  }
}, 60_000);
