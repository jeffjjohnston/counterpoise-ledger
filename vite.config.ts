import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import packageJson from "./package.json" with { type: "json" };

/**
 * The client build. `vite build` writes a static site to `build/`, and the
 * Rust server serves it (`COUNTERPOISE_STATIC_DIR`). `vite` serves the same
 * client for development on port 3000 and sends `/api` to the Rust server.
 */

/**
 * The Rust server that the dev proxy sends `/api` to. A shell variable wins,
 * then the `.env` files of `envDir` (as `proxy.ts` of the Next server read it
 * after Next loaded them), then the default port.
 */
export function rustApiTarget(mode: string, envDir: string): string {
  return loadEnv(mode, envDir, "").RUST_API_URL || "http://127.0.0.1:4000";
}

/** The public pages of the page gate in `rust-api/server/src/security.rs`. */
const PUBLIC_PAGES = new Set(["/login", "/register"]);

/**
 * Development only: send a page request without a session cookie to /login,
 * as the page gate of the Rust server does in production. Without this, a
 * signed-out page loads and each API call fails with 401.
 */
function devPageGate(): Plugin {
  return {
    name: "counterpoise-dev-page-gate",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const accept = request.headers.accept ?? "";
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const isPageRequest =
          request.method === "GET" && accept.includes("text/html") && !pathname.startsWith("/api/");
        const hasSession = /(?:^|;\s*)counterpoise_session=[^;]+/.test(request.headers.cookie ?? "");
        if (isPageRequest && !PUBLIC_PAGES.has(pathname) && !hasSession) {
          response.statusCode = 307;
          response.setHeader("Location", "/login");
          response.end();
          return;
        }
        next();
      });
    },
  };
}

/**
 * wasm-bindgen writes a default load path into `ledger_core.js`:
 * `new URL('ledger_core_bg.wasm', import.meta.url)`. Vite sees that pattern
 * and emits the 1.4 MB `.wasm` file into the build. Nothing loads the file,
 * because `lib/wasm-client.ts` starts the module from the base64 copy in
 * `core-bytes.ts`. Replace the default path with a throw. Then Vite emits no
 * file, and a call to `init()` without bytes fails with a clear message.
 */
const DEFAULT_WASM_URL = "new URL('ledger_core_bg.wasm', import.meta.url)";

export function dropUnusedWasmAsset(): Plugin {
  return {
    name: "counterpoise-drop-unused-wasm-asset",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]ledger_core\.js$/.test(id.split("?")[0])) return null;
      if (!code.includes(DEFAULT_WASM_URL)) {
        throw new Error(`ledger_core.js no longer holds ${DEFAULT_WASM_URL}; update dropUnusedWasmAsset`);
      }
      return {
        code: code.replace(
          DEFAULT_WASM_URL,
          '(() => { throw new Error("Pass the WASM bytes to the init function; no default file is built"); })()',
        ),
        map: null,
      };
    },
  };
}

export default defineConfig(({ mode }) => {
  // The same `.env` files and names as the Next build used, so that the
  // production checkout and the Docker build arguments do not change.
  const env = loadEnv(mode, process.cwd(), "NEXT_PUBLIC_");
  const inline = (value: string | undefined) => (value ? JSON.stringify(value) : "undefined");

  return {
    plugins: [react(), tailwindcss(), devPageGate(), dropUnusedWasmAsset()],
    resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } },
    define: {
      "process.env.NEXT_PUBLIC_POSTHOG_KEY": inline(env.NEXT_PUBLIC_POSTHOG_KEY),
      "process.env.NEXT_PUBLIC_POSTHOG_HOST": inline(env.NEXT_PUBLIC_POSTHOG_HOST),
      "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(packageJson.version),
    },
    server: {
      port: 3000,
      strictPort: true,
      // Keep the browser's Host header. The cross-origin write check of the
      // Rust server compares it with the Origin.
      proxy: { "/api": { target: rustApiTarget(mode, process.cwd()), changeOrigin: false } },
    },
    build: {
      outDir: "build",
      emptyOutDir: true,
    },
  };
});
