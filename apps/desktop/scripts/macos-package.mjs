// Sign the built `Svode.app` ad hoc with a stable identity and pack it into
// the dmg: `node scripts/macos-package.mjs <tauri bundle dir>`, run after
// `tauri build --bundles app`.
//
// macOS keeps privacy (TCC) grants such as Documents folder access against
// the app's designated requirement. An ad hoc signature, including the one
// Tauri makes with `signingIdentity: "-"`, gets a cdhash requirement that
// changes with every build, so each update looks like a new app and asks
// again. Pinning the requirement to the bundle identifier keeps one identity
// across builds without a Developer ID certificate. Gatekeeper still treats
// the downloaded dmg as coming from an unidentified developer.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entitlements = resolve(__dirname, "../src-tauri/Entitlements.plist");

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})`);
  }
}

function infoPlistValue(app, key) {
  return execFileSync(
    "plutil",
    ["-extract", key, "raw", "-o", "-", join(app, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
}

function signPinned(path, identifier, extraArgs = []) {
  run("codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--identifier",
    identifier,
    "--requirements",
    `=designated => identifier "${identifier}"`,
    ...extraArgs,
    path,
  ]);
}

function designatedRequirement(path) {
  // codesign prints the requirement on stdout and the header on stderr.
  return execFileSync("codesign", ["-d", "-r-", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function dmgArch(executable) {
  const archs = execFileSync("lipo", ["-archs", executable], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/);
  if (archs.length > 1) return "universal";
  if (archs[0] === "arm64") return "aarch64";
  if (archs[0] === "x86_64") return "x64";
  throw new Error(`unsupported architecture ${archs[0]}`);
}

const [bundleDirArg] = process.argv.slice(2);
if (!bundleDirArg) {
  throw new Error("usage: node scripts/macos-package.mjs <tauri bundle dir>");
}
const bundleDir = resolve(bundleDirArg);
const app = join(bundleDir, "macos/Svode.app");
if (!existsSync(app)) throw new Error(`no app bundle at ${app}`);

const identifier = infoPlistValue(app, "CFBundleIdentifier");
const mainExecutable = infoPlistValue(app, "CFBundleExecutable");
const version = infoPlistValue(app, "CFBundleShortVersionString");
const macosDir = join(app, "Contents/MacOS");

// Nested code is signed before the bundle that seals it.
for (const name of readdirSync(macosDir)) {
  if (name === mainExecutable) continue;
  signPinned(join(macosDir, name), `${identifier}.${name}`);
}
signPinned(app, identifier, ["--entitlements", entitlements]);

run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
const requirement = designatedRequirement(app);
if (
  !requirement.includes(`designated => identifier "${identifier}"`) ||
  requirement.includes("cdhash")
) {
  throw new Error(`unexpected designated requirement:\n${requirement}`);
}

const dmgDir = join(bundleDir, "dmg");
mkdirSync(dmgDir, { recursive: true });
const dmg = join(
  dmgDir,
  `Svode_${version}_${dmgArch(join(macosDir, mainExecutable))}.dmg`,
);
const staging = mkdtempSync(join(tmpdir(), "svode-dmg-"));
try {
  run("ditto", [app, join(staging, "Svode.app")]);
  symlinkSync("/Applications", join(staging, "Applications"));
  run("hdiutil", [
    "create",
    "-volname",
    "Svode",
    "-srcfolder",
    staging,
    "-fs",
    "HFS+",
    "-format",
    "UDZO",
    "-ov",
    dmg,
  ]);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`signed ${app} as ${identifier} and packed ${dmg}`);
