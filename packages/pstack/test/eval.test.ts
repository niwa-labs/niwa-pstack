import { expect, test } from "bun:test";
import { join } from "node:path";

import { ROLES, defaultAnswers, pstackHost } from "./support.ts";

test("the eval workflow returns a null score for a variant without an independent grader", async () => {
  const made = await pstackHost({ benny: false, roles: { ...ROLES, judge: { harness: "judge", vendor: "judge" } } });
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
      result: { status: "judged", table: { independent: { readme: 1 }, ungraded: { readme: null } }, recommend: null },
    });
  } finally {
    await made.close();
  }
}, 60_000);
