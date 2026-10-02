//! Process ownership for local workers. Windows workers enter a kill-on-close
//! Job Object before any application code is allowed to run.
use std::io;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};

pub struct ManagedChild {
    child: Child,
    ownership: Option<ProcessOwnership>,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

impl ManagedChild {
    fn new(mut child: Child, ownership: ProcessOwnership) -> Self {
        Self {
            stdin: child.stdin.take(),
            stdout: child.stdout.take(),
            stderr: child.stderr.take(),
            child,
            ownership: Some(ownership),
        }
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            // A completed primary worker cannot leave descendants behind.
            drop(self.ownership.take());
        }
        Ok(status)
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        drop(self.stdin.take());
        let status = self.child.wait()?;
        drop(self.ownership.take());
        Ok(status)
    }

    pub fn kill(&mut self) -> io::Result<()> {
        match &self.ownership {
            Some(ownership) => ownership.kill(),
            None => self.child.kill(),
        }
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.stderr.take()
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.stdin.take()
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        // On Windows closing the parent's sole Job handle kills the full tree,
        // even when the parent exits without executing this Rust destructor.
        drop(self.ownership.take());
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum ProcessOwnership {
    #[cfg(windows)]
    Job(windows::Job),
    #[cfg(unix)]
    Group(unix::ProcessGroup),
}

impl ProcessOwnership {
    fn kill(&self) -> io::Result<()> {
        match self {
            #[cfg(windows)]
            Self::Job(job) => job.kill(),
            #[cfg(unix)]
            Self::Group(group) => group.kill(),
        }
    }
}

/// Spawn a worker with ownership of its descendants.
///
/// Windows forces CREATE_NO_WINDOW and starts suspended; Job assignment must
/// succeed before its initial thread is resumed. Unsupported/nested Job policy
/// errors fail closed, without an unguarded fallback. Arguments, environment,
/// directory and stdio are still configured by the caller's Command.
///
/// Unix creates a separate process group and terminates that group on normal
/// Drop/kill. Unlike Windows, forced parent termination is not covered on Unix.
pub fn spawn_guarded(command: &mut Command) -> io::Result<ManagedChild> {
    #[cfg(windows)]
    {
        windows::spawn(command)
    }
    #[cfg(unix)]
    {
        unix::spawn(command)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = command;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "guarded worker processes are unsupported on this platform",
        ))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
    };

    pub(super) struct Job(OwnedHandle);

    impl Job {
        fn new() -> io::Result<Self> {
            // NULL security attributes make this unnamed handle non-inheritable.
            // Descendants inherit membership, never the Job handle itself.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        fn handle(&self) -> HANDLE {
            self.0.as_raw_handle()
        }

