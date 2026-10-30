import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  test: {
    // 실측용 과거 소스 복사본은 현재 제품의 테스트에 중복 포함하지 않습니다.
    exclude: [...configDefaults.exclude, "benchmarks/results/**", "data/observation-harness-check/**"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers: process.platform === "win32" ? 1 : undefined
  }
});
