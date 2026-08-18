import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

const config = [
  { ignores: [".next", "node_modules", "coverage", "dist", "out"] },
  ...coreWebVitals,
  ...typescript,
  { rules: { "react-hooks/set-state-in-effect": "off" } },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // JSX attributes are exempt: `onClick={async () => ...}` is idiomatic
      // React here, and wrapping 61 handlers in `() => { void f() }` would
      // change no behavior.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "alert",
          message: "Use useToast() from @/components/ui/ToastProvider instead.",
        },
      ],
    },
  },
];

export default config;
