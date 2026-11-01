//! The scheduler's plan: a pure function of the time and of what the job
//! tables hold (`ledger_db::jobs`), with no clock and no I/O of its own. It
//! gives the jobs due now and the time of the next wake. The native loop
//! plans at each minute. On Workers, an alarm plans, runs a due job and sets
//! the next alarm, so the next wake must come from the tables alone.
//!
//! The schedules read local time in the app's zone. The plan walks UTC
//! minutes and reads each one in that zone, so a change to or from daylight
//! saving time needs no special case: a local time that the change skips
//! is never due, and a local hour that it repeats is due twice, as under
//! cron.

use chrono::{DateTime, DurationRound, TimeDelta, Utc};
use ledger_db::clock::Tz;
use std::collections::HashMap;

/// How late a scheduled run may still start. A slot that is older than this
/// when the scheduler wakes (the process was stopped) is left out.
pub(crate) const GRACE: TimeDelta = TimeDelta::minutes(60);

/// How far ahead the plan looks for the next slot. The monthly `VACUUM` is
/// the rarest job.
const HORIZON: TimeDelta = TimeDelta::days(32);

/// Whether a local minute is a slot of a job.
pub(crate) type Schedule = fn(&DateTime<Tz>) -> bool;

/// The latest slot of a job (`job_slots`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Last {
    pub(crate) at: DateTime<Utc>,
    pub(crate) finished: bool,
    /// Where the next step of an unfinished run starts.
    pub(crate) cursor: Option<String>,
}

/// What the tables say of one job.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Known {
    pub(crate) last: Option<Last>,
    /// A run was asked for outside the schedule (`job_requests`).
    pub(crate) requested: bool,
    /// A run holds the job's lease.
    pub(crate) running: bool,
}

/// A run to start now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Due {
    pub(crate) job: &'static str,
    /// The minute that the run serves.
    pub(crate) slot: DateTime<Utc>,
    /// The run goes on with an unfinished run of `slot`, from `cursor`,
    /// rather than claiming a new slot.
    pub(crate) resume: bool,
    pub(crate) cursor: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Plan {
    pub(crate) due: Vec<Due>,
    /// `now` when a job is due; else the next slot of any job, or the next
    /// minute when a due job waits for a run that holds its lease.
    pub(crate) next_wake: DateTime<Utc>,
}

