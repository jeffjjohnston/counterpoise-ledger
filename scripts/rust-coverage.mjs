// Usage: node scripts/rust-coverage.mjs [--unit-only] [--count N]
//
// Measures which lines of the Rust workspace the tests run, and writes a
// Markdown summary to stdout and to rust-api/target/coverage/summary.md.
//
// WHAT RUNS. `cargo test --workspace`, then the HTTP suite and the MCP suite
// against an instrumented server (`--unit-only` leaves these two out). The
// routes get most of their tests through the HTTP suite, so the Rust tests
// alone would show them as not run.
//
// WHAT IT DOES NOT SHOW. The code that only a Worker runs: the Worker suite
// runs under workerd, which gives no profile. The derive crate runs in the
// compiler, so it shows as not run.
// A line that ran is not a line that a test checked. Use the list to find
// code that no test runs; there is no percentage that a change must reach.
//
// NO NEW TOOL. The compiler writes the profile (`-C instrument-coverage`),
// and `llvm-profdata` and `llvm-cov` read it. They come from the rustup
// component `llvm-tools`, or from an LLVM of the same major version as the
// one that `rustc -vV` names (Homebrew: `brew install llvm`).
//
// ITS OWN TARGET DIRECTORY, rust-api/target/coverage. An instrumented build
// in the usual directory would replace each artifact there, and the next
// ordinary build would replace them again. The test helpers find the
// instrumented binaries through COUNTERPOISE_RUST_BIN_DIR.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** The Markdown for one `llvm-cov export -summary-only` object. */
export function rustCoverageSummary(exported, root, count = 15) {
  const { files, totals } = exported.data[0];
  const rows = files.map((file) => ({
    name: relative(root, file.filename),
    covered: file.summary.lines.covered,
    total: file.summary.lines.count,
  }));
  const crates = new Map();
  for (const row of rows) {
    const crate = row.name.split("/").slice(0, 2).join("/");
    const sum = crates.get(crate) ?? { covered: 0, total: 0 };
    crates.set(crate, { covered: sum.covered + row.covered, total: sum.total + row.total });
  }
  const out = [
    "### Rust test coverage",
    "",
    "| | Lines |",
    "| --- | --- |",
    `| All crates | ${pct(totals.lines.covered, totals.lines.count)} |`,
    ...[...crates.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([crate, sum]) => `| \`${crate}\` | ${pct(sum.covered, sum.total)} |`),
    "",
  ];
  const gaps = rows
    .map((row) => ({ ...row, uncovered: row.total - row.covered }))
    .filter((row) => row.uncovered > 0)
    .sort((a, b) => b.uncovered - a.uncovered || (a.name < b.name ? -1 : 1))
    .slice(0, count);
  if (gaps.length === 0) return `${out.join("\n")}Every line ran.\n`;
  out.push(
    `The ${gaps.length} files with the most lines that no test ran:`,
    "",
    "| File | Lines not run | Lines |",
    "| --- | --- | --- |",
    ...gaps.map((row) => `| \`${row.name}\` | ${row.uncovered} | ${pct(row.covered, row.total)} |`),
    "",
    "The lines of a `#[cfg(test)]` module count as lines of their file. Code that only a Worker",
    "runs is not measured, and `rust-api/derive` runs in the compiler, which writes no profile.",
  );
  return `${out.join("\n")}\n`;
}

function pct(covered, total) {
  return total === 0 ? "—" : `${((100 * covered) / total).toFixed(1)}% (${covered}/${total})`;
}

/** The test executables that `cargo test --no-run --message-format=json` names. */
export function testExecutables(messages) {
  const found = [];
  for (const line of messages.split("\n")) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason === "compiler-artifact" && message.executable && message.profile?.test) {
      found.push(message.executable);
    }
  }
  return found;
}

