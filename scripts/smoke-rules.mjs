#!/usr/bin/env node
/** 隔离内核验收：临时目录、随机回环端口，不读取或重载现有服务配置。
 * npm run build && node scripts/smoke-rules.mjs /absolute/path/to/mihomo
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MihomoClient } from '../dist/api/client.js'
import { DEFAULT_CONFIG } from '../dist/config.js'
import { matchRule } from '../dist/rules/matcher.js'
import { toggleRule } from '../dist/rules/runtime.js'

const binary = process.argv[2]
if (!binary || !isAbsolute(binary)) throw new Error('Usage: node scripts/smoke-rules.mjs /absolute/path/to/mihomo')
const dir = mkdtempSync(join(tmpdir(), 'mihomo-rules-smoke-'))
let payload = 'payload:\n  - DOMAIN,remote.example\n'
const provider = createServer((_req, res) => { res.end(payload) })
const probe = createServer()
let child
let childDone
let log = ''

try {
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const api = 'http://127.0.0.1:' + port
  const configPath = join(dir, 'config.yaml')
  const yaml = `mixed-port: 0
allow-lan: false
mode: rule
external-controller: 127.0.0.1:${port}
secret: rules-smoke-only
log-level: warning
dns:
  enable: false
rule-providers:
  smoke:
    type: http
    behavior: classical
    url: http://127.0.0.1:${provider.address().port}/rules.yaml
    path: ./smoke-rules.yaml
    interval: 0
rules:
  - DOMAIN,example.com,DIRECT
  - RULE-SET,smoke,REJECT
  - MATCH,DIRECT
`
  writeFileSync(configPath, yaml)
  child = spawn(binary, ['-d', dir, '-f', configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { log = (log + chunk).slice(-8000) })
  child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-8000) })
  let spawnError
  childDone = new Promise((resolve) => {
    child.once('exit', resolve)
    child.once('error', (err) => { spawnError = err; resolve() })
  })
  const client = new MihomoClient({ ...DEFAULT_CONFIG, api, secret: 'rules-smoke-only', mihomoDir: dir })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error('Isolated kernel exited: ' + log)
    try { await client.version(); ready = true; break } catch { await delay(100) }
  }
  assert.ok(ready, 'Isolated controller must start: ' + log)
  const rules = await client.rules()
  assert.equal(rules.length, 3)
  assert.equal(matchRule(rules, 'example.com').kind, 'hit')
  assert.equal(matchRule(rules, 'unknown.example').kind, 'unsupported')
  const disabled = await toggleRule(client, rules, 0)
  assert.equal(disabled.status, 'confirmed')
  assert.equal(disabled.rules[0].extra.disabled, true)
  assert.equal(matchRule(disabled.rules, 'example.com').kind, 'unsupported')
  const enabled = await toggleRule(client, disabled.rules, 0)
  assert.equal(enabled.status, 'confirmed')
  assert.equal(enabled.rules[0].extra.disabled, false)
  payload += '  - DOMAIN,second.example\n'
  await client.updateRuleProvider('smoke')
  assert.equal((await client.ruleProviders()).smoke.ruleCount, 2)
  assert.equal(readFileSync(configPath, 'utf8'), yaml, 'Runtime actions must not write config.yaml')
  console.log(JSON.stringify({ ok: true, version: (await client.version()).version,
    checks: ['rules', 'conservative-match', 'disable-readback', 'enable-readback', 'provider-update', 'config-unchanged'] }))
} finally {
  if (child && child.exitCode === null && child.pid) {
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await childDone
    clearTimeout(killTimer)
  }
  provider.closeAllConnections()
  if (provider.listening) await new Promise((resolve) => provider.close(resolve))
  if (probe.listening) await new Promise((resolve) => probe.close(resolve))
  rmSync(dir, { recursive: true, force: true })
}
