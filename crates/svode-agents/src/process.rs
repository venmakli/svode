//! Child-process helpers shared by diagnostics and agent connections.

use std::io;

use tokio::process::{Child, Command};

#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// Keeps a console window from flashing up for a child of a GUI host.
pub(crate) fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Lossy UTF-8 of at most `limit` bytes, trimmed.
pub(crate) fn bounded_text(bytes: &[u8], limit: usize) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(limit)])
        .trim()
        .to_string()
}

/// A child process together with the descendants it starts: the leader of
/// its own process group on Unix, in a Job Object that ends its processes
/// when closed on Windows. Killing or dropping the tree ends all of them,
/// except a process that left the group or Job itself (DF-218 R1, R6).
pub(crate) struct ProcessTree {
    child: Child,
    #[cfg(windows)]
    job: job::Job,
}

impl ProcessTree {
    /// Spawns `command` as the root of a new tree, without a console window
    /// on Windows.
    pub(crate) fn spawn(command: &mut Command) -> io::Result<Self> {
        command.kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
            Ok(Self {
                child: command.spawn()?,
            })
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

            // Suspended until it is in the Job, so nothing it starts escapes.
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            let mut child = command.spawn()?;
            match job::Job::new().and_then(|job| {
                job.assign(&child)?;
                job::resume(&child)?;
                Ok(job)
            }) {
                Ok(job) => Ok(Self { child, job }),
                Err(error) => {
                    let _ = child.start_kill();
                    Err(error)
                }
            }
        }
    }

    pub(crate) fn child(&mut self) -> &mut Child {
        &mut self.child
    }

    /// Kills every process of the tree and waits for the root.
    pub(crate) async fn kill(mut self) {
        self.kill_descendants();
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }

    /// Kills the group or Job while the root's id still names it: an
    /// unreaped root keeps its pid, and with it its group, from reuse.
    fn kill_descendants(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            // SAFETY: `killpg` only sends a signal; the group exists while
            // its unreaped leader does.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        self.job.terminate();
    }
}

impl Drop for ProcessTree {
    /// The root ends through `kill_on_drop`, the rest of a Job when its
    /// handle closes, the rest of a group here.
    fn drop(&mut self) {
        #[cfg(unix)]
        self.kill_descendants();
    }
}

#[cfg(windows)]
mod job {
    use std::io;

    use tokio::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    /// A Job Object that ends its processes when its handle closes.
    pub(super) struct Job(HANDLE);