/** `llvm-profdata` or `llvm-cov`: the rustup component first, then PATH, then Homebrew. */
function llvmTool(name) {
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  const rustlib = join(sysroot, "lib/rustlib");
  const candidates = [
    ...(existsSync(rustlib) ? readdirSync(rustlib).map((host) => join(rustlib, host, "bin", name)) : []),
    ...(process.env.PATH ?? "").split(":").map((dir) => join(dir, name)),
    `/opt/homebrew/opt/llvm/bin/${name}`,
    `/usr/local/opt/llvm/bin/${name}`,
  ];
  const tool = candidates.find((path) => existsSync(path));
  if (!tool) {
    throw new Error(
      `${name} not found. Install the rustup component (rustup component add llvm-tools), ` +
        "or an LLVM of the major version that `rustc -vV` names (brew install llvm)",
    );
  }
  return tool;
}

function main(args) {
  const root = resolve(import.meta.dirname, "..");
  const unitOnly = args.includes("--unit-only");
  const countAt = args.indexOf("--count");
  const count = countAt === -1 ? 15 : Number(args[countAt + 1]);
  const target = join(root, "rust-api/target/coverage");
  const profiles = join(target, "profiles");
  const manifest = ["--manifest-path", join(root, "rust-api/Cargo.toml")];
  // Find the tools before the long build, not after it.
  const profdata = llvmTool("llvm-profdata");
  const cov = llvmTool("llvm-cov");

  // The browser copy of the core, with the ordinary environment. The Vitest
  // global setup builds it when it is not current, and that build would get
  // the coverage flags and the coverage target directory from the
  // environment below, then look for its output in the ordinary directory.
  // After this call the module is current, so the global setup builds nothing.
  execFileSync(process.execPath, [join(root, "scripts/build-core-wasm.mjs")], {
    cwd: root, stdio: ["ignore", process.stderr, process.stderr],
  });

  rmSync(profiles, { recursive: true, force: true });
  mkdirSync(profiles, { recursive: true });
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    RUSTFLAGS: "-C instrument-coverage",
    // %p is the process and %m the binary, so no two processes share a file.
    LLVM_PROFILE_FILE: join(profiles, "%p-%m.profraw"),
    COUNTERPOISE_RUST_BIN_DIR: join(target, "debug"),
  };
  // The progress of each tool goes to stderr: stdout is the summary alone.
  const run = (command, commandArgs) =>
    execFileSync(command, commandArgs, { cwd: root, env, stdio: ["ignore", process.stderr, process.stderr] });

  const built = execFileSync(
    "cargo", ["test", "--workspace", "--locked", "--no-run", "--message-format=json", ...manifest],
    { cwd: root, env, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", process.stderr] },
  );
  const objects = testExecutables(built);
  run("cargo", ["test", "--workspace", "--locked", ...manifest]);
  if (!unitOnly) {
    run("cargo", ["build", "--locked", "-p", "counterpoise-rust-api", "-p", "ledger-cli", ...manifest]);
    objects.push(join(target, "debug/counterpoise-rust-api"), join(target, "debug/ledger-cli"));
    run("npm", ["run", "test:http"]);
    run("npm", ["run", "test:mcp:http"]);
  }

  const raw = readdirSync(profiles).filter((name) => name.endsWith(".profraw")).map((name) => join(profiles, name));
  if (raw.length === 0) throw new Error(`no profile was written to ${profiles}`);
  const merged = join(target, "coverage.profdata");
  run(profdata, ["merge", "-sparse", ...raw, "-o", merged]);
  const exported = execFileSync(cov, [
    "export", "-summary-only", `-instr-profile=${merged}`,
    // The workspace's own sources only: not the registry, not the standard
    // library, not generated code, not the integration test files.
    "-ignore-filename-regex=(/\\.cargo/|/rustc/|/target/|/tests/|/library/)",
    objects[0], ...objects.slice(1).flatMap((object) => ["-object", object]),
  ], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  const summary = rustCoverageSummary(JSON.parse(exported), root, count);
  writeFileSync(join(target, "summary.md"), summary);
  process.stdout.write(summary);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
