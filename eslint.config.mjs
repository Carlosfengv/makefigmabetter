import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@base-ui/react", "@radix-ui/*", "@react-aria/*", "react-aria", "@mui/*", "antd"], message: "Business code must compose primitives from @/components/ui." },
        ],
      }],
    },
  },
  globalIgnores([".next/**", "node_modules/**", "src/wasm/generated/**"]),
]);
