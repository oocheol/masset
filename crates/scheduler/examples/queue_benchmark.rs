//! Native timing/overlap evidence for the scheduler, with deterministic local work.
//! This benchmark does not simulate a provider or claim Blender throughput.

use anyhow::{bail, Context, Result};
use asset_core::models::{Job, JobProgress, JobResource, JobStatus};
use asset_scheduler::{ResourceLimits, SchedulerStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::time::Instant;

const JOB_COUNT: usize = 6;
const BUFFER_BYTES: usize = 2 * 1024 * 1024;
const HASH_PASSES: usize = 64;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Interval {
    id: String,
    started_us: u128,
    finished_us: u128,
    output_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunResult {
    process_id: u32,
    wall_ms: f64,
    process_cpu_seconds: Option<f64>,
    peak_process_working_set_bytes: Option<u64>,
    peak_active_jobs: usize,
    peak_reserved_ram_mb: u64,
    peak_actual_input_buffers_bytes: usize,
    completed_jobs: usize,
    confirmed_overlap: bool,
    intervals: Vec<Interval>,
}

#[derive(Default)]
struct ProcessMetrics {
    cpu_seconds: Option<f64>,
    peak_working_set: Option<u64>,
}

#[cfg(windows)]
fn process_metrics() -> ProcessMetrics {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct MemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_nonpaged: usize,
        quota_nonpaged: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut MemoryCounters,
            size: u32,
        ) -> i32;
    }
    let ticks = |t: &FileTime| (u64::from(t.high) << 32) | u64::from(t.low);
    let mut creation = FileTime::default();
    let mut exit = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    let mut counters = MemoryCounters {
        cb: std::mem::size_of::<MemoryCounters>() as u32,
        ..MemoryCounters::default()
    };
    let counter_size = counters.cb;
    // Read-only process metrics for this benchmark's own process.
    unsafe {
        let process = GetCurrentProcess();
        let cpu_ok =
            GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        let memory_ok = GetProcessMemoryInfo(process, &mut counters, counter_size) != 0;
        ProcessMetrics {
            cpu_seconds: cpu_ok.then(|| (ticks(&kernel) + ticks(&user)) as f64 / 10_000_000.0),
            peak_working_set: memory_ok.then_some(counters.peak_working_set as u64),
        }
    }
}

#[cfg(target_os = "macos")]
fn process_metrics() -> ProcessMetrics {
    extern "C" {
        fn clock() -> u64;
    }
    // Darwin clock() uses CLOCKS_PER_SEC = 1,000,000. Memory remains unmeasured.
    let ticks = unsafe { clock() };
    ProcessMetrics {
        cpu_seconds: (ticks != u64::MAX).then_some(ticks as f64 / 1_000_000.0),
        peak_working_set: None,
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn process_metrics() -> ProcessMetrics {
    ProcessMetrics::default()
}

fn make_job(index: usize) -> Job {
    let mut payload = BTreeMap::new();
    payload.insert(
        "resources".into(),
        json!({"ramMb":16,"cpuThreads":1,"gpuMb":0,"diskWeight":0}),
    );
    payload.insert("inputByte".into(), json!(index as u8));
    Job {
        id: format!("hash-{index}"),
        project_id: "native-scheduler-benchmark".into(),
        asset_id: None,
        kind: "sha256_benchmark".into(),
        label: format!("local hash {index}"),
        status: JobStatus::Pending,
        dependencies: vec![],
        resource: JobResource::Cpu,
        attempts: 0,
        created_at: chrono::Utc::now().to_rfc3339(),
        started_at: None,
        finished_at: None,
        error: None,
        progress: JobProgress {
            stage: "queued".into(),
            completed: None,
            total: None,
        },
        payload,
        cache_key: None,
    }
}

fn run(concurrency: usize) -> Result<RunResult> {
    let store = Arc::new(SchedulerStore::open(Path::new(":memory:"))?);
    store.enqueue_many((0..JOB_COUNT).map(make_job).collect())?;
    let limits = ResourceLimits {
        cpu_jobs: concurrency,
        cpu_threads: concurrency as u32,
        ..ResourceLimits::default()
    };
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let buffers = Arc::new(AtomicUsize::new(0));
    let peak_buffers = Arc::new(AtomicUsize::new(0));
    let before = process_metrics();
    let began = Instant::now();
    let mut intervals = Vec::new();
    let mut peak_reserved_ram_mb = 0;
    while intervals.len() < JOB_COUNT {
        let claimed = store.claim_ready(&limits)?;
        if claimed.is_empty() {
            bail!("benchmark queue stalled before all jobs completed")
        }
        peak_reserved_ram_mb = peak_reserved_ram_mb.max(store.running_resources()?.ram_mb);
        let barrier = Arc::new(Barrier::new(claimed.len()));
        let handles: Vec<_> = claimed
            .into_iter()
            .map(|job| {
                let store = store.clone();
                let active = active.clone();
                let peak = peak.clone();
                let buffers = buffers.clone();
                let peak_buffers = peak_buffers.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || -> Result<Interval> {
                    let input_byte = job
                        .payload
                        .get("inputByte")
                        .and_then(Value::as_u64)
                        .unwrap() as u8;
                    let input = vec![input_byte; BUFFER_BYTES];
                    let allocation = input.capacity();
                    let allocated = buffers.fetch_add(allocation, Ordering::SeqCst) + allocation;
                    peak_buffers.fetch_max(allocated, Ordering::SeqCst);
                    barrier.wait();
                    let active_jobs = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(active_jobs, Ordering::SeqCst);
                    let started_us = began.elapsed().as_micros();
                    let mut hash = Sha256::new();
                    for _ in 0..HASH_PASSES {
                        hash.update(&input);
                    }
                    let output_sha256 = format!("{:x}", hash.finalize());
                    let finished_us = began.elapsed().as_micros();
                    active.fetch_sub(1, Ordering::SeqCst);
                    drop(input);
                    buffers.fetch_sub(allocation, Ordering::SeqCst);
                    store.complete(&job.id)?;
                    Ok(Interval {
                        id: job.id,
                        started_us,
                        finished_us,
                        output_sha256,
                    })
                })
            })
            .collect();
        for handle in handles {
            intervals.push(
                handle
                    .join()
                    .map_err(|_| anyhow::anyhow!("benchmark worker panicked"))??,
            );
        }
    }
    let elapsed = began.elapsed();
    let after = process_metrics();
    let confirmed_overlap = intervals.iter().enumerate().any(|(i, a)| {
        intervals
            .iter()
            .skip(i + 1)
            .any(|b| a.started_us < b.finished_us && b.started_us < a.finished_us)
    });
    let completed_jobs = store
        .jobs()?
        .iter()
        .filter(|j| j.status == JobStatus::Succeeded)
        .count();
    let peak_active_jobs = peak.load(Ordering::SeqCst);
    Ok(RunResult {
        process_id: std::process::id(),
        wall_ms: elapsed.as_secs_f64() * 1000.0,
        process_cpu_seconds: before
            .cpu_seconds
            .zip(after.cpu_seconds)
            .map(|(before, after)| (after - before).max(0.0)),
        peak_process_working_set_bytes: after.peak_working_set,
        peak_active_jobs,
        peak_reserved_ram_mb,
        peak_actual_input_buffers_bytes: peak_buffers.load(Ordering::SeqCst),
        completed_jobs,
        confirmed_overlap,
        intervals,
    })
}

fn write_new_result(path: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let output = if path.exists() {
        let stem = path
            .file_stem()
            .context("benchmark result filename is required")?
            .to_string_lossy();
        path.with_file_name(format!("{stem}-{}.json", uuid::Uuid::new_v4()))
    } else {
        path.to_path_buf()
    };
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = output.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, &output)?;
    Ok(output)
}

