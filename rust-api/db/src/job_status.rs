//! The status record of a job: `<STATUS_DIR>/<job>.json`. The scheduler of
//! the server writes it after each run. `/api/system/status` reads it. The
//! `ledger-cli backup` command writes it too, so a manual backup shows there.
//!
//! The record has `job`, `lastRun`, `lastOk`, `verified`, `bytes` and
//! `detail`. `notConfigured` is present, and true, only for a job that had no
//! secret and ran nothing.

use chrono::{DateTime, Utc};
use serde_json::json;
use std::path::{Path, PathBuf};

/// The fields of one status record, apart from the job name and the time.
#[derive(Default)]
pub struct Status<'a> {
    /// The run succeeded. `lastOk` is the run time when true, else null.
    pub ok: bool,
    pub detail: Option<&'a str>,
    pub bytes: Option<u64>,
    pub verified: Option<bool>,
    /// Written as `notConfigured: true`. Without it, the key is absent.
    pub not_configured: bool,
}

/// The directory of the records: `STATUS_DIR`, else `/backups/status`.
pub fn status_dir() -> PathBuf {
    PathBuf::from(std::env::var("STATUS_DIR").unwrap_or_else(|_| "/backups/status".to_owned()))
}

/// The text of the record file.
pub fn record_text(job: &str, status: &Status<'_>, at: DateTime<Utc>) -> String {
    let now = at.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut record = json!({
        "job": job,
        "lastRun": now,
        "lastOk": status.ok.then_some(&now),
        "verified": status.verified,
        "bytes": status.bytes,
        // A display string: control characters would only make it harder to
        // read, so they become spaces.
        "detail": status.detail.map(|text| text.replace(['\n', '\r', '\t'], " ")),
    });
    // The key is absent from an ordinary record, so old records and new
    // records have the same shape.
    if status.not_configured {
        record["notConfigured"] = json!(true);
    }
    format!(
        "{}\n",
        serde_json::to_string_pretty(&record).expect("a JSON value")
    )
}

/// Writes `<dir>/<job>.json` whole, then renames it into place, so a reader
/// sees the old record or the new one.
pub fn write_record(dir: &Path, job: &str, text: &str) -> std::io::Result<()> {
    let temporary = dir.join(format!(".{job}.json.tmp.{}", std::process::id()));
    let result = std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&temporary, text))
        .and_then(|()| std::fs::rename(&temporary, dir.join(format!("{job}.json"))));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn a_record_has_the_fields_that_the_status_route_reads() {
        let at = Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 5).unwrap();
        let ok = Status {
            ok: true,
            bytes: Some(9),
            verified: Some(true),
            ..Status::default()
        };
        let record: serde_json::Value =
            serde_json::from_str(&record_text("backup", &ok, at)).unwrap();
        assert_eq!(
            record,
            json!({
                "job": "backup", "lastRun": "2026-09-29T10:00:05Z",
                "lastOk": "2026-09-29T10:00:05Z", "verified": true, "bytes": 9, "detail": null,
            })
        );
        let none = Status {
            ok: true,
            detail: Some("a\nb"),
            not_configured: true,
            ..Status::default()
        };
        let record: serde_json::Value =
            serde_json::from_str(&record_text("plaid-sync", &none, at)).unwrap();
        assert_eq!(record["notConfigured"], true);
        assert_eq!(record["detail"], "a b");
    }

    #[test]
    fn a_record_is_written_whole_into_a_new_directory() {
        let dir = std::env::temp_dir()
            .join(format!("counterpoise-record-{}", std::process::id()))
            .join("status");
        let _ = std::fs::remove_dir_all(&dir);
        write_record(&dir, "backup", "{}\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("backup.json")).unwrap(),
            "{}\n"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
