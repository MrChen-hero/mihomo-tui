/**
 * 服务一键配置的单测：exec 注入（记录调用、可编造失败）、home 指向 tmpdir。
 * 覆盖 systemd/launchd/windows 三平台安装与卸载、幂等（已存在零覆盖）、
 * linger 提权失败时的 sudo 提示、unsupported 平台。零真实 systemctl。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  detectFlavor,
  installService,
  uninstallService,
  type ServiceExec,
  type SpawnResult,
} from '../serviceSetup.js'

let home: string
const BIN = '/opt/fake/bin/mihomo'
const DIR = '/opt/fake/.config/mihomo'
const input = { binPath: BIN, mihomoDir: DIR }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mihomo-tui-svc-'))
})

/** 记录调用的 exec：可按命令前缀编造失败与输出 */
function recordingExec(failFor: Record<string, SpawnResult> = {}): { exec: ServiceExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: ServiceExec = (file, args) => {
    calls.push([file, ...args])
    const key = [file, ...args].join(' ')
    for (const [needle, result] of Object.entries(failFor)) {
      if (key.includes(needle)) return result
    }
    return { status: 0, stdout: '' }
  }
  return { exec, calls }
}

const ok = (stdout = ''): SpawnResult => ({ status: 0, stdout })
const fail = (stderr = 'boom'): SpawnResult => ({ status: 1, stderr })

describe('installService systemd', () => {
  it('写入单元文件 → daemon-reload → enable --now → is-active 全链', () => {
    const { exec, calls } = recordingExec({ 'is-active mihomo': ok('active\n') })
    const result = installService(input, { exec, home, flavor: 'systemd', user: 'ubuntu' })

    const unitPath = join(home, '.config', 'systemd', 'user', 'mihomo.service')
    expect(result).toMatchObject({ flavor: 'systemd', definitionCreated: true, enabled: true, active: true })
    expect(result.definitionPath).toBe(unitPath)
    expect(existsSync(unitPath)).toBe(true)
    const unit = readFileSync(unitPath, 'utf8')
    expect(unit).toContain(`ExecStart=${BIN} -d ${DIR}`)
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('WantedBy=default.target')
    expect(calls.some((c) => c.join(' ') === 'systemctl --user daemon-reload')).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'systemctl --user enable --now mihomo')).toBe(true)
    expect(calls.some((c) => c.join(' ').startsWith('loginctl enable-linger ubuntu'))).toBe(true)
    expect(result.lingerHint).toBeUndefined()
  })

  it('单元文件已存在时零覆盖，只执行启用动作', () => {
    const unitPath = join(home, '.config', 'systemd', 'user', 'mihomo.service')
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(unitPath, '# my own unit\n', 'utf8')

    const { exec } = recordingExec({ 'is-active mihomo': ok('active\n') })
    const result = installService(input, { exec, home, flavor: 'systemd', user: 'ubuntu' })

    expect(result.definitionCreated).toBe(false)
    expect(readFileSync(unitPath, 'utf8')).toBe('# my own unit\n')
    expect(result.enabled).toBe(true)
  })

  it('linger 提权失败：不影响安装成功，给出 sudo 提示', () => {
    const { exec } = recordingExec({
      'loginctl enable-linger': fail('not authorized'),
      'is-active mihomo': ok('active\n'),
    })
    const result = installService(input, { exec, home, flavor: 'systemd', user: 'ubuntu' })
    expect(result.enabled).toBe(true)
    expect(result.lingerHint).toBe('sudo loginctl enable-linger ubuntu')
  })

  it('enable 失败：enabled=false 且 errors 带原始输出', () => {
    const { exec } = recordingExec({ 'enable --now': fail('unit not found') })
    const result = installService(input, { exec, home, flavor: 'systemd', user: 'ubuntu' })
    expect(result.enabled).toBe(false)
    expect(result.errors[0]).toContain('unit not found')
  })
})

describe('installService launchd / windows / unsupported', () => {
  it('launchd：plist 含 RunAtLoad/KeepAlive 与内核路径，bootstrap 被调用', () => {
    const { exec, calls } = recordingExec({ 'id -u': ok('501\n') })
    const result = installService(input, { exec, home, flavor: 'launchd' })

    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.mihomo-tui.mihomo.plist')
    expect(result.definitionPath).toBe(plistPath)
    expect(result.enabled).toBe(true)
    const plist = readFileSync(plistPath, 'utf8')
    expect(plist).toContain('<string>/opt/fake/bin/mihomo</string>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(calls.some((c) => c.join(' ') === 'launchctl bootstrap gui/501 ' + plistPath)).toBe(true)
  })

  it('windows：计划任务 ONLOGON 且 /TR 带引号包裹路径', () => {
    const { exec, calls } = recordingExec()
    const result = installService(input, { exec, home, flavor: 'windows' })
    expect(result.enabled).toBe(true)
    const create = calls.find((c) => c[0] === 'schtasks')
    expect(create).toBeDefined()
    expect(create).toContain('/SC')
    expect(create).toContain('ONLOGON')
    expect(create?.includes(`"${BIN}" -d "${DIR}"`)).toBe(true)
  })

  it('unsupported：返回说明，不执行任何命令', () => {
    const { exec, calls } = recordingExec()
    const result = installService(input, { exec, home, flavor: 'unsupported' })
    expect(result.enabled).toBe(false)
    expect(result.message).toBeTruthy()
    expect(calls).toEqual([])
  })
})

describe('uninstallService', () => {
  it('systemd：disable --now + 删除单元文件 + daemon-reload', () => {
    const unitPath = join(home, '.config', 'systemd', 'user', 'mihomo.service')
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(unitPath, 'unit\n', 'utf8')

    const { exec, calls } = recordingExec()
    const result = uninstallService({ exec, home, flavor: 'systemd' })
    expect(result.removed).toBe(true)
    expect(existsSync(unitPath)).toBe(false)
    expect(calls.some((c) => c.join(' ') === 'systemctl --user disable --now mihomo')).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'systemctl --user daemon-reload')).toBe(true)
  })

  it('windows：schtasks /Delete', () => {
    const { exec, calls } = recordingExec()
    const result = uninstallService({ exec, home, flavor: 'windows' })
    expect(result.removed).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'schtasks /Delete /F /TN mihomo')).toBe(true)
  })
})

describe('detectFlavor', () => {
  it('显式传入优先', () => {
    expect(detectFlavor({ flavor: 'launchd' })).toBe('launchd')
  })
  it('systemctl 不在 PATH（ENOENT）→ unsupported', () => {
    const exec: ServiceExec = () => ({ status: null, error: Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' }) })
    expect(detectFlavor({ exec })).toBe('unsupported')
  })
  it('systemctl 存在（即使 degraded 退出 1）→ systemd', () => {
    const exec: ServiceExec = () => ({ status: 1, stdout: 'degraded\n' })
    expect(detectFlavor({ exec })).toBe('systemd')
  })
})
