"""Diagnose the installed Svode LFS agent using a disposable Git and S3 fixture."""

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from threading import Thread


FILES = {
    ".assets/trees.png": b"trees" * 19031,
    ".assets/cover.png": b"cover" * 136031,
}
OBJECTS = {hashlib.sha256(data).hexdigest(): data for data in FILES.values()}


class S3(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def serve_object(self, body):
        oid = self.path.rsplit("/", 1)[-1]
        data = OBJECTS.get(oid)
        expected = f"/assets/fixture/{oid[:2]}/{oid[2:4]}/{oid}"
        if self.path != expected or data is None:
            self.send_error(404)
            return
        if "Credential=fixture-access/" not in self.headers.get("Authorization", ""):
            self.send_error(403)
            return
        total = len(data)
        requested = self.headers.get("Range")
        content_range = None
        if requested:
            start, end = re.fullmatch(r"bytes=(\d+)-(\d*)", requested).groups()
            start = int(start)
            end = int(end) if end else total - 1
            data = data[start:end + 1]
            content_range = f"bytes {start}-{end}/{total}"
        print(f"S3 {self.command} {oid[:8]} ({len(data)} bytes)")
        self.send_response(206 if content_range else 200)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", '"fixture"')
        if content_range:
            self.send_header("Content-Range", content_range)
        self.end_headers()
        if body:
            self.wfile.write(data)

    def do_GET(self):
        self.serve_object(body=True)

    def do_HEAD(self):
        self.serve_object(body=False)


def run(args, repo, env, *, input_data=None, check=True):
    try:
        return subprocess.run(
            args, cwd=repo, env=env, input=input_data, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=40, check=check,
        )
    except subprocess.TimeoutExpired as error:
        if check:
            raise
        return subprocess.CompletedProcess(
            args, 124, (error.stdout or b"") + b"\nTimed out after 40 seconds\n"
        )


def git(repo, env, *args, check=True):
    return run(["git", *args], repo, env, check=check)


def setup(root, repo, port, binary, env):
    repo.mkdir()
    git(repo, env, "init", "-q")
    (repo / ".lfsconfig").write_text("[lfs]\n\turl = https://lfs-s3.svode.invalid/\n")
    (repo / ".assets").mkdir()
    for name, data in FILES.items():
        oid = hashlib.sha256(data).hexdigest()
        (repo / name).write_text(
            f"version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {len(data)}\n",
            newline="\n",
        )
    git(repo, env, "add", ".lfsconfig", *FILES)
    git(repo, env, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic LFS pointers")
    (root / "settings.json").write_text(json.dumps({"variables": {
        "ACCESS": {"kind": "secret", "secretRef": "secret:01ARZ3NDEKTSV4RRFFQ69G5FAV"},
        "SECRET": {"kind": "secret", "secretRef": "secret:01ARZ3NDEKTSV4RRFFQ69G5FAW"},
    }}))
    (repo / ".svode").mkdir()
    (repo / ".svode/config.json").write_text("{}")
    (repo / ".svode/lfs-s3-agent.json").write_text(json.dumps({
        "version": 2,
        "endpoint": f"http://127.0.0.1:{port}",
        "bucket": "assets",
        "region": "us-east-1",
        "prefix": "fixture",
        "globalDirectory": str(root),
        "projectPath": str(repo),
        "spaceId": None,
        "bindings": {
            "accessKey": {"owner": {"scope": "global"}, "name": "ACCESS"},
            "secretKey": {"owner": {"scope": "global"}, "name": "SECRET"},
        },
    }))
    git(repo, env, "config", "lfs.standalonetransferagent", "svode-lfs")
    git(repo, env, "config", "lfs.customtransfer.svode-lfs.path", binary)
    git(repo, env, "config", "lfs.customtransfer.svode-lfs.concurrent", "true")


def native(binary, repo, env):
    oid, data = next(iter(OBJECTS.items()))
    requests = [
        {"event": "init", "operation": "download", "remote": "origin"},
        {"event": "download", "oid": oid, "size": len(data)},
        {"event": "terminate"},
    ]
    result = run([binary], repo, env, check=False, input_data=b"".join(
        (json.dumps(request) + "\n").encode() for request in requests
    ))
    print(f"Native exit {result.returncode} (0x{result.returncode & 0xffffffff:08x})")
    print(result.stdout.decode("utf-8", "replace").strip())
    if result.returncode != 0:
        return False
    try:
        responses = [json.loads(line) for line in result.stdout.splitlines()]
    except ValueError:
        return False
    if not responses or responses[0] != {} or "path" not in responses[-1]:
        return False
    return Path(responses[-1]["path"]).read_bytes() == data


def fetch(repo, env, cache, name, binary=None):
    print(f"\n--- {name} ---")
    options = ["-c", f"lfs.storage={cache}"]
    if binary is not None:
        options.extend(["-c", f"lfs.customtransfer.svode-lfs.path={binary}"])
    result = git(repo, {**env, "GIT_TRACE": "1", "GIT_TRANSFER_TRACE": "1"},
                 *options, "lfs", "fetch", "--include=" + ",".join(FILES), check=False)
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        if " trace git-lfs: " not in line or any(
            part in line for part in ("xfer:", "tq: starting", "exec: sh ", "xfer[")
        ):
            print(line)
    matches = {}
    for oid, data in OBJECTS.items():
        downloaded = cache / "objects" / oid[:2] / oid[2:4] / oid
        matches[oid[:8]] = downloaded.is_file() and downloaded.read_bytes() == data
    print(f"git lfs fetch exit {result.returncode}, downloaded bytes match: {matches}")
    return result.returncode == 0 and all(matches.values())


def main():
    binary = str(Path(sys.argv[1]).resolve(strict=True))
    registered = "\\\\?\\" + binary if os.name == "nt" else binary
    with tempfile.TemporaryDirectory(prefix="svode-lfs-") as folder:
        root = Path(folder).resolve()
        repo = root / "fixture with spaces"
        config = root / "empty.gitconfig"
        config.touch()
        env = {name: value for name, value in os.environ.items()
               if not name.startswith(("GIT_", "SVODE_SECRET_"))}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=str(config),
                   GIT_TERMINAL_PROMPT="0", SVODE_SECRET_ACCESS="fixture-access",
                   SVODE_SECRET_SECRET="fixture-secret")
        print(git(root, env, "--version").stdout.decode().strip())
        print(git(root, env, "lfs", "version").stdout.decode().strip())
        print(f"Installed agent {binary}")
        print(f"SHA256 {hashlib.sha256(Path(binary).read_bytes()).hexdigest()}")
        with ThreadingHTTPServer(("127.0.0.1", 0), S3) as s3:
            worker = Thread(target=s3.serve_forever, daemon=True)
            worker.start()
            try:
                setup(root, repo, s3.server_port, registered, env)
                direct_ok = native(binary, repo, env)
                registered_ok = fetch(repo, env, root / "registered-cache", "Registered path")
                plain_ok = fetch(repo, env, root / "plain-cache", "Ordinary path", binary)
                print(f"\nRESULT native={direct_ok} registered={registered_ok} plain={plain_ok}")
                return 0 if direct_ok and registered_ok and plain_ok else 1
            finally:
                s3.shutdown()
                worker.join()


if __name__ == "__main__":
    sys.exit(main())