fn isolated_run(mode: &str) -> Result<RunResult> {
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command.args(["--run-mode", mode]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW for a console helper.
    }
    let output = command
        .output()
        .context("launch isolated benchmark process")?;
    if !output.status.success() {
        bail!(
            "isolated {mode} benchmark failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    serde_json::from_slice(&output.stdout).context("decode isolated benchmark measurements")
}

fn main() -> Result<()> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.first().is_some_and(|arg| arg == "--run-mode") {
        let concurrency = match arguments.get(1).and_then(|arg| arg.to_str()) {
            Some("serial") => 1,
            Some("parallel") => 2,
            _ => bail!("--run-mode requires serial or parallel"),
        };
        println!("{}", serde_json::to_string(&run(concurrency)?)?);
        return Ok(());
    }
    if arguments.len() > 1 {
        bail!("supply at most one result filename");
    }
    let serial = isolated_run("serial")?;
    let parallel = isolated_run("parallel")?;
    if serial.completed_jobs != JOB_COUNT
        || parallel.completed_jobs != JOB_COUNT
        || serial.confirmed_overlap
        || !parallel.confirmed_overlap
        || serial.peak_active_jobs != 1
        || parallel.peak_active_jobs != 2
        || serial.process_id == parallel.process_id
    {
        bail!("native scheduler benchmark failed completion or overlap verification");
    }
    let serial_hashes: Vec<_> = serial.intervals.iter().map(|j| &j.output_sha256).collect();
    let parallel_hashes: Vec<_> = parallel
        .intervals
        .iter()
        .map(|j| &j.output_sha256)
        .collect();
    if serial_hashes != parallel_hashes {
        bail!("serial and parallel actual work outputs differ")
    }
    let result = json!({
        "schemaVersion":2,
        "measuredAt":chrono::Utc::now().to_rfc3339(),
        "platform":std::env::consts::OS,
        "architecture":std::env::consts::ARCH,
        "workload":{"operation":"sha256","jobs":JOB_COUNT,"bufferBytesPerJob":BUFFER_BYTES,"passesPerJob":HASH_PASSES},
        "isolatedProcesses":true,
        "measuredWallSpeedup":serial.wall_ms/parallel.wall_ms,
        "serial":serial,"parallel":parallel,
        "notes":[
            "Real local CPU work; no provider or Blender performance claim.",
            "Resource reservations are admission estimates, not an OS memory sandbox.",
            "Fresh processes isolate serial and parallel peaks. Windows CPU time is kernel+user time during the workload; peak working set covers each child process lifetime.",
            "Input-buffer allocation peaks count live Vec capacities; Windows working set also includes SQLite, thread stacks, executable pages and allocator overhead.",
            "Null CPU or memory values mean the platform metric was not collected.",
            "One measurement; no unverified fixed speedup claim."
        ]
    });
    let bytes = serde_json::to_vec_pretty(&result)?;
    if let Some(path) = arguments.first() {
        let output = write_new_result(Path::new(&path), &bytes)?;
        eprintln!("Saved native scheduler measurements: {}", output.display());
    }
    println!("{}", String::from_utf8(bytes)?);
    Ok(())
}
