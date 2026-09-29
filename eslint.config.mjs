import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
import tseslint from "typescript-eslint";

// The rules of the eslint-config-next presets that this project used before
// the client left Next ("core-web-vitals" and "typescript"), without the rules
// of the Next and import plugins.
const reactRules = {
  ...react.configs.recommended.rules,
  ...reactHooks.configs.recommended.rules,
  "react/no-unknown-property": "off",
  "react/react-in-jsx-scope": "off",
  "react/prop-types": "off",
  "react/jsx-no-target-blank": "off",
  "jsx-a11y/alt-text": ["warn", { elements: ["img"] }],
  "jsx-a11y/aria-props": "warn",
  "jsx-a11y/aria-proptypes": "warn",
  "jsx-a11y/aria-unsupported-elements": "warn",
  "jsx-a11y/role-has-required-aria-props": "warn",
  "jsx-a11y/role-supports-aria-props": "warn",
};

const config = [
  // An agent worktree holds a full copy of the source. "eslint ." lints each
  // copy, and with several worktrees it runs out of memory.
  {
    ignores: [
      ".next", "node_modules", "coverage", "dist", "build", "out", ".claude/worktrees", "lib/wasm/generated",
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    plugins: { react, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { react: { version: "detect" } },
    rules: reactRules,
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
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
      // All router use goes through one module, so that a change of router
      // changes one file.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react-router", message: "Import from @/lib/navigation instead." },
          ],
        },
      ],
    },
  },
  {
    // The shim, the route table, the layout routes and the tests of the shim
    // and of the route table use the router itself.
    files: [
      "lib/navigation.tsx", "client/**", "app/layout.tsx", "app/b/[[]bookId]/layout.tsx",
      "tests/lib/navigation.test.tsx", "tests/client/**",
    ],
    rules: { "no-restricted-imports": "off" },
  },
];

export default config;
