// ESLint flat config: typescript-eslint recommended, Prettier handles formatting.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "BrowserGateway/", ".remember/", "admin-web/dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Tests mock ports and inspect internals; any and inline import() types are fine there.
    files: ["test/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
);
