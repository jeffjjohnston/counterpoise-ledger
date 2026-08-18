#!/bin/sh
# Record the outcome of one scheduled job.
#
#   record-status.sh <job> <ok|fail> [detail] [bytes] [verified]
#
# Writes $STATUS_DIR/<job>.json, generated whole. The scheduler image
# (postgres:16-alpine) has no jq, python3 or perl, so nothing here parses JSON —
# one file per job means we never need to. It also means the minute-0 collision
# between the recurring and backup jobs is not a race: they write different
# paths.
#
# Always exits 0: a successful backup whose status write failed is still a
# successful backup, and failing the job to preserve bookkeeping about the job
# would invert the priority.

STATUS_DIR="${STATUS_DIR:-/backups/status}"

JOB="$1"
OUTCOME="$2"
DETAIL="$3"
BYTES="$4"
VERIFIED="$5"

[ -z "$JOB" ] && { echo "[record-status] missing job name"; exit 0; }

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# JSON string escaping: backslashes first, then double quotes.
#
# Newlines, carriage returns and tabs are collapsed to spaces rather than
# escaped. A raw control character inside a JSON string makes the whole file
# unparseable, and the reader would then report the job as missing — the exact
# blind spot this system exists to remove. detail is a short display string, so
# flattening it loses nothing, and it avoids hand-rolling \n escaping in
# busybox sed, where getting the backslash doubling wrong fails silently.
esc() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

json_str() {
  if [ -z "$1" ]; then printf 'null'; else printf '"%s"' "$(esc "$1")"; fi
}

json_raw() {
  # Bare literal (number or boolean); empty becomes null.
  if [ -z "$1" ]; then printf 'null'; else printf '%s' "$1"; fi
}

if [ "$OUTCOME" = "ok" ]; then
  LAST_OK="\"$NOW\""
else
  LAST_OK="null"
fi

mkdir -p "$STATUS_DIR" 2>/dev/null || {
  echo "[record-status] cannot create $STATUS_DIR"
  exit 0
}

TMP="$STATUS_DIR/.$JOB.json.tmp.$$"

{
  printf '{\n'
  printf '  "job": "%s",\n' "$(esc "$JOB")"
  printf '  "lastRun": "%s",\n' "$NOW"
  printf '  "lastOk": %s,\n' "$LAST_OK"
  printf '  "verified": %s,\n' "$(json_raw "$VERIFIED")"
  printf '  "bytes": %s,\n' "$(json_raw "$BYTES")"
  printf '  "detail": %s\n' "$(json_str "$DETAIL")"
  printf '}\n'
} > "$TMP" 2>/dev/null || {
  echo "[record-status] cannot write $TMP"
  rm -f "$TMP" 2>/dev/null
  exit 0
}

# Atomic within the same filesystem: a reader sees the old file or the new one,
# never a partial write.
mv "$TMP" "$STATUS_DIR/$JOB.json" 2>/dev/null || {
  echo "[record-status] cannot install $STATUS_DIR/$JOB.json"
  rm -f "$TMP" 2>/dev/null
  exit 0
}

exit 0
