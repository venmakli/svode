//! Child-process helpers shared by diagnostics and agent connections.

use std::io;
use std::sync::{Arc, Weak};

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
    signal: Arc<TreeSignal>,
}

/// Kills every process of one tree at once: its group, while the unreaped
/// root's pid still names it, on Unix; its Job on Windows.
struct TreeSignal {
    /// The root's pid until the root may be reaped, so that a reused pid is
    /// never signalled. Held only for the signal itself.
    #[cfg(unix)]
    group: std::sync::Mutex<Option<u32>>,
    #[cfg(windows)]
    job: job::Job,
}

impl TreeSignal {
    fn kill(&self) {
        #[cfg(unix)]
        if let Some(group) = *self.group() {
            unix::kill_group(group);
        }
        #[cfg(windows)]
        self.job.terminate();
    }

    /// Kills the group one last time before the root may be reaped; later
    /// kills do nothing.
    #[cfg(unix)]
    fn release(&self) {
        if let Some(group) = self.group().take() {
            unix::kill_group(group);
        }
    }

    /// The group even after a panic elsewhere, for a host that stops its
    /// agents on that path.
    #[cfg(unix)]
    fn group(&self) -> std::sync::MutexGuard<'_, Option<u32>> {
        self.group
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Kills a tree without its owner: synchronous, without waiting for any
/// process and without a lock a task holds across an await, so a host can
/// stop its agents from a thread that must not wait (DF-365 R4). It does
/// nothing once the tree is gone.
#[derive(Clone)]
pub(crate) struct TreeStop(Weak<TreeSignal>);

impl TreeStop {
    /// Sends the kill to the root and its descendants and returns at once;
    /// the owner still collects the root.
    pub(crate) fn kill(&self) {
        if let Some(signal) = self.0.upgrade() {
            signal.kill();
        }
    }
}

impl ProcessTree {
    /// Spawns `command` as the root of a new tree, without a console window
    /// on Windows.
    pub(crate) fn spawn(command: &mut Command) -> io::Result<Self> {
        command.kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
            let child = command.spawn()?;
            let signal = Arc::new(TreeSignal {
                group: std::sync::Mutex::new(child.id()),
            });
            Ok(Self { child, signal })
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
                Ok(job) => Ok(Self {
                    child,
                    signal: Arc::new(TreeSignal { job }),
                }),
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

    /// A handle that kills this tree without its owner.
    pub(crate) fn stop(&self) -> TreeStop {
        TreeStop(Arc::downgrade(&self.signal))
    }

    /// Resolves once the root has exited, even while a descendant holds its
    /// pipes (DF-218 R2). It never collects the root's status, so on Unix
    /// the root stays unreaped and keeps naming its group until `kill`; on
    /// Windows it holds a duplicate of the root's handle until the root
    /// exits. A root already collected is never reported.
    pub(crate) fn root_exit(&self) -> impl Future<Output = ()> + Send + 'static {
        #[cfg(unix)]
        let root = self.child.id();
        #[cfg(windows)]
        let root = self.child.raw_handle().and_then(|raw| {
            // SAFETY: the handle stays open while `self.child` lives, which
            // outlasts this call.
            unsafe { std::os::windows::io::BorrowedHandle::borrow_raw(raw) }
                .try_clone_to_owned()
                .ok()
        });
        async move {
            match root {
                #[cfg(unix)]
                Some(pid) => unix::exited(pid).await,
                #[cfg(windows)]
                Some(handle) => job::exited(handle).await,
                None => std::future::pending().await,
            }
        }
    }

    /// Kills every process of the tree and waits for the root.
    pub(crate) async fn kill(mut self) {
        self.kill_descendants();
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }

    /// Kills the group or Job while the root's id still names it: an
    /// unreaped root keeps its pid, and with it its group, from reuse. The
    /// root is reaped only after this, by `kill` or `kill_on_drop`.
    fn kill_descendants(&mut self) {
        #[cfg(unix)]
        self.signal.release();
        #[cfg(windows)]
        self.signal.kill();
    }
}

impl Drop for ProcessTree {
    /// The root ends through `kill_on_drop`, the rest of a Job when its
    /// last handle closes, the rest of a group here.
    fn drop(&mut self) {
        #[cfg(unix)]
        self.kill_descendants();
    }
}

#[cfg(unix)]
mod unix {
    use std::io;

    use tokio::signal::unix::{SignalKind, signal};

    /// Kills every process of group `group`.
    pub(super) fn kill_group(group: u32) {
        // SAFETY: `killpg` only sends a signal; the group exists while its
        // unreaped leader does.
        unsafe {
            libc::killpg(group as libc::pid_t, libc::SIGKILL);
        }
    }

    /// Waits for child `pid` to exit, looking again on every SIGCHLD.
    pub(super) async fn exited(pid: u32) {
        // Subscribed before the first look, so a later exit is heard.
        let Ok(mut children) = signal(SignalKind::child()) else {
            return std::future::pending().await;
        };
        while !has_exited(pid) {
            if children.recv().await.is_none() {
                return std::future::pending().await;
            }
        }
    }

