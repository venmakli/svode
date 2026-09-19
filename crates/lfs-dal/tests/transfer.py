#!/usr/bin/env python3
"""macOS process regression: real sidecar, Git LFS and loopback S3 fixture.

Run after cargo build: python3 tests/transfer.py ../../target/debug/lfs-dal
Creates two unique synthetic Keychain entries and deletes them in finally.
All repositories, S3 objects and caches are disposable; no user config is read.
"""

import concurrent.futures
import hashlib
import http.server
import json
import os
from pathlib import Path
import resource
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import time

BLOB = bytes(range(256)) * 32
OID = hashlib.sha256(BLOB).hexdigest()
KEY = f"/assets/fixture/{OID[:2]}/{OID[2:4]}/{OID}"
SERVICE = "app.svode.desktop.variables"


def run(args, cwd=None, **kwargs):
    result = subprocess.run(args, cwd=cwd, capture_output=True, timeout=60, **kwargs)
    assert result.returncode == 0, (args[0:3], result.stderr.decode(errors="replace"))
    return result.stdout


def git(repo, *args, **kwargs):
    return run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args], repo, **kwargs)


class S3(http.server.BaseHTTPRequestHandler):
    objects = {KEY: BLOB}
    reads = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        assert "Credential=fixture-access/" in self.headers["Authorization"]
        data = self.objects.get(self.path)
        self.reads.append(self.path)
        self.send_response(200 if data is not None else 404)
        self.send_header("Content-Length", str(len(data) if data is not None else 0))
        self.end_headers()
        if data is not None:
            self.wfile.write(data)

    def do_PUT(self):
        assert "Credential=fixture-access/" in self.headers["Authorization"]
        self.objects[self.path] = self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.send_header("ETag", '"fixture"')
        self.end_headers()


class Session:
    def __init__(self, binary, repo, limited=False):
        def limit():
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            resource.setrlimit(resource.RLIMIT_FSIZE, (1024, 1024))
        self.child = subprocess.Popen([str(binary)], cwd=repo, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      preexec_fn=limit if limited else None)
        assert self.request(event="init", operation="download") == {}

    def request(self, **request):
        self.child.stdin.write(json.dumps(request).encode() + b"\n")
        self.child.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(self.child.stdout, selectors.EVENT_READ)
            assert selector.select(timeout=30), "sidecar protocol response timed out"
        line = self.child.stdout.readline()
        assert line, "sidecar exited before response"
        return json.loads(line)

    def download(self, oid=OID, size=len(BLOB)):
        return self.request(event="download", oid=oid, size=size)

    def close(self):
        self.child.stdin.write(b'{"event":"terminate"}\n')
        self.child.stdin.flush()
        stdout, stderr = self.child.communicate(timeout=10)
        assert self.child.returncode == 0 and not stdout and not stderr

    def __enter__(self):
        return self

    def __exit__(self, *error):
        if error[0] is None:
            self.close()
        else:
            self.child.kill()
            self.child.communicate()


def failure(response):
    assert response["event"] == "complete" and response["error"]["code"] == 3
    assert "path" not in response
    assert "fixture-access" not in response["error"]["message"]
    assert "fixture-secret" not in response["error"]["message"]


def configure(repo, root, port, binary):
    (repo / ".svode").mkdir(exist_ok=True)
    (repo / ".svode/config.json").write_text("{}")
    (repo / ".svode/lfs-s3-agent.json").write_text(json.dumps({
        "version": 2, "endpoint": f"http://127.0.0.1:{port}", "bucket": "assets",
        "region": "us-east-1", "prefix": "fixture", "globalDirectory": str(root),
        "projectPath": str(repo), "spaceId": None,
        "bindings": {"accessKey": {"owner": {"scope": "global"}, "name": "ACCESS"},
                     "secretKey": {"owner": {"scope": "global"}, "name": "SECRET"}},
    }))
    git(repo, "config", "lfs.standalonetransferagent", "lfs-dal")
    git(repo, "config", "lfs.customtransfer.lfs-dal.path", str(binary))
    git(repo, "config", "lfs.customtransfer.lfs-dal.concurrent", "true")
    git(repo, "config", "remote.origin.url", "https://fixture.invalid/repo.git")


def check_layout(repo, cache=None):
    data = BLOB + repo.name.encode()
    oid = hashlib.sha256(data).hexdigest()
    S3.objects[f"/assets/fixture/{oid[:2]}/{oid[2:4]}/{oid}"] = data
    directory = Path(git(repo, "rev-parse", "--absolute-git-dir").decode().rstrip("\n"))
    metadata = [directory / "HEAD", directory / "index"]
    if (repo / ".git").is_file():
        metadata.append(repo / ".git")
    before = {p: p.read_bytes() for p in metadata}
    untracked = git(repo, "ls-files", "--others", "--exclude-standard")
    if cache is not None:
        git(repo, "config", "lfs.storage", str(cache))
    environment = git(repo, "lfs", "env").decode().splitlines()
    media = Path(next(line.removeprefix("LocalMediaDir=") for line in environment
                      if line.startswith("LocalMediaDir=")))
    if cache is not None:
        assert media == cache / "objects"
    cached = media / oid[:2] / oid[2:4] / oid
    assert not cached.exists()
    reads = len(S3.reads)
    pointer = f"version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {len(data)}\n".encode()
    received = git(repo, "lfs", "smudge", input=pointer)
    assert received == data and hashlib.sha256(received).hexdigest() == oid
    assert cached.read_bytes() == data and len(S3.reads) > reads
    assert all(p.read_bytes() == data for p, data in before.items())
    assert git(repo, "ls-files", "--others", "--exclude-standard") == untracked
    assert not list((directory / "lfs/tmp/lfs-dal").iterdir()), "Git LFS must consume the handoff"


