/**
 * systemd 用户服务操作（设计稿 2.2：服务名固定 mihomo，Linux + systemd only）。
 *
 * systemctlBin 可注入：测试传一个 stub 脚本路径即可，物理上不可能碰到真实服务。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SYSTEMCTL_TIMEOUT_MS = 10_000

function describe(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string }
  return `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || e.message || String(err)
}

export class ServiceManager {
  constructor(
    readonly serviceName: string = 'mihomo',
    readonly systemctlBin: string = 'systemctl',
  ) {}

  /** 服务是否处于 active；查询失败一律视为未运行 */
  async isActive(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        this.systemctlBin,
        ['--user', 'is-active', this.serviceName],
        { timeout: SYSTEMCTL_TIMEOUT_MS },
      )
      return stdout.trim() === 'active'
    } catch {
      return false
    }
  }

  /** 重启服务。失败抛错并携带完整 stderr，供上层回滚后展示。 */
  async restart(): Promise<void> {
    try {
      await execFileAsync(
        this.systemctlBin,
        ['--user', 'restart', this.serviceName],
        { timeout: SYSTEMCTL_TIMEOUT_MS },
      )
    } catch (err) {
      throw new Error(`重启 ${this.serviceName} 服务失败：${describe(err)}`)
    }
  }

  /**
   * 完整 status 输出。注意：systemctl status 对非 active 服务以非零码退出，
   * 但输出仍是诊断信息，所以失败时也把 stdout/stderr 返回而不是抛错。
   */
  async status(): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        this.systemctlBin,
        ['--user', 'status', this.serviceName],
        { timeout: SYSTEMCTL_TIMEOUT_MS },
      )
      return stdout
    } catch (err) {
      return describe(err)
    }
  }
}
