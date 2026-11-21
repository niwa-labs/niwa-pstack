// Carrying a range of characters from an old text to a new one: what stayed where it was, what was touched, what is gone.

import { expect, test } from "bun:test";

import { carry, diffText } from "../src/mapping/diff.ts";

const OLD = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

const at = (text: string, needle: string): [number, number] => {
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`${needle} not in text`);
  return [start, start + needle.length];
};

test("equal texts carry every range to itself", () => {
  const segments = diffText(OLD, OLD);
  expect(carry(segments, at(OLD, "Second paragraph."))).toEqual({ status: "unchanged", range: at(OLD, "Second paragraph.") });
});

test("text added before a range shifts it and leaves it unchanged", () => {
  const next = `Intro.\n\n${OLD}`;
  expect(carry(diffText(OLD, next), at(OLD, "Second paragraph."))).toEqual({ status: "unchanged", range: at(next, "Second paragraph.") });
});

test("a line rewritten inside a range touches the range, and the new range is the rewritten block", () => {
  const next = OLD.replace("Second paragraph.", "Second, rewritten paragraph.");
  const moved = carry(diffText(OLD, next), at(OLD, "Second paragraph."));
  expect(moved.status).toBe("touched");
  if (moved.status === "gone") throw new Error("not gone");
  expect(next.slice(...moved.range)).toContain("rewritten");
});

test("a change on one line leaves a range on another part of that line unchanged", () => {
  const old = "alpha beta gamma\n";
  const next = "alpha BETA gamma\n";
  const diff = diffText(old, next);
  expect(carry(diff, at(old, "alpha"))).toEqual({ status: "unchanged", range: [0, 5] });
  expect(carry(diff, at(old, "gamma"))).toEqual({ status: "unchanged", range: at(next, "gamma") });
  expect(carry(diff, at(old, "beta")).status).toBe("touched");
});

test("a range whose text was removed is gone, and one that lost only a part is touched", () => {
  const next = OLD.replace("Second paragraph.\n\n", "");
  const diff = diffText(OLD, next);
  expect(carry(diff, at(OLD, "Second paragraph."))).toEqual({ status: "gone" });
  const partial = carry(diff, [OLD.indexOf("First"), OLD.indexOf("Second") + 6]);
  expect(partial.status).toBe("touched");
});

test("an insertion inside a range touches it", () => {
  const next = OLD.replace("First paragraph.\n\n", "First paragraph.\n\nInserted.\n\n");
  expect(carry(diffText(OLD, next), [OLD.indexOf("First"), OLD.indexOf("Third") + 5]).status).toBe("touched");
});

test("a text that became empty takes every range with it", () => {
  expect(carry(diffText("abc\n", ""), [0, 3])).toEqual({ status: "gone" });
});

test("offsets count UTF-16 code units, as string indexes do", () => {
  const old = "one\n\ntwo — dash\n\nthree\n";
  const next = `zero\n\n${old}`;
  const range = at(old, "three");
  expect(carry(diffText(old, next), range)).toEqual({ status: "unchanged", range: at(next, "three") });
});
