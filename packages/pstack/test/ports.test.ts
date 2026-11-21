// Benny's ports: pstack ships the contracts and no implementation. A host that lacks a port refuses to enable Benny and
// says which; a provider's actions are held to the contract they implement.

import { afterEach, expect, test } from "bun:test";

import { pstackHost } from "./support.ts";
import type { PstackHost } from "./support.ts";

const hosts: PstackHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

test("a host that lacks a port of Benny's refuses to enable him, and names every port it lacks", async () => {
  await expect(pstackHost({ withoutPorts: ["tracker", "control"] })).rejects.toThrow(/issue tracker port \(benny\.tracker\.\*\)[\s\S]*product control port \(benny\.control\.\*\)/);
  const error = await pstackHost({ withoutPorts: ["channel"] }).catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("report channel port (benny.channel.*)");
  expect((error as Error).message).not.toContain("issue tracker");
  expect((error as Error).message).toContain("before pstack");
  expect((error as Error).message).toContain("Benny needs your plugins");
}, 60_000);

test("a host with no Benny needs no port", async () => {
  const made = await pstackHost({ benny: false, withoutPorts: ["tracker", "channel", "control"] });
  hosts.push(made);
  expect(made.agents).toEqual([]);
  // The suite's grant names the port actions, so they exist; with no Benny they only say so.
  await expect(made.asOwner("benny.tracker.find", { text: "x" })).rejects.toThrow("Benny is not enabled");
}, 60_000);

test("a provider's actions are held to the contract: input and output are checked by the references", async () => {
  const made = await pstackHost();
  hosts.push(made);
  const created = (await made.asOwner("benny.tracker.create", { title: "README names the wrong service", body: "Quoted.", source: "thread-1" })) as { id: string; url: string };
  expect(created.id).toBe("ISSUE-1");
  const found = (await made.asOwner("benny.tracker.find", { text: "wrong service" })) as { items: Array<{ id: string; state: string }> };
  expect(found.items).toEqual([expect.objectContaining({ id: "ISSUE-1", state: "open" })]);
  await expect(made.asOwner("benny.tracker.find", { text: "x", state: "pending" })).rejects.toThrow();
  await expect(made.asOwner("benny.tracker.create", { title: "no source", body: "x" })).rejects.toThrow();
  expect(await made.asOwner("benny.tracker.link-pr", { id: "ISSUE-1", pr: "gitlab.example.com/acme/billing/pr/7" })).toEqual({ ok: true });
  expect(await made.asOwner("benny.channel.reply", { source: "thread-1", text: "A bug." })).toEqual({ id: "msg-1" });
  expect(await made.asOwner("benny.control.capabilities", {})).toEqual({ features: ["readme"], missing: [] });
  await expect(made.asOwner("benny.control.drive", { session: "app-1" })).rejects.toThrow();
}, 60_000);
