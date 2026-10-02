//! Small durable state snapshots. Payloads, prompts, raw errors and credentials
//! are deliberately absent; the current Job remains the detailed state source.
use anyhow::{bail, Context, Result};
use asset_core::models::{Job, JobProgress, JobStatus};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const MAX_PAGE_SIZE: usize = 256;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobEventKind {
    Snapshot,
    Enqueued,
    StateChanged,
    Updated,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalJobIdentity {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub cursor: u64,
    pub job_id: String,
    pub kind: JobEventKind,
    pub status: JobStatus,
    pub previous_status: Option<JobStatus>,
    pub progress: JobProgress,
    pub attempts: u32,
    pub occurred_at: String,
    pub external_identity: Option<ExternalJobIdentity>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<JobEvent>,
    pub next_cursor: u64,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsPage {
    pub jobs: Vec<Job>,
    pub next_cursor: u64,
    pub has_more: bool,
}

pub(crate) fn checked_page(cursor: u64, limit: usize) -> Result<(i64, i64)> {
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        bail!("page limit must be 1..={MAX_PAGE_SIZE}");
    }
    Ok((
        i64::try_from(cursor).context("cursor exceeds SQLite integer range")?,
        (limit + 1) as i64,
    ))
}

pub(crate) fn external_identity(job: &Job) -> Option<ExternalJobIdentity> {
    let thread_id = job.payload.get("externalThreadId")?.as_str()?;
    let turn_id = job.payload.get("externalTurnId")?.as_str()?;
    if super::valid_external_id(thread_id) && super::valid_external_id(turn_id) {
        Some(ExternalJobIdentity {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
        })
    } else {
        None
    }
}

pub(crate) fn append_event(
    connection: &Connection,
    job: &Job,
    kind: JobEventKind,
    previous_status: Option<JobStatus>,
) -> Result<()> {
    let mut progress = job.progress.clone();
    // Preserve the job itself. Imported legacy progress strings are bounded in
    // the event snapshot at a UTF-8 boundary, never split into invalid text.
    if progress.stage.len() > 256 {
        let mut end = 256;
        while !progress.stage.is_char_boundary(end) {
            end -= 1;
        }
        progress.stage.truncate(end);
    }
    let event = JobEvent {
        cursor: 0,
        job_id: job.id.clone(),
        kind,
        status: job.status,
        previous_status,
        progress,
        attempts: job.attempts,
        occurred_at: super::now_text(),
        external_identity: external_identity(job),
    };
    let document = serde_json::to_string(&event)?;
    if document.len() > 4096 {
        bail!("job event exceeds small-event storage limit");
    }
    connection.execute(
        "INSERT INTO scheduler_events(job_id,document) VALUES (?1,?2)",
        params![job.id, document],
    )?;
    Ok(())
}

pub(crate) fn events_after(
    connection: &Connection,
    cursor: u64,
    limit: usize,
) -> Result<EventPage> {
    let (after, fetch) = checked_page(cursor, limit)?;
    let mut statement = connection.prepare(
        "SELECT cursor,document FROM scheduler_events WHERE cursor>?1 ORDER BY cursor LIMIT ?2",
    )?;
    let rows = statement.query_map(params![after, fetch], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut events = rows
        .map(|row| {
            let (sequence, document) = row?;
            let mut event: JobEvent =
                serde_json::from_str(&document).context("decode durable job event")?;
            event.cursor = u64::try_from(sequence).context("invalid job event cursor")?;
            Ok(event)
        })
        .collect::<Result<Vec<_>>>()?;
    let has_more = events.len() > limit;
    events.truncate(limit);
    let next_cursor = events.last().map(|e| e.cursor).unwrap_or(cursor);
    Ok(EventPage {
        events,
        next_cursor,
        has_more,
    })
}
