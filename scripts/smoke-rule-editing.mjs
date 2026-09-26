/** Isolated real-kernel acceptance. Only this script's temp directory and child are touched. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import YAML from 'yaml'
import { ConfigManager } from '../dist/config/manager.js'
import { RuleService, runtimeMatches } from '../dist/config/ruleService.js'
import { MihomoClient } from '../dist/api/client.js'
import { addRule, editRule, moveRule, deleteRule } from '../dist/rules/editor.js'

const bin = resolve(process.argv[2] ?? '/4t/usr/chenjw/bin/mihomo')
const version = execFileSync(bin, ['-v'], { encoding: 'utf8' }).split('\n')[0]
assert.match(version, /v1\.19\.24/)
const server = createServer()
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const dir = mkdtempSync(join(tmpdir(), 'mihomo-rule-acceptance-'))
const path = join(dir, 'config.yaml'), subscriptionsPath = join(dir, 'subs.json')
const config = { 'mixed-port': 0, port: 0, 'socks-port': 0, 'external-controller': `127.0.0.1:${port}`, secret: '',
  dns: { enable: false }, mode: 'rule', ipv6: true,
  rules: ['DOMAIN,sub.example,DIRECT', 'DOMAIN,a.example,DIRECT', 'MATCH,DIRECT'] }
writeFileSync(path, YAML.stringify(config), { mode: 0o600 })
writeFileSync(subscriptionsPath, '{"subscriptions":[{"name":"isolated","url":"https://sub.example/sub"}]}')
const child = spawn(bin, ['-d', dir, '-f', path], { stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''; child.stdout.on('data', data => { logs = (logs + data).slice(-4000) }); child.stderr.on('data', data => { logs = (logs + data).slice(-4000) })
const client = new MihomoClient({ api: `http://127.0.0.1:${port}`, secret: '', mihomoDir: dir, testUrl: '', testTimeout: 1000 })
const manager = new ConfigManager(dir, bin)
const service = new RuleService({ manager, client, controller: client.api, subscriptionsPath })
const results = []
try {
  for (let attempt = 0; ; attempt++) {
    try { await client.version(); break } catch {
      if (attempt > 60 || child.exitCode !== null) throw new Error('Isolated kernel did not start: ' + logs)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  async function save(label, change) {
    const snapshot = service.open()
    const draft = change(snapshot.draft)
    const result = await service.save(snapshot, draft)
    assert.equal(result.status, 'confirmed', JSON.stringify(result))
    assert.deepEqual(YAML.parse(readFileSync(path, 'utf8')).rules, draft.rows.map(row => row.raw))
    results.push({ operation: label, disk: result.disk, kernel: result.kernel, rules: result.rules.map(r => `${r.type},${r.payload},${r.proxy}`) })
  }
  await save('add', draft => addRule(draft, 'DOMAIN,b.example,REJECT'))
  await save('edit', draft => editRule(draft, draft.rows[2].id, 'DOMAIN,c.example,DIRECT'))
  await save('move', draft => moveRule(draft, draft.rows[2].id, -1))
  await save('delete', draft => deleteRule(draft, draft.rows[1].id))
  const snapshot = service.open(), bytes = readFileSync(path)
  const invalid = await service.save(snapshot, addRule(snapshot.draft, 'INVALID,a,DIRECT'))
  assert.equal(invalid.status, 'not-applied'); assert.equal(invalid.phase, 'validate')
  assert.ok(readFileSync(path).equals(bytes)); results.push({ operation: 'invalid blocked', status: invalid.status })
  let reloadCount = 0
  const recovery = new RuleService({ manager, subscriptionsPath, controller: client.api, client: {
    rules: () => client.rules(), reload: async path => { await client.reload(path); if (++reloadCount === 1) throw new Error('Injected lost response after accepted reload') },
  } })
  const recovered = await recovery.save(snapshot, addRule(snapshot.draft, 'DOMAIN,recover.example,REJECT'))
  assert.equal(recovered.status, 'restored', JSON.stringify(recovered)); assert.equal(reloadCount, 2)
  assert.ok(readFileSync(path).equals(bytes)); results.push({ operation: 'uncertain reload recovery', status: recovered.status, kernel: recovered.kernel })
  // Probe the exact field mapping for all form families before asserting it in the service.
  const probe = { ...config, 'rule-providers': { local: { type: 'inline', behavior: 'domain', payload: ['rule.example'] } },
    rules: ['DOMAIN,sub.example,DIRECT', 'DOMAIN,UPPER.Example,DIRECT', 'DOMAIN-SUFFIX,EXAMPLE.COM,DIRECT', 'DOMAIN-KEYWORD,ABC,DIRECT',
    'IP-CIDR,192.168.1.10/24,DIRECT,no-resolve', 'IP-CIDR6,2001:DB8::1/32,DIRECT,no-resolve',
    'SRC-IP-CIDR,10.1.2.3/8,DIRECT', 'SRC-PORT,80-90,DIRECT', 'DST-PORT,443,DIRECT',
    'PROCESS-NAME,Curl,DIRECT', 'PROCESS-PATH,/usr/bin/Curl,DIRECT', 'RULE-SET,local,DIRECT', 'AND,((DOMAIN,a.example),(NETWORK,TCP)),DIRECT',
    'DOMAIN-SUFFIX,.example.com,DIRECT', 'DOMAIN,测试.中国,DIRECT', 'DST-PORT,080,DIRECT', 'SRC-PORT,080-090,DIRECT', 'MATCH,DIRECT'] }
  manager.writeRuleBytes(Buffer.from(YAML.stringify(probe)), snapshot.attributes)
  await client.reload(path)
  const mapped = await client.rules()
  assert.ok(runtimeMatches(service.open().draft, mapped), 'Every observable form field must match the real kernel: ' + JSON.stringify(mapped.map(({ type, payload, proxy }) => ({ type, payload, proxy }))))
  results.push({ operation: 'mapping probe', rules: mapped.map(({ type, payload, proxy }) => ({ type, payload, proxy })) })
  await save('all form families and complex rule preserved', draft => addRule(draft, 'DOMAIN,last.example,DIRECT'))
  console.log(JSON.stringify({ version, isolatedDirectory: dir, results }, null, 2))
} finally {
  if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'close') }
  rmSync(dir, { recursive: true, force: true })
}
