//! `ledger-cli backup` records the run of the "backup" job only for a backup
//! into the scheduler's directory. These tests run the real binary.

use ledger_db::{Database, Sql};
use std::{path::Path, process::Command};

fn cli(root: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_ledger-cli"))
        .args(args)
        .env("DATABASE_PATH", root.join("test.db"))
        .env("BACKUP_DIR", root.join("scheduled"))
        .output()
        .expect("run ledger-cli")
}

/// The recorded runs of the "backup" job: none or one.
fn backup_runs(root: &Path) -> usize {
    let database = Database::open(&root.join("test.db"), false).unwrap();
    let runs: i64 = database
        .query_row("SELECT COUNT(*) FROM job_runs WHERE job = 'backup'", &[])
        .unwrap();
    database.execute("DELETE FROM job_runs", &[]).unwrap();
    runs as usize
}

#[test]
fn only_a_backup_into_the_scheduler_directory_records_status() {
    let root = std::env::temp_dir().join(format!("counterpoise-cli-record-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    assert!(cli(&root, &["migrate"]).status.success());

    // Another directory: no record.
    let other = root.join("snapshot");
    let output = cli(&root, &["backup", "--dir", other.to_str().unwrap()]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(backup_runs(&root), 0);

    // The default directory (BACKUP_DIR): a record.
    let output = cli(&root, &["backup"]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(backup_runs(&root), 1);
    // A copy has a name by the second, so clear the first one.
    std::fs::remove_dir_all(root.join("scheduled")).unwrap();

    // An explicit --dir that is the scheduler's directory: a record.
    let scheduled = root.join("scheduled").join("..").join("scheduled");
    let output = cli(&root, &["backup", "--dir", scheduled.to_str().unwrap()]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(backup_runs(&root), 1);
    std::fs::remove_dir_all(&root).unwrap();
}
