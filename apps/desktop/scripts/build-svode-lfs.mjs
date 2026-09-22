#!/usr/bin/env node
// Build the svode-lfs sidecar into `src-tauri/binaries/svode-lfs-<triple>`.

import { buildSidecar } from "./sidecar.mjs";

buildSidecar({ pkg: "svode-lfs", bin: "svode-lfs", profile: "lfs-release" });
