/**
 * 内核服务的跨平台一键配置：开机自启 + 长期运行。
 *
 * Linux = systemd --user 单元（~/.config/systemd/user/mihomo.service，单元名与
 * ServiceManager 的探测名一致，配好后订阅事务/内核切换的自动重启自动接上）；
 * macOS = launchd LaunchAgent（登录自启 + KeepAlive）；Windows = 登录触发的
 * 计划任务（当前用户任务，无需管理员）。
 *
 * 幂等约束：服务定义文件已存在时零覆盖，只执行启用动作；enable-linger 需要
 * 提权时不下沉 sudo，返回提示让用户自行执行。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type ServiceFlavor = 'systemd' | 'launchd' | 'windows' | 'unsupported'

export interface SpawnResult {
  status: number | null
  error?: Error
  stdout?: string | Buffer
  stderr?: string | Buffer
}

export type ServiceExec = (file: string, args: string[]) => SpawnResult

export interface ServiceSetupInput {
  /** 内核二进制绝对路径（ExecStart/ProgramArguments/任务指向它） */
  binPath: string
  /** 内核配置目录（-d 参数） */
  mihomoDir: string
}

export interface ServiceSetupDeps {
  /** 注入执行器（测试用）；缺省 spawnSync，120s 超时 */
  exec?: ServiceExec
  home?: string
  /** 缺省按 process.platform 推断（Linux 需 systemctl 在 PATH 上） */
  flavor?: ServiceFlavor
  user?: string
}

export interface ServiceInstallResult {
  flavor: ServiceFlavor
  /** 服务定义文件路径；unsupported 时缺省 */
  definitionPath?: string
  /** true = 本次写入；false = 已存在零覆盖 */
  definitionCreated: boolean
  /** 启用 + 启动是否成功（enable --now / bootstrap / schtasks /Create） */
  enabled: boolean
  /** 服务当前是否处于运行态 */
  active?: boolean
  /** enable-linger 需要提权时给出用户手动的命令（仅 systemd） */
  lingerHint?: string
  /** unsupported 平台的说明 */
  message?: string
  /** 各步骤失败的原始输出，逐条展示 */
  errors: string[]
}

export interface ServiceUninstallResult {
  flavor: ServiceFlavor
  /** 服务定义文件是否被删除 */
  removed: boolean
  errors: string[]
  message?: string
}

const SERVICE_LABEL = 'com.mihomo-tui.mihomo'
const UNIT_NAME = 'mihomo'
const EXEC_TIMEOUT_MS = 120_000

function defaultExec(): ServiceExec {
  return (file, args) => spawnSync(file, args, { timeout: EXEC_TIMEOUT_MS })
}

function asText(value: string | Buffer | undefined): string {
  return value?.toString() ?? ''
}

