import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "src/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/modules/*/*",
                "!**/modules/*/index",
                "!**/modules/*/index.js",
                "!**/modules/*/index.ts",
              ],
              message:
                "A module imports another module only through modules/<other>/index.ts",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/modules/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.\\./(?!\\.\\.?/)[^/]+/(?!index(?:\\.js|\\.ts)?$).+",
              message:
                "A module imports another module only through modules/<other>/index.ts",
            },
          ],
        },
      ],
    },
  },
);
