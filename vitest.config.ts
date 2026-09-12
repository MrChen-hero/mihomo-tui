import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试与源码同目录（src/**/__tests__/），tsc 构建已通过 tsconfig exclude 排除
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    // 单 fork 复用模块缓存：多进程并发冷启动 ink/react 在机械盘上开销过大
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/__tests__/**'],
    },
  },
})