/// The jobs due at `now` and the next wake. A job is due, in this order:
///
/// 1. for its latest slot, when that slot is no more than [`GRACE`] old
///    and later than the job's last slot. A job with no slot on record
///    catches up nothing: only a slot at `now`'s minute is due;
/// 2. for `now`'s minute, when a run was asked for;
/// 3. to resume its last slot, when that run did not finish (it stopped
///    while it ran, or it works in steps and has more to do).
///
/// A job whose lease another run holds is not due; the plan wakes again a
/// minute later.
pub(crate) fn plan(
    now: DateTime<Utc>,
    zone: Tz,
    schedules: &[(&'static str, Schedule)],
    known: &HashMap<&str, Known>,
) -> Plan {
    let minute = now
        .duration_trunc(TimeDelta::minutes(1))
        .expect("a time in chrono's range");
    let is_slot = |schedule: Schedule, at: DateTime<Utc>| schedule(&at.with_timezone(&zone));
    let (mut due, mut waiting) = (Vec::new(), false);
    for &(job, schedule) in schedules {
        let known = known.get(job).cloned().unwrap_or_default();
        let latest = (0..GRACE.num_minutes())
            .map(|back| minute - TimeDelta::minutes(back))
            .find(|&at| is_slot(schedule, at));
        let fresh = latest.filter(|&at| match &known.last {
            Some(last) => at > last.at,
            None => at == minute,
        });
        let run = match (fresh, known.last) {
            (Some(slot), _) => Some(Due {
                job,
                slot,
                resume: false,
                cursor: None,
            }),
            (None, _) if known.requested => Some(Due {
                job,
                slot: minute,
                resume: false,
                cursor: None,
            }),
            (None, Some(last)) if !last.finished => Some(Due {
                job,
                slot: last.at,
                resume: true,
                cursor: last.cursor,
            }),
            (None, _) => None,
        };
        match run {
            Some(_) if known.running => waiting = true,
            Some(run) => due.push(run),
            None => {}
        }
    }
    let next_wake = if due.is_empty() {
        let next_minute = minute + TimeDelta::minutes(1);
        let scheduled = (1..=HORIZON.num_minutes())
            .map(|ahead| minute + TimeDelta::minutes(ahead))
            .find(|&at| schedules.iter().any(|&(_, schedule)| is_slot(schedule, at)))
            .unwrap_or(minute + HORIZON);
        if waiting { next_minute } else { scheduled }
    } else {
        now
    };
    Plan { due, next_wake }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn new_york() -> Tz {
        "America/New_York".parse().unwrap()
    }

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().to_utc()
    }

    fn only(name: &str) -> Vec<(&'static str, Schedule)> {
        crate::scheduler::schedules()
            .into_iter()
            .filter(|(job, _)| *job == name)
            .collect()
    }

    fn finished(at: &str) -> Known {
        Known {
            last: Some(Last {
                at: utc(at),
                finished: true,
                cursor: None,
            }),
            ..Known::default()
        }
    }

    /// The plan for one job alone, in New York time.
    fn plan_of(name: &'static str, now: &str, known: Known) -> Plan {
        plan(
            utc(now),
            new_york(),
            &only(name),
            &HashMap::from([(name, known)]),
        )
    }

    #[test]
    fn the_next_wake_keeps_local_time_across_a_change_to_daylight_saving_time() {
        // 2026-03-08 02:00 EST becomes 03:00 EDT. Prices are fetched at
        // 06:00 local, Tuesday to Saturday: 11:00 UTC before the change,
        // 10:00 UTC after it.
        let before = plan_of(
            "price-sync",
            "2026-03-03T12:00:00Z",
            finished("2026-03-03T11:00:00Z"),
        );
        assert_eq!(before.next_wake, utc("2026-03-04T11:00:00Z"));
        // Saturday after the run; the next run is on Tuesday.
        let across = plan_of(
            "price-sync",
            "2026-03-07T12:00:00Z",
            finished("2026-03-07T11:00:00Z"),
        );
        assert_eq!(across.next_wake, utc("2026-03-10T10:00:00Z"));
        assert!(across.due.is_empty());
        // The hour that the change skips has no slot: after 01:00 EST
        // (06:00 UTC) the next hourly slot is 03:00 EDT (07:00 UTC).
        let skipped = plan_of(
            "recurring",
            "2026-03-08T06:00:30Z",
            finished("2026-03-08T06:00:00Z"),
        );
        assert_eq!(skipped.next_wake, utc("2026-03-08T07:00:00Z"));
        // The weekly review runs on Monday at 05:00 local.
        let review = plan_of(
            "weekly-review",
            "2026-03-02T10:00:00Z",
            finished("2026-03-02T10:00:00Z"),
        );
        assert_eq!(review.next_wake, utc("2026-03-09T09:00:00Z"));
    }

    #[test]
    fn the_next_wake_keeps_local_time_across_a_change_from_daylight_saving_time() {
        // 2026-11-01 02:00 EDT becomes 01:00 EST.
        let across = plan_of(
            "price-sync",
            "2026-10-31T12:00:00Z",
            finished("2026-10-31T10:00:00Z"),
        );
        assert_eq!(across.next_wake, utc("2026-11-03T11:00:00Z"));
        // The repeated hour has two slots: 01:00 EDT (05:00 UTC) and
        // 01:00 EST (06:00 UTC).
        let first = plan_of("recurring", "2026-11-01T05:00:10Z", Known::default());
        assert_eq!(first.due.len(), 1);
        assert_eq!(first.due[0].slot, utc("2026-11-01T05:00:00Z"));
        let repeated = plan_of(
            "recurring",
            "2026-11-01T05:30:00Z",
            finished("2026-11-01T05:00:00Z"),
        );
        assert_eq!(repeated.next_wake, utc("2026-11-01T06:00:00Z"));
        let second = plan_of(
            "recurring",
            "2026-11-01T06:00:05Z",
            finished("2026-11-01T05:00:00Z"),
        );
        assert_eq!(second.due[0].slot, utc("2026-11-01T06:00:00Z"));
        // The Plaid sync at 06:00 local is 11:00 UTC on the day of the
        // change, and the one at 00:00 was at 04:00 UTC.
        let plaid = plan_of(
            "plaid-sync",
            "2026-11-01T04:10:00Z",
            finished("2026-11-01T04:00:00Z"),
        );
        assert_eq!(plaid.next_wake, utc("2026-11-01T11:00:00Z"));
    }

    #[test]
    fn a_slot_is_due_once_and_up_to_an_hour_late() {
        let due = |plan: &Plan| plan.due.iter().map(|due| due.slot).collect::<Vec<_>>();
        // 06:00 EDT is 10:00 UTC on 2026-10-21.
        let on_time = plan_of(
            "backup",
            "2026-10-21T10:00:20Z",
            finished("2026-10-21T09:00:00Z"),
        );
        assert_eq!(due(&on_time), [utc("2026-10-21T10:00:00Z")]);
        assert_eq!(on_time.next_wake, utc("2026-10-21T10:00:20Z"));
        assert!(!on_time.due[0].resume);
        // Once claimed, the slot is not due again.
        let claimed = plan_of(
            "backup",
            "2026-10-21T10:00:40Z",
            Known {
                last: Some(Last {
                    at: utc("2026-10-21T10:00:00Z"),
                    finished: false,
                    cursor: None,
                }),
                running: true,
                ..Known::default()
            },
        );
        assert!(claimed.due.is_empty());
        let done = plan_of(
            "backup",
            "2026-10-21T10:01:00Z",
            finished("2026-10-21T10:00:00Z"),
        );
        assert!(done.due.is_empty());
        assert_eq!(done.next_wake, utc("2026-10-21T11:00:00Z"));
        // A wake that came late still runs the slot, up to an hour.
        let late = plan_of(
            "backup",
            "2026-10-21T10:59:00Z",
            finished("2026-10-21T09:00:00Z"),
        );
        assert_eq!(due(&late), [utc("2026-10-21T10:00:00Z")]);
        // A slot more than an hour old is left out: the 04:00 prune after a
        // night with the process stopped.
        let stale = plan_of(
            "prune",
            "2026-10-21T09:05:00Z",
            finished("2026-10-20T08:00:00Z"),
        );
        assert!(stale.due.is_empty());
        // With no record, only the slot of this minute is due: a first
        // start does not catch up.
        let first = plan_of("backup", "2026-10-21T10:30:00Z", Known::default());
        assert!(first.due.is_empty());
        let first = plan_of("backup", "2026-10-21T10:00:00Z", Known::default());
        assert_eq!(due(&first), [utc("2026-10-21T10:00:00Z")]);
    }

    #[test]
    fn an_unfinished_run_resumes_from_its_cursor_once_its_lease_is_free() {
        let unfinished = |running| Known {
            last: Some(Last {
                at: utc("2026-10-21T10:00:00Z"),
                finished: false,
                cursor: Some("7".to_owned()),
            }),
            running,
            ..Known::default()
        };
        let running = plan_of("plaid-sync", "2026-10-21T10:20:00Z", unfinished(true));
        assert!(running.due.is_empty());
        assert_eq!(running.next_wake, utc("2026-10-21T10:21:00Z"));
        let stopped = plan_of("plaid-sync", "2026-10-21T10:20:00Z", unfinished(false));
        assert_eq!(
            stopped.due,
            [Due {
                job: "plaid-sync",
                slot: utc("2026-10-21T10:00:00Z"),
                resume: true,
                cursor: Some("7".to_owned()),
            }]
        );
        // A newer slot starts afresh in its place.
        let newer = plan_of("plaid-sync", "2026-10-21T16:00:00Z", unfinished(false));
        assert_eq!(newer.due[0].slot, utc("2026-10-21T16:00:00Z"));
        assert!(!newer.due[0].resume);
        assert_eq!(newer.due[0].cursor, None);
    }

    #[test]
    fn a_requested_run_is_due_at_once_and_waits_for_a_running_one() {
        let requested = |running| Known {
            requested: true,
            running,
            ..finished("2026-10-19T09:00:00Z")
        };
        let now = "2026-10-21T15:42:31Z";
        let plan = plan_of("weekly-review", now, requested(false));
        assert_eq!(plan.next_wake, utc(now));
        assert_eq!(
            plan.due,
            [Due {
                job: "weekly-review",
                slot: utc("2026-10-21T15:42:00Z"),
                resume: false,
                cursor: None,
            }]
        );
        let waits = plan_of("weekly-review", now, requested(true));
        assert!(waits.due.is_empty());
        assert_eq!(waits.next_wake, utc("2026-10-21T15:43:00Z"));
    }

    #[test]
    fn the_plan_lists_every_job_due_and_wakes_for_the_soonest_slot() {
        let zone = new_york();
        // 2026-10-01 is a Thursday: at 03:00 EDT only the VACUUM and the
        // hourly recurring run.
        let at = zone
            .with_ymd_and_hms(2026, 10, 1, 3, 0, 0)
            .unwrap()
            .to_utc();
        let first = plan(at, zone, &crate::scheduler::schedules(), &HashMap::new());
        let mut names: Vec<_> = first.due.iter().map(|due| due.job).collect();
        names.sort_unstable();
        assert_eq!(names, ["recurring", "reindex"]);
        let after = HashMap::from([
            ("recurring", finished("2026-10-01T07:00:00Z")),
            ("reindex", finished("2026-10-01T07:00:00Z")),
        ]);
        let later = plan(
            at + TimeDelta::minutes(1),
            zone,
            &crate::scheduler::schedules(),
            &after,
        );
        assert!(later.due.is_empty());
        // TypeSafe cleanup at :15.
        assert_eq!(later.next_wake, utc("2026-10-01T07:15:00Z"));
    }
}
