#!/usr/bin/env node
// Build the svode-mcp sidecar into `src-tauri/binaries/svode-mcp-<triple>`.

import { buildSidecar } from "./sidecar.mjs";

buildSidecar({ pkg: "svode-mcp", bin: "svode-mcp", profile: "release" });
