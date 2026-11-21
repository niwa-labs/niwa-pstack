/**
 * The mapping of the upstream snapshot: for each block of upstream text, where it went in pstack.
 *
 * Ranges are character offsets, `[start, end)`, in UTF-16 code units, and nothing quoted is stored. A range on the
 * upstream side belongs to a file of the snapshot (the path under `upstream/`) at a commit of the upstream
 * repository. A range on our side belongs to a file of this repository (the path from its root) at a commit of this
 * repository: the commit the range was recorded at.
 */

import { z } from "zod";

/** A commit, in full. */
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "a full commit hash");

const range = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => start < end, "a range ends after it starts");

const reference = z.strictObject({ commit, file: z.string().min(1), range });

/** What became of a block of upstream text. */
export const KINDS = ["prompt", "code", "adapted", "dropped"] as const;
export type Kind = (typeof KINDS)[number];

export const Entry = z.strictObject({
  id: z.string().min(1),
  upstream: reference,
  ours: z.array(reference),
  kind: z.enum(KINDS),
  note: z.string().min(1).optional(),
});
export type Entry = z.infer<typeof Entry>;
export type Ref = z.infer<typeof reference>;

export const Mapping = z.strictObject({ entries: z.array(Entry) });
export type Mapping = z.infer<typeof Mapping>;

/** Read a mapping from its text. */
export function parseMapping(text: string): Mapping {
  return Mapping.parse(JSON.parse(text));
}

/** Write a mapping, an entry to a line, so a change to one entry is a change to one line. */
export function formatMapping(mapping: Mapping): string {
  const lines = mapping.entries.map((entry) => {
    const { id, upstream, ours, kind, note } = entry;
    return `    ${JSON.stringify({ id, upstream, ours, kind, ...(note === undefined ? {} : { note }) })}`;
  });
  return `{\n  "entries": [\n${lines.join(",\n")}\n  ]\n}\n`;
}
