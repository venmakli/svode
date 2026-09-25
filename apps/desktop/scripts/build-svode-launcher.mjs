#!/usr/bin/env node
// Build the launcher of the stable location ~/.svode into
// `src-tauri/binaries/svode-launcher-<triple>`.

import { buildSidecar } from "./sidecar.mjs";

buildSidecar({ pkg: "svode-install", bin: "svode-launcher", profile: "release" });
