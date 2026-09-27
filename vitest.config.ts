import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试与源码同目录（src/**/__tests__/），tsc 构建已通过 tsconfig exclude 排除
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    // 安全网：禁止测试写入真实 mihomo/mihomo-tui 配置目录
    setupFiles: ['vitest.setup.ts'],
    // 旧的 poolOptions.forks.singleFork 在 vitest 5 是静默 no-op（v4 起移除），
    // 已随弃用警告移除。默认并行 fork 实测最快：43 文件全量约 13s，
    // 单进程序列化（maxWorkers: 1 + isolate: false）约 54s，无需降并发
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/__tests__/**'],
      thresholds: {
        'src/rules/matcher.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
})
