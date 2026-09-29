#!/usr/bin/env bash
set -euo pipefail

# Select a pinned official arm64 archive for the current operating system and
# verify it before using wasm-opt.
case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    asset=binaryen-version_131-arm64-macos.tar.gz
    digest=e441b48dc22163d209b4f05e44dc7210909b01237642b6c9ae48fd710a3ef83e
    ;;
  Linux:aarch64|Linux:arm64)
    asset=binaryen-version_131-aarch64-linux.tar.gz
    digest=ba991f677edd9a21d2bc96c0144bc8ac5b112d4d98a3eb266e075e22e557df2a
    ;;
  *)
    echo "No pinned Binaryen archive for $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac
: "${RUNNER_TEMP:?RUNNER_TEMP must point to the CI runner's temporary directory}"
: "${GITHUB_PATH:?GITHUB_PATH must point to the CI runner's path file}"

archive="$RUNNER_TEMP/$asset"
curl -fsSL \
  "https://github.com/WebAssembly/binaryen/releases/download/version_131/$asset" \
  -o "$archive"
if [[ "$(uname -s)" == Darwin ]]; then
  printf '%s  %s\n' "$digest" "$archive" | shasum -a 256 -c -
else
  printf '%s  %s\n' "$digest" "$archive" | sha256sum -c -
fi
tar -xzf "$archive" -C "$RUNNER_TEMP"
"$RUNNER_TEMP/binaryen-version_131/bin/wasm-opt" --version
echo "$RUNNER_TEMP/binaryen-version_131/bin" >> "$GITHUB_PATH"