def exercise(root, binary, port):
    ordinary = root / "обычный repo"
    ordinary.mkdir()
    git(ordinary, "init")
    (ordinary / "tracked").write_bytes(b"original")
    git(ordinary, "add", "tracked")
    git(ordinary, "commit", "-m", "fixture")
    parent = root / "parent"
    parent.mkdir()
    git(parent, "init")
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", str(ordinary), "модуль space")
    submodule = parent / "модуль space"
    linked = root / "linked worktree"
    git(ordinary, "worktree", "add", "-b", "linked", str(linked))
    for repo in (ordinary, submodule, linked):
        configure(repo, root, port, binary)
        check_layout(repo)
        print(f"PASS real Git LFS handoff: {repo.name}")
    # A distinct empty cache forces another network transfer without deleting objects.
    check_layout(submodule, root / "custom cache")
    print("PASS custom lfs.storage")

    def transfer(_):
        with Session(binary, submodule) as session:
            first, second = session.download(), session.download()
            assert "error" not in first and "error" not in second
            return first["path"], second["path"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        paths = [p for pair in pool.map(transfer, range(4)) for p in pair]
    assert len(set(paths)) == 8
    for path in paths:
        assert Path(path).is_absolute() and Path(path).read_bytes() == BLOB
    print("PASS same-OID parallel processes, repeated transfer, file survives terminate")

    directory = Path(git(submodule, "rev-parse", "--absolute-git-dir").decode().rstrip("\n"))
    temporary = directory / "lfs/tmp/lfs-dal"
    with Session(binary, submodule) as session:
        gitfile = submodule / ".git"
        original = gitfile.read_bytes()
        try:
            gitfile.write_text("gitdir: /nonexistent/df-123-fixture\n")
            failure(session.download())
        finally:
            gitfile.write_bytes(original)
        assert "path" in session.download()
        saved = temporary.with_name("saved")
        temporary.rename(saved)
        try:
            temporary.write_bytes(b"obstruction")
            failure(session.download())
            assert temporary.read_bytes() == b"obstruction"
        finally:
            temporary.unlink()
            saved.rename(temporary)
        assert "path" in session.download()
        # Upload must not prepare or resolve a download directory.
        try:
            gitfile.write_text("gitdir: /nonexistent/df-123-fixture\n")
            blob = root / "upload"
            blob.write_bytes(b"uploaded")
            oid = hashlib.sha256(b"uploaded").hexdigest()
            result = session.request(event="upload", oid=oid, size=8, path=str(blob))
            assert "error" not in result
            assert S3.objects[f"/assets/fixture/{oid[:2]}/{oid[2:4]}/{oid}"] == b"uploaded"
        finally:
            gitfile.write_bytes(original)
    print("PASS object-level Git/create failures, same-session retry, independent upload")
    before = {p.name: p.read_bytes() for p in temporary.iterdir()}
    with Session(binary, submodule, limited=True) as session:
        response = session.download()
        failure(response)
        assert "writing LFS download file" in response["error"]["message"]
        assert {p.name: p.read_bytes() for p in temporary.iterdir()} == before
        small = b"retry"
        small_oid = hashlib.sha256(small).hexdigest()
        S3.objects[f"/assets/fixture/{small_oid[:2]}/{small_oid[2:4]}/{small_oid}"] = small
        assert Path(session.download(small_oid, len(small))["path"]).read_bytes() == small
    print("PASS actual write failure, partial cleanup, same-session retry")


def main():
    assert sys.platform == "darwin", "This fixture uses macOS Keychain and RLIMIT_FSIZE"
    binary = Path(sys.argv[1]).resolve(strict=True)
    entries = []
    previous = dict(os.environ)
    server = None
    try:
        with tempfile.TemporaryDirectory(prefix="svode-lfs-regression-") as folder:
            root = Path(folder).resolve()
            for key in list(os.environ):
                if key.startswith("GIT_"):
                    del os.environ[key]
            os.environ.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                              GIT_TERMINAL_PROMPT="0", GIT_LFS_SKIP_SMUDGE="0")
            catalog = {}
            for i, (name, value) in enumerate((("ACCESS", "fixture-access"), ("SECRET", "fixture-secret"))):
                account = f"secret:{time.time_ns() + i:026d}"
                run(["security", "add-generic-password", "-s", SERVICE, "-a", account,
                     "-w", value, "-T", str(binary)])
                entries.append(account)
                catalog[name] = {"kind": "secret", "secretRef": account}
            (root / "settings.json").write_text(json.dumps({"variables": catalog}))
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), S3)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            print(run(["git", "--version"]).decode().strip())
            print(run(["git", "lfs", "version"]).decode().strip())
            print(f"sidecar: {binary}")
            print(f"sha256: {hashlib.sha256(binary.read_bytes()).hexdigest()}")
            exercise(root, binary, server.server_port)
    finally:
        if server:
            server.shutdown()
            server.server_close()
        for account in entries:
            run(["security", "delete-generic-password", "-s", SERVICE, "-a", account])
        os.environ.clear()
        os.environ.update(previous)


if __name__ == "__main__":
    main()
