/**
 * pstack: delivery playbooks run as niwa's built-in workflows. The entry routes a request to the playbook it needs;
 * the suite tries every new version of them on scenarios before the host runs it.
 */

export { ENTRY, GATED, PLAYBOOKS, SUITE, SUITE_BUILTIN, scriptOf } from "./catalog.ts";
export type { Builtin } from "./catalog.ts";
export { pstackPlugin } from "./plugin.ts";
export type { PstackOptions } from "./plugin.ts";
export { pstackRoles } from "./records.ts";
export { AuthorRole, Roles, SeatRole } from "./roles.ts";
export type { RolesInput } from "./roles.ts";
export { refreshUpstream, playbookNames, textsOf } from "./upstream.ts";
export type { PlaybookText, UpstreamSource } from "./upstream.ts";
