import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/llm/**/*.test.ts"],
    passWithNoTests: true,
  },
});