    /// Whether child `pid` has exited, leaving it a zombie to be collected.
    /// A pid that is no longer a child was collected already.
    fn has_exited(pid: u32) -> bool {
        loop {
            // SAFETY: a zeroed `siginfo_t` is valid, and `waitid` only writes
            // it; `WNOWAIT` leaves the child waitable.
            let (result, info) = unsafe {
                let mut info: libc::siginfo_t = std::mem::zeroed();
                let result = libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                );
                (result, info)
            };
            if result == 0 {
                // SAFETY: `waitid` filled the child fields or left them zero.
                return unsafe { info.si_pid() } != 0;
            }
            match io::Error::last_os_error().raw_os_error() {
                Some(libc::EINTR) => continue,
                error => return error == Some(libc::ECHILD),
            }
        }
    }
}

#[cfg(windows)]
mod job {
    use std::io;
    use std::os::windows::io::{AsRawHandle, OwnedHandle};

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
    // SAFETY: `terminate` and `processes` may run on one handle from several
    // threads at once.
    unsafe impl Sync for Job {}

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

    /// Waits for the process of `root` to exit, then closes the handle.
    pub(super) async fn exited(root: OwnedHandle) {
        use windows_sys::Win32::System::Threading::{INFINITE, WaitForSingleObject};

        let _ = tokio::task::spawn_blocking(move || {
            // SAFETY: `root` keeps the handle open until it drops after the
            // wait.
            unsafe {
                WaitForSingleObject(root.as_raw_handle() as HANDLE, INFINITE);
            }
        })
        .await;
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

    /// Whether process group `group` is gone within a few seconds.
    #[cfg(unix)]
    pub(crate) async fn group_ends(group: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // SAFETY: signal 0 only checks that the group has a process.
            let signalled = unsafe { libc::killpg(group as libc::pid_t, 0) } == 0;
            if !signalled && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                return true;
            }
            if Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
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
            let processes = tree.signal.job.processes();
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
            let processes = tree.signal.job.processes();
            if !processes.is_empty() && !processes.contains(&root) {
                return (tree, processes);
            }
            assert!(Instant::now() < deadline, "the shell exits after its ping");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// A shell that leaves a silent `sleep` holding its stdin and stdout and
    /// exits, with the pid of the `sleep`; the pipes stay with the root's
    /// handle, open at both ends.
    #[cfg(unix)]
    async fn exiting_root_with_descendant_on_its_pipes() -> (ProcessTree, Vec<u32>) {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut command = Command::new("/bin/sh");
        command
            // An asynchronous list reads /dev/null unless given fd 3.
            .args(["-c", "exec 3<&0; sleep 600 <&3 3<&- & echo $!"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut tree = ProcessTree::spawn(&mut command).unwrap();
        let mut stdout = BufReader::new(tree.child().stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).await.unwrap();
        tree.child().stdout = Some(stdout.into_inner());
        (tree, vec![line.trim().parse().unwrap()])
    }

    /// A shell that starts a `ping` on its pipes and exits, with the pid of
    /// the `ping` once it is in the Job.
    #[cfg(windows)]
    async fn exiting_root_with_descendant_on_its_pipes() -> (ProcessTree, Vec<u32>) {
        let mut command = Command::new("cmd");
        command
            .args(["/d", "/c", "start /b ping -n 600 127.0.0.1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut tree = ProcessTree::spawn(&mut command).unwrap();
        let root = tree.child().id().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let descendants: Vec<u32> = tree
                .signal
                .job
                .processes()
                .into_iter()
                .filter(|pid| *pid != root)
                .collect();
            if !descendants.is_empty() {
                return (tree, descendants);
            }
            assert!(Instant::now() < deadline, "the shell starts its ping");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn the_exit_of_a_root_whose_descendant_holds_its_pipes_is_heard_before_it_is_collected() {
        let (mut tree, descendants) = exiting_root_with_descendant_on_its_pipes().await;
        let root = tree.child().id().unwrap();
        tokio::time::timeout(Duration::from_secs(5), tree.root_exit())
            .await
            .expect("the exit of the root is heard");
        // Still a zombie, so its pid keeps naming its group until the kill.
        #[cfg(unix)]
        assert!(exists(root));
        for pid in &descendants {
            assert!(exists(*pid), "process {pid} keeps the pipes open");
        }
        tree.kill().await;
        assert!(!exists(root));
        for pid in descendants {
            assert!(ends(pid).await, "process {pid} of the tree still runs");
        }
    }

    #[tokio::test]
    async fn a_running_root_is_not_heard_as_exited() {
        let (tree, _) = tree_with_descendant().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(300), tree.root_exit())
                .await
                .is_err()
        );
        tree.kill().await;
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
    async fn a_stop_ends_the_whole_tree_at_once_while_its_owner_waits() {
        let (mut tree, descendants) = tree_with_descendant().await;
        let root = tree.child().id().unwrap();
        tree.stop().kill();
        tokio::time::timeout(Duration::from_secs(5), tree.root_exit())
            .await
            .expect("the root ends");
        for pid in &descendants {
            assert!(ends(*pid).await, "process {pid} of the tree still runs");
        }
        // Not collected by the stop: still a zombie for its owner.
        #[cfg(unix)]
        assert!(exists(root));
        tree.kill().await;
        assert!(!exists(root));
    }

    #[tokio::test]
    async fn a_stop_does_nothing_once_its_tree_is_gone() {
        let (tree, _) = tree_with_descendant().await;
        let stop = tree.stop();
        tree.kill().await;
        assert!(stop.0.upgrade().is_none());
        stop.kill();
    }

    #[tokio::test]
    async fn a_command_that_cannot_start_leaves_no_tree() {
        let mut command = Command::new("svode-no-such-agent");
        assert!(ProcessTree::spawn(&mut command).is_err());
    }
}