        pub(super) fn kill(&self) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    pub(super) fn spawn(command: &mut Command) -> io::Result<ManagedChild> {
        let job = Job::new()?;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let spawned = command.spawn();
        // Do not leave a reused Command configured to suspend an unguarded spawn.
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = spawned?;
        let prepared = (|| {
            if unsafe { AssignProcessToJobObject(job.handle(), child.as_raw_handle()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            resume_initial_thread(child.id())
        })();
        if let Err(error) = prepared {
            // Assignment/resume errors must not leak a suspended process.
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(ManagedChild::new(child, ProcessOwnership::Job(job)))
    }

    fn resume_initial_thread(process_id: u32) -> io::Result<()> {
        // std::process::Child owns the process handle but not the initial thread
        // handle. Toolhelp/OpenThread/ResumeThread are documented Win32 APIs.
        // CREATE_SUSPENDED has not run the initial thread, so require exactly
        // one matching thread; any unexpected topology fails closed.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut thread_id = None;
        loop {
            if entry.th32OwnerProcessID == process_id {
                if thread_id.replace(entry.th32ThreadID).is_some() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "suspended worker unexpectedly has multiple initial threads",
                    ));
                }
            }
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                    return Err(error);
                }
                break;
            }
        }
        let thread_id = thread_id.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "suspended worker thread not found")
        })?;
        let thread = unsafe {
            OpenThread(
                THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                0,
                thread_id,
            )
        };
        if thread.is_null() {
            return Err(io::Error::last_os_error());
        }
        let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
        if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != process_id {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "initial thread no longer belongs to the guarded worker",
            ));
        }
        let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
        if previous == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        if previous != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "guarded worker did not have exactly one initial suspension",
            ));
        }
        Ok(())
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::process::CommandExt;

    pub(super) struct ProcessGroup(libc::pid_t);

    impl ProcessGroup {
        pub(super) fn kill(&self) -> io::Result<()> {
            if unsafe { libc::kill(-self.0, libc::SIGKILL) } == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
            Ok(())
        }
    }

    impl Drop for ProcessGroup {
        fn drop(&mut self) {
            let _ = self.kill();
        }
    }

    pub(super) fn spawn(command: &mut Command) -> io::Result<ManagedChild> {
        command.process_group(0);
        let mut child = command.spawn()?;
        let group_id = match libc::pid_t::try_from(child.id()) {
            Ok(group_id) => group_id,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "worker PID exceeds pid_t",
                ));
            }
        };
        Ok(ManagedChild::new(
            child,
            ProcessOwnership::Group(ProcessGroup(group_id)),
        ))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Read;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    const FIXTURE_ROLE: &str = "ASSET_STUDIO_PROCESS_GUARD_FIXTURE";
    const FIXTURE_DIR: &str = "ASSET_STUDIO_PROCESS_GUARD_TEST_DIR";
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempEvidence {
        base: PathBuf,
        root: PathBuf,
    }
    impl TempEvidence {
        fn new() -> Self {
            let base = std::env::temp_dir().canonicalize().unwrap();
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let root = base.join(format!(
                "asset studio guard-{}-{timestamp}-{serial}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            Self { base, root }
        }
    }
    impl Drop for TempEvidence {
        fn drop(&mut self) {
            let Ok(metadata) = fs::symlink_metadata(&self.root) else {
                return;
            };
            if metadata.file_attributes() & 0x400 != 0 {
                return;
            }
            let Ok(resolved) = self.root.canonicalize() else {
                return;
            };
            if resolved.parent() == Some(self.base.as_path())
                && resolved.file_name() == self.root.file_name()
            {
                let _ = fs::remove_dir_all(resolved);
            }
        }
    }

    struct FixtureParent(Child);
    impl Drop for FixtureParent {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn fixture_command(name: &str, role: &str, directory: &Path) -> Command {
        let qualified = format!("{}::{name}", module_path!());
        let name = qualified.split_once("::").unwrap().1;
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", name, "--nocapture"])
            .env(FIXTURE_ROLE, role)
            .env(FIXTURE_DIR, directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        command
    }

    fn wait_marker(path: &Path) -> String {
        let started = Instant::now();
        loop {
            if let Ok(contents) = fs::read_to_string(path) {
                if !contents.is_empty() {
                    return contents;
                }
            }
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "fixture marker was not written: {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn process_handle(pid: u32) -> OwnedHandle {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(
            !handle.is_null(),
            "cannot open fixture PID {pid}: {}",
            io::Error::last_os_error()
        );
        unsafe { OwnedHandle::from_raw_handle(handle) }
    }

    fn assert_exited(handle: &OwnedHandle) {
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 10_000) },
            WAIT_OBJECT_0,
            "owned worker/descendant survived termination"
        );
    }

    #[test]
    fn forced_parent_exit_terminates_worker_and_descendant() {
        let evidence = TempEvidence::new();
        // An ordinary Child is intentional: terminate the parent without Drop.
        let mut command = fixture_command("parent_fixture", "parent", &evidence.root);
        let mut parent = FixtureParent(command.spawn().unwrap());
        let pids = wait_marker(&evidence.root.join("parent.ready"));
        let pids: Vec<u32> = pids
            .split_whitespace()
            .map(|pid| pid.parse().unwrap())
            .collect();
        assert_eq!(pids.len(), 2);
        let worker = process_handle(pids[0]);
        let descendant = process_handle(pids[1]);
        parent.0.kill().unwrap();
        parent.0.wait().unwrap();
        assert_exited(&worker);
        assert_exited(&descendant);
    }

    #[test]
    fn dropping_guard_terminates_worker_and_descendant() {
        let evidence = TempEvidence::new();
        let mut command = fixture_command("worker_fixture", "worker", &evidence.root);
        let child = spawn_guarded(&mut command).unwrap();
        let worker = process_handle(child.id());
        let descendant_pid = wait_marker(&evidence.root.join("descendant.ready"))
            .trim()
            .parse()
            .unwrap();
        let descendant = process_handle(descendant_pid);
        drop(child);
        assert_exited(&worker);
        assert_exited(&descendant);
    }

    #[test]
    fn explicit_kill_terminates_worker_and_descendant() {
        let evidence = TempEvidence::new();
        let mut command = fixture_command("worker_fixture", "worker", &evidence.root);
        let mut child = spawn_guarded(&mut command).unwrap();
        let worker = process_handle(child.id());
        let descendant_pid = wait_marker(&evidence.root.join("descendant.ready"))
            .trim()
            .parse()
            .unwrap();
        let descendant = process_handle(descendant_pid);
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        assert_exited(&worker);
        assert_exited(&descendant);
    }

    #[test]
    fn wait_and_captured_stdout_preserve_command_behavior() {
        let evidence = TempEvidence::new();
        let mut command = fixture_command("quick_fixture", "quick", &evidence.root);
        command.stdout(Stdio::piped()).stdin(Stdio::piped());
        let mut child = spawn_guarded(&mut command).unwrap();
        let mut stdout = child.take_stdout().unwrap();
        assert!(child.wait().unwrap().success());
        let mut output = String::new();
        stdout.read_to_string(&mut output).unwrap();
        assert!(output.contains("GUARDED_WORKER_STDOUT"));
        assert!(child.try_wait().unwrap().unwrap().success());
    }

    #[test]
    #[ignore = "subprocess fixture, only the ownership tests invoke it"]
    fn parent_fixture() {
        if std::env::var(FIXTURE_ROLE).as_deref() != Ok("parent") {
            return;
        }
        let directory = PathBuf::from(std::env::var_os(FIXTURE_DIR).unwrap());
        let mut command = fixture_command("worker_fixture", "worker", &directory);
        let child = spawn_guarded(&mut command).unwrap();
        let descendant_pid = wait_marker(&directory.join("descendant.ready"));
        fs::write(
            directory.join("parent.ready"),
            format!("{} {}", child.id(), descendant_pid.trim()),
        )
        .unwrap();
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    #[ignore = "subprocess fixture, only the ownership tests invoke it"]
    fn worker_fixture() {
        if std::env::var(FIXTURE_ROLE).as_deref() != Ok("worker") {
            return;
        }
        let directory = PathBuf::from(std::env::var_os(FIXTURE_DIR).unwrap());
        // This descendant is not separately guarded: Windows Job inheritance
        // must cover it automatically after the initial suspended assignment.
        let mut command = fixture_command("descendant_fixture", "descendant", &directory);
        let _descendant = command.spawn().unwrap();
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    #[ignore = "subprocess fixture, only the ownership tests invoke it"]
    fn descendant_fixture() {
        if std::env::var(FIXTURE_ROLE).as_deref() != Ok("descendant") {
            return;
        }
        let directory = PathBuf::from(std::env::var_os(FIXTURE_DIR).unwrap());
        fs::write(
            directory.join("descendant.ready"),
            std::process::id().to_string(),
        )
        .unwrap();
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    #[ignore = "subprocess fixture, only the ownership tests invoke it"]
    fn quick_fixture() {
        if std::env::var(FIXTURE_ROLE).as_deref() != Ok("quick") {
            return;
        }
        println!("GUARDED_WORKER_STDOUT");
    }
}
