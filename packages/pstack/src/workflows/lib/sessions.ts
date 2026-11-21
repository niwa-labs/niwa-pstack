/**
 * Sessions a lane starts itself, rather than through `agent()`: the lane needs the session's reference, for the
 * address its verdicts are told apart by, and asks it more than once.
 */

import type { z as Z } from "zod";

import { zod } from "./inputs.ts";
import { api } from "./script.ts";
import type { Seat, SessionAddress } from "./script.ts";

/** A session a lane started: its reference, and the address it attests as. */
export interface Started {
  ref: string;
  address: SessionAddress;
}

/** The address of a session's reference, `<harness> <native id>`. */
export function addressOf(ref: string): SessionAddress {
  const at = ref.indexOf(" ");
  if (at <= 0 || at === ref.length - 1) throw new Error(`a session reference is "<harness> <native id>", not ${JSON.stringify(ref)}`);
  return { kind: "session", harness: ref.slice(0, at), id: ref.slice(at + 1) };
}

/** Start a session of a seat in a directory, with the niwa actions that `visible` names. */
export async function startSession(key: string, seat: Seat, opts: { cwd: string; visible: string[] }): Promise<Started> {
  const started = (await api().call(
    "session.start",
    {
      harness: seat.harness,
      prompt: "",
      cwd: opts.cwd,
      visible: { actions: opts.visible },
      ...(seat.model === undefined ? {} : { model: seat.model }),
      ...(seat.effort === undefined ? {} : { effort: seat.effort }),
    },
    { label: key },
  )) as { ref: string };
  return { ref: started.ref, address: addressOf(started.ref) };
}

/** Ask a session and answer what it said, held to the schema. */
export async function askSession<S extends Z.ZodType>(key: string, ref: string, prompt: string, schema: S): Promise<Z.output<S>> {
  const asked = (await api().call("session.ask", { session: ref, prompt, schema: zod().toJSONSchema(schema) }, { label: key })) as { value: unknown };
  return schema.parse(asked.value) as Z.output<S>;
}