    // SAFETY: a kernel object handle may be used and closed from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub(super) fn new() -> io::Result<Self> {
            // SAFETY: null attributes and name create an unnamed Job.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `limits` is the structure of this information class and
            // outlives the call.
            let set = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if set == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        pub(super) fn assign(&self, child: &Child) -> io::Result<()> {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("the process has exited"))?;
            // SAFETY: both handles are open for the duration of the call.
            if unsafe { AssignProcessToJobObject(self.0, process as HANDLE) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub(super) fn terminate(&self) {
            // SAFETY: the handle is open until drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }

        #[cfg(test)]
        pub(super) fn processes(&self) -> Vec<u32> {
            use windows_sys::Win32::System::JobObjects::{
                JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectBasicProcessIdList,
                QueryInformationJobObject,
            };

            // Room for the header and 64 ids, aligned for the structure.
            let mut buffer = [0usize; 66];
            // SAFETY: the buffer is large enough and aligned for the list.
            unsafe {
                let list = buffer
                    .as_mut_ptr()
                    .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
                if QueryInformationJobObject(
                    self.0,
                    JobObjectBasicProcessIdList,
                    list.cast(),
                    size_of_val(&buffer) as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Vec::new();
                }
                let count = (*list).NumberOfProcessIdsInList as usize;
                let ids = (&raw const (*list).ProcessIdList).cast::<usize>();
                (0..count).map(|index| *ids.add(index) as u32).collect()
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is owned and closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// Resumes the threads of a process started suspended.
    pub(super) fn resume(child: &Child) -> io::Result<()> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("the process has exited"))?;
        // SAFETY: the snapshot handle is checked and closed below; each
        // thread handle is checked and closed after use.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut entry = THREADENTRY32 {
                dwSize: size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut resumed = false;
            let mut more = Thread32First(snapshot, &mut entry) != 0;
            while more {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        resumed |= ResumeThread(thread) != u32::MAX;
                        CloseHandle(thread);
                    }
                }
                more = Thread32Next(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            if resumed {
                Ok(())
            } else {
                Err(io::Error::other("the process did not resume"))
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use super::*;

    /// Whether process `pid` still exists, a zombie included.
    #[cfg(unix)]
    pub(crate) fn exists(pid: u32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        let signalled = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        signalled || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(windows)]
    fn exists(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };

        // SAFETY: the handle is checked and closed after the wait.
        unsafe {
            let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if process.is_null() {
                return false;
            }
            let running = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
            CloseHandle(process);
            running
        }
    }

    /// Whether process `pid` is gone within a few seconds, for a descendant
    /// that its new parent reaps.
    pub(crate) async fn ends(pid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while exists(pid) {
            if Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        true
    }

    /// A shell that leaves a `sleep` running in the background, with the
    /// pid of the `sleep` from its first stdout line.
    #[cfg(unix)]
    async fn tree_with_descendant() -> (ProcessTree, Vec<u32>) {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 600 & echo $!; wait"])
            .stdout(Stdio::piped());
        let mut tree = ProcessTree::spawn(&mut command).unwrap();
        let stdout = tree.child().stdout.take().unwrap();
        let line = BufReader::new(stdout).lines().next_line().await.unwrap();
        (tree, vec![line.unwrap().trim().parse().unwrap()])
    }

    /// A shell that keeps a `ping` of its own running, with the pids of the
    /// Job once the `ping` is in it.
    #[cfg(windows)]
    async fn tree_with_descendant() -> (ProcessTree, Vec<u32>) {
        let mut command = Command::new("cmd");
        command
            .args(["/d", "/c", "ping -n 600 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        let tree = ProcessTree::spawn(&mut command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let processes = tree.job.processes();
            if processes.len() >= 2 {
                return (tree, processes);
            }
            assert!(Instant::now() < deadline, "the shell starts its ping");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// A shell that leaves a `sleep` running without its pipes and exits,
    /// with the pid of the `sleep`; the root is not waited for yet.
    #[cfg(unix)]
    async fn exited_root_with_descendant() -> (ProcessTree, Vec<u32>) {
        use tokio::io::AsyncReadExt;

        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 600 </dev/null >/dev/null 2>&1 & echo $!"])
            .stdout(Stdio::piped());
        let mut tree = ProcessTree::spawn(&mut command).unwrap();
        let mut output = String::new();
        // EOF: the shell has exited.
        let mut stdout = tree.child().stdout.take().unwrap();
        stdout.read_to_string(&mut output).await.unwrap();
        (tree, vec![output.trim().parse().unwrap()])
    }

    /// A shell that starts a `ping` of its own and exits, with the pid of
    /// the `ping` left in the Job.
    #[cfg(windows)]
    async fn exited_root_with_descendant() -> (ProcessTree, Vec<u32>) {
        let mut command = Command::new("cmd");
        command
            .args(["/d", "/c", "start /b ping -n 600 127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        let mut tree = ProcessTree::spawn(&mut command).unwrap();
        let root = tree.child().id().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let processes = tree.job.processes();
            if !processes.is_empty() && !processes.contains(&root) {
                return (tree, processes);
            }
            assert!(Instant::now() < deadline, "the shell exits after its ping");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn killing_a_tree_whose_root_exited_ends_its_descendants_and_waits_for_the_root() {
        let (mut tree, descendants) = exited_root_with_descendant().await;
        let root = tree.child().id().unwrap();
        tree.kill().await;
        assert!(!exists(root));
        for pid in descendants {
            assert!(ends(pid).await, "process {pid} of the tree still runs");
        }
    }

    #[tokio::test]
    async fn killing_a_tree_ends_its_descendants_and_waits_for_the_root() {
        let (mut tree, descendants) = tree_with_descendant().await;
        let root = tree.child().id().unwrap();
        tree.kill().await;
        // Reaped by the kill itself, not left a zombie.
        assert!(!exists(root));
        for pid in descendants {
            assert!(ends(pid).await, "process {pid} of the tree still runs");
        }
    }

    #[tokio::test]
    async fn dropping_a_tree_ends_its_descendants() {
        let (tree, descendants) = tree_with_descendant().await;
        drop(tree);
        for pid in descendants {
            assert!(ends(pid).await, "process {pid} of the tree still runs");
        }
    }

    #[tokio::test]
    async fn a_command_that_cannot_start_leaves_no_tree() {
        let mut command = Command::new("svode-no-such-agent");
        assert!(ProcessTree::spawn(&mut command).is_err());
    }
}
