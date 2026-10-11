// `sqlx::migrate!` in src/database.rs copies the migration files into the
// crate when it compiles. Cargo does not know about these files, so a new
// migration file does not cause a rebuild, and the server then stops at
// startup with `VersionMissing`. This line tells Cargo to rebuild the crate
// when the migrations folder changes (sqlx documents this build script).
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
