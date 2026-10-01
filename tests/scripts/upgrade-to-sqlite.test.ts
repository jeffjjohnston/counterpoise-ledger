import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/upgrade-to-sqlite.sh");

/**
 * A fake docker. It records each call, and answers from the environment:
 * APP_IDS are the running containers of the app project, VOLUME_IDS the
 * running containers on the PostgreSQL volume. After `docker stop`, the
 * volume has no container, unless STICKY is set. `compose ... up` fails, so
 * that a run ends right after the stop and the checks before the start.
 */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$DOCKER_LOG"
case "$1" in
  volume) exit 0 ;;
  run) exit 1 ;;
  ps)
    case "$*" in
      *"project=appproj"*) [ -z "$APP_IDS" ] || printf '%s\\n' $APP_IDS ;;
      *"volume="*) if [ ! -e "$STATE/stopped" ] || [ -n "$STICKY" ]; then [ -z "$VOLUME_IDS" ] || printf '%s\\n' $VOLUME_IDS; fi ;;
    esac
    exit 0 ;;
  inspect)
    format="$3"; shift 3
    for id in "$@"; do
      case "$format" in *Id*) echo "\${id}full" ;; *) echo "  /name-$id" ;; esac
    done
    exit 0 ;;
  stop) touch "$STATE/stopped"; exit 0 ;;
  compose)
    case "$*" in *" up "*) echo "up failed" >&2; exit 1 ;; esac
    exit 0 ;;
esac
exit 0
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-upgrade-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "bin", "docker"), FAKE_DOCKER);
  chmodSync(join(dir, "bin", "docker"), 0o755);
  writeFileSync(join(dir, "test.env"), "DATABASE_URL=postgresql://counterpoise@postgres/counterpoise\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function upgrade(env: Record<string, string>) {
  const result = spawnSync("bash", [SCRIPT, "--yes"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      DOCKER_LOG: join(dir, "docker.log"),
      STATE: join(dir, "state"),
      COUNTERPOISE_PROJECT: "appproj",
      UPGRADE_PROJECT: "upgproj",
      COUNTERPOISE_PGDATA_VOLUME: "test_pgdata",
      COUNTERPOISE_DATA_VOLUME: "test_data",
      COUNTERPOISE_ENV_FILE: join(dir, "test.env"),
      COUNTERPOISE_IMAGE: "counterpoise-test:none",
      COUNTERPOISE_BACKUPS_DIR: join(dir, "backups"),
      APP_IDS: "",
      VOLUME_IDS: "",
      STICKY: "",
      ...env,
    },
  });
  const calls = readFileSync(join(dir, "docker.log"), "utf8").split("\n").filter(Boolean);
  return { status: result.status, stderr: result.stderr, calls };
}

const index = (calls: string[], pattern: RegExp) => calls.findIndex((call) => pattern.test(call));

describe("upgrade-to-sqlite.sh and a second PostgreSQL on the volume", () => {
  it("refuses a running container on the volume that is not of the app project, before it builds or stops", () => {
    const { status, stderr, calls } = upgrade({ VOLUME_IDS: "stranger" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("name-stranger");
    expect(stderr).toContain("does not stop a container that it does not own");
    expect(index(calls, /^compose /)).toBe(-1);
    expect(index(calls, /^stop /)).toBe(-1);
  });

  it("builds the image before it stops the app, and names the rollback after the stop", () => {
    const { status, stderr, calls } = upgrade({ APP_IDS: "app1", VOLUME_IDS: "app1full" });
    expect(status).not.toBe(0);
    const build = index(calls, /^compose .* build convert$/);
    const stop = index(calls, /^stop app1$/);
    const up = index(calls, /^compose .* up -d --wait postgres$/);
    expect(build).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(build);
    expect(up).toBeGreaterThan(stop);
    expect(stderr).toContain("git checkout v1.48.0");
    expect(stderr).toContain(`docker compose --env-file ${join(dir, "test.env")} up -d --build`);
  });

  it("never starts PostgreSQL while a container still runs on the volume after the stop", () => {
    const { status, stderr, calls } = upgrade({ APP_IDS: "app1", VOLUME_IDS: "app1full", STICKY: "1" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("still run on test_pgdata");
    expect(index(calls, /^compose .* up /)).toBe(-1);
    expect(stderr).toContain("git checkout v1.48.0");
  });

  it("says nothing about a rollback when it fails before the stop", () => {
    writeFileSync(join(dir, "bin", "docker"), FAKE_DOCKER.replace('case "$*" in *" up "*)', 'case "$*" in *" build "*)'));
    const { status, stderr, calls } = upgrade({ APP_IDS: "app1", VOLUME_IDS: "app1full" });
    expect(status).not.toBe(0);
    expect(index(calls, /^stop /)).toBe(-1);
    expect(stderr).not.toContain("git checkout v1.48.0");
  });
});
