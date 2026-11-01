#!/usr/bin/env bash
# Installs worker-build, the build command in rust-api/worker/wrangler.toml,
# at the version that matches the worker crate.
#
# worker-build downloads its helper binaries over native TLS. On Linux that
# links OpenSSL, and openssl-sys finds OpenSSL with pkg-config. A Linux
# machine with the OpenSSL headers and no pkg-config gets their location here
# instead. One with no headers needs its OpenSSL development package
# (libssl-dev on Debian and Ubuntu) and pkg-config. macOS and Windows use the
# system's own TLS, so they need neither.
set -euo pipefail

version=0.8.7

if command -v worker-build >/dev/null 2>&1 && [[ "$(worker-build --version 2>/dev/null)" == *" $version"* ]]; then
  echo "worker-build $version is installed"
  exit 0
fi

if [[ "$(uname -s)" == Linux ]] && ! command -v pkg-config >/dev/null 2>&1; then
  if [[ -f /usr/include/openssl/ssl.h ]]; then
    lib=$(dirname "$(find /usr/lib /usr/lib64 -maxdepth 2 -name 'libssl.so' 2>/dev/null | head -1)")
    if [[ "$lib" != "." ]]; then
      export OPENSSL_INCLUDE_DIR=/usr/include OPENSSL_LIB_DIR="$lib"
      echo "No pkg-config: using the OpenSSL headers in /usr/include and the library in $lib"
    fi
  fi
  if [[ -z "${OPENSSL_LIB_DIR:-}" ]]; then
    echo "worker-build needs OpenSSL: this machine has neither pkg-config nor the OpenSSL headers and library." >&2
    echo "Install pkg-config and the OpenSSL development package (libssl-dev on Debian and Ubuntu)." >&2
    exit 1
  fi
fi

cargo install worker-build --version "$version" --locked
