//! `ledger-cli backup` writes the "backup" status record only for a backup
//! into the scheduler's directory. These tests run the real binary.

use std::{path::Path, process::Command};

fn cli(root: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_ledger-cli"))
        .args(args)
        .env("DATABASE_PATH", root.join("test.db"))
        .env("BACKUP_DIR", root.join("scheduled"))
        .env("STATUS_DIR", root.join("status"))
        .output()
        .expect("run ledger-cli")
}

#[test]
fn only_a_backup_into_the_scheduler_directory_records_status() {
    let root = std::env::temp_dir().join(format!("counterpoise-cli-record-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    assert!(cli(&root, &["migrate"]).status.success());
    let record = root.join("status").join("backup.json");

    // Another directory: no record.
    let other = root.join("snapshot");
    let output = cli(&root, &["backup", "--dir", other.to_str().unwrap()]);
    assert!(output.status.success(), "{output:?}");
    assert!(!record.exists());

    // The default directory (BACKUP_DIR): a record.
    let output = cli(&root, &["backup"]);
    assert!(output.status.success(), "{output:?}");
    let text = std::fs::read_to_string(&record).unwrap();
    assert!(text.contains("\"job\": \"backup\""), "{text}");
    std::fs::remove_file(&record).unwrap();
    // A copy has a name by the second, so clear the first one.
    std::fs::remove_dir_all(root.join("scheduled")).unwrap();

    // An explicit --dir that is the scheduler's directory: a record.
    let scheduled = root.join("scheduled").join("..").join("scheduled");
    let output = cli(&root, &["backup", "--dir", scheduled.to_str().unwrap()]);
    assert!(output.status.success(), "{output:?}");
    assert!(record.exists());
    std::fs::remove_dir_all(&root).unwrap();
}
