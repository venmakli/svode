#!/usr/bin/env node
// Build the `svode` CLI sidecar into `src-tauri/binaries/svode-<triple>`.

import { buildSidecar } from "./sidecar.mjs";

buildSidecar({ pkg: "svode-cli", bin: "svode", profile: "release" });
