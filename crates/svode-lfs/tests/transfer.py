#!/usr/bin/env python3
"""macOS process regression: real sidecar, Git LFS and loopback S3 fixture.

Run after cargo build: python3 tests/transfer.py ../../target/debug/svode-lfs
Creates two unique synthetic Keychain entries and deletes them in finally.
All repositories, S3 objects and caches are disposable; no user config is read.
Objects larger than an S3 part go through the multipart upload of the fixture;
every transfer is checked for its `progress` events.
"""

import concurrent.futures
import hashlib
import http.server
import json
import os
from pathlib import Path
import random
import re
import resource
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit

BLOB = bytes(range(256)) * 32
MIB = 1024 * 1024
PART = 5 * MIB
# Many S3 parts and an uneven tail, larger than the bounded buffers of the agent;
# pseudo-random so no layer can compress it.
LARGE = random.Random(369).randbytes(16 * PART + 12345)
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
    # upload id -> {part number: bytes}; completed uploads keep their part sizes.
    uploads = {}
    completed = {}
    # Bytes per second the fixture reads and sends, like a slow link; None is full speed.
    rate = None

    def log_message(self, *args):
        pass

    def target(self):
        assert "Credential=fixture-access/" in self.headers["Authorization"]
        url = urlsplit(self.path)
        return url.path, {k: v[0] for k, v in parse_qs(url.query, keep_blank_values=True).items()}

    def reply(self, status, body=b"", headers=()):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def pause(self, size):
        if self.rate:
            time.sleep(size / self.rate)

    def body(self):
        remaining, data = int(self.headers.get("Content-Length", 0)), bytearray()
        while remaining:
            piece = self.rfile.read(min(remaining, 64 * 1024))
            assert piece, "request body ended early"
            data += piece
            remaining -= len(piece)
            self.pause(len(piece))
        return bytes(data)

    def do_GET(self):
        path, _ = self.target()
        data = self.objects.get(path)
        self.reads.append(path)
        if data is None:
            self.reply(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        # Send in pieces, as a remote server does, so the reader gets chunks.
        for start in range(0, len(data), 64 * 1024):
            self.wfile.write(data[start:start + 64 * 1024])
            self.pause(64 * 1024)

    def do_PUT(self):
        path, query = self.target()
        data = self.body()
        if "uploadId" in query:
            self.uploads[query["uploadId"]][int(query["partNumber"])] = data
            self.reply(200, headers=[("ETag", f'"part-{query["partNumber"]}"')])
            return
        self.objects[path] = data
        self.reply(200, headers=[("ETag", '"fixture"')])

    def do_POST(self):
        path, query = self.target()
        request = self.body()
        if "uploads" in query:
            upload = f"upload-{len(self.uploads) + len(self.completed) + 1}"
            self.uploads[upload] = {}
            self.reply(200, f"<InitiateMultipartUploadResult><Bucket>assets</Bucket><Key>{path}</Key>"
                            f"<UploadId>{upload}</UploadId></InitiateMultipartUploadResult>".encode())
            return
        parts = self.uploads.pop(query["uploadId"])
        numbers = [int(n) for n in re.findall(rb"<PartNumber>(\d+)</PartNumber>", request)]
        assert numbers == sorted(parts), (numbers, sorted(parts))
        self.objects[path] = b"".join(parts[n] for n in numbers)
        self.completed[query["uploadId"]] = [len(parts[n]) for n in numbers]
        self.reply(200, f"<CompleteMultipartUploadResult><Bucket>assets</Bucket><Key>{path}</Key>"
                        f"<ETag>\"multipart\"</ETag></CompleteMultipartUploadResult>".encode())

    def do_DELETE(self):
        _, query = self.target()
        self.uploads.pop(query.get("uploadId"), None)
        self.reply(204)


class Session:
    def __init__(self, binary, repo, limited=False):
        def limit():
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            resource.setrlimit(resource.RLIMIT_FSIZE, (1024, 1024))
        # Unbuffered: progress and complete lines arrive together, and a line
        # held in a Python buffer would be invisible to select().
        self.child = subprocess.Popen([str(binary)], cwd=repo, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                      preexec_fn=limit if limited else None)
        self.progress = []
        self.maxrss = None
        assert self.request(event="init", operation="download") == {}

    def request(self, **request):
        """Final answer to a request; its `progress` events land in self.progress."""
        self.child.stdin.write(json.dumps(request).encode() + b"\n")
        self.child.stdin.flush()
        self.progress = []
        while True:
            with selectors.DefaultSelector() as selector:
                selector.register(self.child.stdout, selectors.EVENT_READ)
                assert selector.select(timeout=30), "sidecar protocol response timed out"
            line = self.child.stdout.readline()
            assert line, "sidecar exited before response"
            response = json.loads(line)
            if response.get("event") != "progress":
                return response
            assert response["oid"] == request["oid"], response
            self.progress.append(response)

    def download(self, oid=OID, size=len(BLOB)):
        return self.request(event="download", oid=oid, size=size)

    def upload(self, oid, size, path):
        return self.request(event="upload", oid=oid, size=size, path=str(path))

    def close(self):
        self.child.stdin.write(b'{"event":"terminate"}\n')
        self.child.stdin.close()
        stdout, stderr = self.child.stdout.read(), self.child.stderr.read()
        # wait4 instead of communicate: the peak memory of this process alone.
        _, status, usage = os.wait4(self.child.pid, 0)
        self.child.returncode = os.waitstatus_to_exitcode(status)
        self.maxrss = usage.ru_maxrss  # bytes on macOS
        assert self.child.returncode == 0 and not stdout and not stderr, stderr

    def __enter__(self):
        return self

    def __exit__(self, *error):
        if error[0] is None:
            self.close()
        else:
            self.child.kill()
            self.child.communicate()


def check_progress(events, size):
    """`progress` events of a successful transfer: growing, consistent, ending at the size."""
    so_far = 0
    for event in events:
        assert event["bytesSoFar"] > so_far, events
        assert event["bytesSinceLast"] == event["bytesSoFar"] - so_far, events
        so_far = event["bytesSoFar"]
    assert so_far == size, (so_far, size)


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
    git(repo, "config", "lfs.standalonetransferagent", "svode-lfs")
    git(repo, "config", "lfs.customtransfer.svode-lfs.path", str(binary))
    git(repo, "config", "lfs.customtransfer.svode-lfs.concurrent", "true")
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
    assert not list((directory / "lfs/tmp/svode-lfs").iterdir()), "Git LFS must consume the handoff"


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
            first = session.download()
            check_progress(session.progress, len(BLOB))
            second = session.download()
            check_progress(session.progress, len(BLOB))
            assert "error" not in first and "error" not in second
            return first["path"], second["path"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        paths = [p for pair in pool.map(transfer, range(4)) for p in pair]
    assert len(set(paths)) == 8
    for path in paths:
        assert Path(path).is_absolute() and Path(path).read_bytes() == BLOB
    print("PASS same-OID parallel processes, repeated transfer, file survives terminate")

    directory = Path(git(submodule, "rev-parse", "--absolute-git-dir").decode().rstrip("\n"))
    temporary = directory / "lfs/tmp/svode-lfs"
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
            result = session.upload(oid, 8, blob)
            assert "error" not in result
            check_progress(session.progress, 8)
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
    exercise_large(root, binary, submodule)


def slow_progress(events, size):
    """Events of a transfer over the slow fixture: following the bytes, not the S3 parts.
    A step can exceed a MiB when the connection fills its socket buffer at once."""
    check_progress(events, size)
    steps = [event["bytesSinceLast"] for event in events]
    assert len(events) >= size // (2 * MIB), (len(events), size)
    assert max(steps) < PART, max(steps)
    return f"{len(events)} events, largest step {max(steps)} B"


def lfs_progress(log, direction, size):
    """GIT_LFS_PROGRESS lines Git LFS wrote from the agent events: growing to the size
    during the transfer. Git LFS may thin out its own log, so only a few are required."""
    lines = [line.split() for line in log.read_text().splitlines()]
    sent = [int(line[2].split("/")[0]) for line in lines if line[0] == direction]
    assert len(set(sent)) >= 4, (direction, sent)
    assert sent == sorted(sent) and sent[-1] == size, (sent[:5], sent[-5:])
    return f"{len(sent)} lines"


def exercise_large(root, binary, repo):
    """An object of several S3 parts over a slow link: sent in parts, received in chunks,
    `progress` at least every MiB and the object never whole in the agent memory."""
    oid = hashlib.sha256(LARGE).hexdigest()
    key = f"/assets/fixture/{oid[:2]}/{oid[2:4]}/{oid}"
    staged = root / "large upload"
    staged.write_bytes(LARGE)
    S3.rate = 32 * MIB
    try:
        with Session(binary, repo) as session:
            before = set(S3.completed)
            result = session.upload(oid, len(LARGE), staged)
            assert result == {"event": "complete", "oid": oid}, result
            assert S3.objects[key] == LARGE
            [upload] = set(S3.completed) - before
            parts = S3.completed[upload]
            assert len(parts) == 17 and all(size >= PART for size in parts[:-1]), parts
            print(f"PASS upload in {len(parts)} parts: {slow_progress(session.progress, len(LARGE))}")
            response = session.download(oid, len(LARGE))
            assert "error" not in response
            assert Path(response["path"]).read_bytes() == LARGE
            Path(response["path"]).unlink()
            print(f"PASS chunked download: {slow_progress(session.progress, len(LARGE))}")
        # The old agent held the object whole, and twice on download.
        assert session.maxrss < len(LARGE) * 3 // 4, (session.maxrss, len(LARGE))
        print(f"PASS agent peak memory {session.maxrss // MIB} MiB for a {len(LARGE) // MIB} MiB object")

        # Real Git LFS reads the events: its progress log grows in both directions.
        data = LARGE[::-1]
        oid = hashlib.sha256(data).hexdigest()
        git(repo, "config", "lfs.https://fixture.invalid/repo.git/info/lfs.locksverify", "false")
        pointer = git(repo, "lfs", "clean", input=data)
        log = root / "lfs-progress-upload.log"
        git(repo, "lfs", "push", "--object-id", "origin", oid,
            env={**os.environ, "GIT_LFS_PROGRESS": str(log)})
        assert S3.objects[f"/assets/fixture/{oid[:2]}/{oid[2:4]}/{oid}"] == data
        print(f"PASS git lfs push progress: {lfs_progress(log, 'upload', len(data))}")
        log = root / "lfs-progress-download.log"
        received = git(repo, "-c", f"lfs.storage={root / 'large cache'}", "lfs", "smudge",
                       input=pointer, env={**os.environ, "GIT_LFS_PROGRESS": str(log)})
        assert received == data
        print(f"PASS git lfs smudge progress: {lfs_progress(log, 'download', len(data))}")
    finally:
        S3.rate = None


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
