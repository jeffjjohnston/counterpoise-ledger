import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "'General Sans'",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "Roboto",
          "'Helvetica Neue'",
          "Arial",
          "sans-serif",
        ],
      },
      colors: {
        surface: {
          DEFAULT: "var(--bg-primary)",
          secondary: "var(--bg-secondary)",
          tertiary: "var(--bg-tertiary)",
          elevated: "var(--bg-elevated)",
          inset: "var(--bg-inset)",
        },
        accent: {
          DEFAULT: "var(--bg-accent)",
          hover: "var(--bg-accent-hover)",
          subtle: "var(--bg-accent-subtle)",
        },
        danger: {
          DEFAULT: "var(--bg-danger)",
          hover: "var(--bg-danger-hover)",
          subtle: "var(--bg-danger-subtle)",
        },
        "success-subtle": "var(--bg-success-subtle)",
        "warning-subtle": "var(--bg-warning-subtle)",
        future: {
          DEFAULT: "var(--bg-future)",
          hover: "var(--bg-future-hover)",
        },
        fg: {
          DEFAULT: "var(--fg-primary)",
          secondary: "var(--fg-secondary)",
          tertiary: "var(--fg-tertiary)",
          accent: "var(--fg-accent)",
          "on-accent": "var(--fg-on-accent)",
          danger: "var(--fg-danger)",
          "danger-muted": "var(--fg-danger-muted)",
          success: "var(--fg-success)",
          "success-muted": "var(--fg-success-muted)",
          warning: "var(--fg-warning)",
        },
        border: {
          DEFAULT: "var(--border-primary)",
          secondary: "var(--border-secondary)",
          focus: "var(--border-focus)",
          danger: "var(--border-danger)",
          warning: "var(--border-warning)",
          future: "var(--border-future)",
        },
      },
      boxShadow: {
        soft: "var(--shadow-md)",
      },
      fontSize: {
        // Dense-secondary step between text-xs (12px) and text-sm (14px), for
        // load-bearing metadata rows (sub-labels, account counts) that were being
        // squeezed into 12px. Pair with the darkened tertiary token. (Finding #8.)
        "13": ["0.8125rem", { lineHeight: "1.125rem" }],
      },
    },
  },
  plugins: [],
};
export default config;
