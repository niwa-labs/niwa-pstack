// Map commands and options are documented in the package README.
import { runUpstreamMapCli } from "@niwa-labs/upstream-map/cli";

import { upstreamMapConfig } from "../src/upstream.ts";

process.exitCode = runUpstreamMapCli(upstreamMapConfig());
