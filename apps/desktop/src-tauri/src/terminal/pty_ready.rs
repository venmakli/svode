//! Waiting for a PTY master that does not block.
//!
//! On Unix the master of every terminal is non-blocking: a `write` blocked
//! on a PTY whose input is full never returns on Linux, not even after the
//! program in it has exited (the write sleeps on room that nothing frees),
//! so the terminal writer could neither give its call a result nor end
//! (DF-365 R2). The writer and the reader wait here instead, for a bounded
//! slice or until the PTY is ready. The ConPTY pipes of Windows stay blocking
//! and never wait here.

#[cfg(unix)]
pub(super) use unix::PtyReady;

/// Nothing to wait on: the PTY master blocks in its reads and writes.
#[cfg(not(unix))]
pub(super) enum PtyReady {}

#[cfg(not(unix))]
impl PtyReady {
    pub(super) fn wait_writable(&self, _slice: std::time::Duration) -> std::io::Result<()> {
        match *self {}
    }

    pub(super) fn wait_readable(&self) -> std::io::Result<()> {
        match *self {}
    }
}

#[cfg(unix)]
mod unix {
    use std::io;
    use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};
    use std::time::Duration;

    use portable_pty::MasterPty;

    use crate::error::AppError;

    /// A descriptor of a non-blocking PTY master to wait on.
    pub(in crate::terminal) struct PtyReady(OwnedFd);

    impl PtyReady {
        /// Makes the master of `master` non-blocking for every descriptor
        /// that shares it (its reader and writer too) and keeps one to wait on.
        pub(in crate::terminal) fn of(master: &dyn MasterPty) -> Result<Self, AppError> {
            let fd = master
                .as_raw_fd()
                .ok_or_else(|| AppError::General("The PTY master has no descriptor".to_string()))?;
            // SAFETY: `master` owns `fd` and outlives this borrow.
            let fd = unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
            // SAFETY: plain fcntl calls on a descriptor owned here.
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
            if flags == -1
                || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                    == -1
            {
                return Err(io::Error::last_os_error().into());
            }
            Ok(Self(fd))
        }

        /// Returns once the PTY may take input or after `slice`; fails as a
        /// write into a closed PTY does when no program can read it any more.
        pub(in crate::terminal) fn wait_writable(&self, slice: Duration) -> io::Result<()> {
            let timeout = libc::c_int::try_from(slice.as_millis()).unwrap_or(libc::c_int::MAX);
            let revents = self.poll(libc::POLLOUT, timeout)?;
            if revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(io::Error::from_raw_os_error(libc::EIO));
            }
            Ok(())
        }

        /// Returns once the PTY has output or has hung up, which the next
        /// read reports.
        pub(in crate::terminal) fn wait_readable(&self) -> io::Result<()> {
            self.poll(libc::POLLIN, -1).map(|_| ())
        }

        /// The events of the master within `timeout` ms; none if a signal
        /// interrupts the wait, so the caller retries.
        fn poll(&self, events: libc::c_short, timeout: libc::c_int) -> io::Result<libc::c_short> {
            let mut entry = libc::pollfd {
                fd: self.0.as_raw_fd(),
                events,
                revents: 0,
            };
            // SAFETY: one valid `pollfd` for the duration of the call.
            if unsafe { libc::poll(&mut entry, 1, timeout) } == -1 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    return Ok(0);
                }
                return Err(error);
            }
            Ok(entry.revents)
        }
    }
}
