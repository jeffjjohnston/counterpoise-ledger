//! Embeds the migration files of `migrations/` in the crate, in version
//! order, as `$OUT_DIR/migrations.rs` (see `src/migrations.rs`).

use std::{env, fs, path::Path};

fn main() {
    let dir = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<(i64, String, String)> = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
        .map(|path| {
            println!("cargo:rerun-if-changed={}", path.display());
            let name = path.file_name().unwrap().to_str().unwrap().to_owned();
            let (version, rest) = name
                .split_once('_')
                .unwrap_or_else(|| panic!("{name}: expected <version>_<description>.sql"));
            let version: i64 = version
                .parse()
                .unwrap_or_else(|_| panic!("{name}: the version is not an integer"));
            let description = rest.trim_end_matches(".sql").replace('_', " ");
            (version, description, path.display().to_string())
        })
        .collect();
    files.sort();
    for pair in files.windows(2) {
        assert!(
            pair[0].0 != pair[1].0,
            "two migrations have version {}",
            pair[0].0
        );
    }
    let entries: String = files
        .iter()
        .map(|(version, description, path)| {
            format!(
                "    Migration {{ version: {version}, description: {description:?}, sql: include_str!({path:?}) }},\n"
            )
        })
        .collect();
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("migrations.rs");
    fs::write(out, format!("&[\n{entries}]\n")).unwrap();
}