/** 平台推断：Linux 上 systemctl 不在 PATH（或执行器不可用）时视为无自启机制 */
export function detectFlavor(deps: ServiceSetupDeps = {}): ServiceFlavor {
  if (deps.flavor) return deps.flavor
  const platform = process.platform
  if (platform === 'linux') {
    const probe = (deps.exec ?? defaultExec())('systemctl', ['--user', 'is-system-running'])
    const code = (probe.error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' ? 'unsupported' : 'systemd'
  }
  if (platform === 'darwin') return 'launchd'
  if (platform === 'win32') return 'windows'
  return 'unsupported'
}

function systemdUnitContent(input: ServiceSetupInput): string {
  return [
    '[Unit]',
    'Description=mihomo Daemon (managed by mihomo-tui)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${input.binPath} -d ${input.mihomoDir}`,
    'Restart=on-failure',
    'RestartSec=3',
    'NoNewPrivileges=true',
    'LimitNOFILE=65535',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function launchdPlistContent(input: ServiceSetupInput, home: string): string {
  const logDir = join(home, '.local', 'share', 'mihomo-tui')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${input.binPath}</string>`,
    '    <string>-d</string>',
    `    <string>${input.mihomoDir}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${join(logDir, 'mihomo.log')}</string>`,
    `  <key>StandardErrorPath</key><string>${join(logDir, 'mihomo.err.log')}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** 原子写服务定义；调用方保证路径在用户目录下 */
function writeDefinition(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

export function installService(
  input: ServiceSetupInput,
  deps: ServiceSetupDeps = {},
): ServiceInstallResult {
  const exec = deps.exec ?? defaultExec()
  const home = deps.home ?? homedir()
  const flavor = detectFlavor(deps)
  const errors: string[] = []

  if (flavor === 'unsupported') {
    return {
      flavor,
      definitionCreated: false,
      enabled: false,
      errors,
      message: '当前平台没有内置的开机自启机制，请以文档中的前台方式运行内核',
    }
  }

  if (flavor === 'systemd') {
    const unitPath = join(home, '.config', 'systemd', 'user', `${UNIT_NAME}.service`)
    const definitionCreated = !existsSync(unitPath)
    if (definitionCreated) writeDefinition(unitPath, systemdUnitContent(input))

    const reload = exec('systemctl', ['--user', 'daemon-reload'])
    if (reload.status !== 0) errors.push(`daemon-reload 失败：${asText(reload.stderr) || asText(reload.stdout)}`)
    const enable = exec('systemctl', ['--user', 'enable', '--now', UNIT_NAME])
    if (enable.status !== 0) errors.push(`enable --now 失败：${asText(enable.stderr) || asText(enable.stdout)}`)

    // linger 让用户服务在 SSH 断开后存活；无 polkit 授权时失败，交一条 sudo 命令
    const user = deps.user ?? process.env.USER ?? process.env.USERNAME ?? ''
    const linger = exec('loginctl', ['enable-linger', user])
    const lingerHint = linger.status === 0 ? undefined : `sudo loginctl enable-linger ${user || '$USER'}`

    const active = exec('systemctl', ['--user', 'is-active', UNIT_NAME])
    return {
      flavor,
      definitionPath: unitPath,
      definitionCreated,
      enabled: enable.status === 0,
      active: asText(active.stdout).trim() === 'active',
      lingerHint,
      errors,
    }
  }

  if (flavor === 'launchd') {
    const plistPath = join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    const definitionCreated = !existsSync(plistPath)
    if (definitionCreated) writeDefinition(plistPath, launchdPlistContent(input, home))
    const uid = exec('id', ['-u'])
    const uidArg = asText(uid.stdout).trim() || '501'
    exec('launchctl', ['bootout', `gui/${uidArg}/${SERVICE_LABEL}`])
    const bootstrap = exec('launchctl', ['bootstrap', `gui/${uidArg}`, plistPath])
    if (bootstrap.status !== 0) errors.push(`bootstrap 失败：${asText(bootstrap.stderr) || asText(bootstrap.stdout)}`)
    return {
      flavor,
      definitionPath: plistPath,
      definitionCreated,
      enabled: bootstrap.status === 0,
      errors,
    }
  }

  // windows：当前用户登录触发的计划任务，/F 覆盖旧任务保证幂等
  const taskValue = `"${input.binPath}" -d "${input.mihomoDir}"`
  const create = exec('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', UNIT_NAME, '/TR', taskValue])
  if (create.status !== 0) errors.push(`schtasks /Create 失败：${asText(create.stderr) || asText(create.stdout)}`)
  return {
    flavor,
    definitionPath: undefined,
    definitionCreated: true,
    enabled: create.status === 0,
    errors,
  }
}

export function uninstallService(
  deps: ServiceSetupDeps = {},
): ServiceUninstallResult {
  const exec = deps.exec ?? defaultExec()
  const home = deps.home ?? homedir()
  const flavor = detectFlavor(deps)
  const errors: string[] = []

  if (flavor === 'unsupported') {
    return { flavor, removed: false, errors, message: '当前平台没有内置的自启机制，无需卸载' }
  }

  let definitionPath: string
  if (flavor === 'systemd') {
    definitionPath = join(home, '.config', 'systemd', 'user', `${UNIT_NAME}.service`)
    const disable = exec('systemctl', ['--user', 'disable', '--now', UNIT_NAME])
    if (disable.status !== 0) errors.push(`disable --now 失败：${asText(disable.stderr) || asText(disable.stdout)}`)
  } else if (flavor === 'launchd') {
    definitionPath = join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    const uid = exec('id', ['-u'])
    exec('launchctl', ['bootout', `gui/${asText(uid.stdout).trim()}/${SERVICE_LABEL}`])
  } else {
    const remove = exec('schtasks', ['/Delete', '/F', '/TN', UNIT_NAME])
    if (remove.status !== 0) errors.push(`schtasks /Delete 失败：${asText(remove.stderr) || asText(remove.stdout)}`)
    return { flavor, removed: remove.status === 0, errors }
  }

  let removed = false
  if (existsSync(definitionPath)) {
    try {
      rmSync(definitionPath, { force: true })
      removed = !existsSync(definitionPath)
    } catch (err) {
      errors.push(`删除服务定义失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (flavor === 'systemd') exec('systemctl', ['--user', 'daemon-reload'])
  return { flavor, removed, errors }
}
