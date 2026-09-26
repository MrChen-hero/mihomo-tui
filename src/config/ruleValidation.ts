/** Explicit isolated resources for rule validation. Never run -t in the live directory. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'

export function safeDiagnostic(value: unknown, secrets: string[] = []): string {
  let text = value instanceof Error ? value.message : String(value)
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('<REDACTED>')
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '<URL>')
    .replace(/(secret|password|token|authorization|uuid|private-key)\s*[:=]\s*[^\s,}"']+/gi, '$1=<REDACTED>')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 4000)
}

export function validationSecrets(text: string): string[] {
  const result: string[] = []
  const walk = (v: unknown, key = ''): void => {
    if (typeof v === 'string' && /secret|password|token|uuid|private-key|authorization/i.test(key)) result.push(v)
    if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) walk(child, k)
  }
  try { walk(YAML.parse(text)) } catch { /* Invalid YAML is handled by validation. */ }
  return result
}

export function prepareRuleValidation(text: string, sourceDir: string, targetDir: string): void {
  const root = realpathSync(sourceDir)
  const copy = (path: string): void => {
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new Error('不支持外部绝对资源路径：' + path)
    const source = resolve(root, path)
    const rel = relative(root, source)
    if (!rel || rel === '..' || rel.startsWith('..' + sep)) throw new Error('资源路径逃逸数据目录：' + path)
    if (!existsSync(source)) throw new Error('缺少校验资源：' + path)
    const realRel = relative(root, realpathSync(source))
    if (realRel === '..' || realRel.startsWith('..' + sep) || !lstatSync(source).isFile()) throw new Error('资源无法隔离：' + path)
    const destination = resolve(targetDir, rel)
    if (rel === 'config.yaml') throw new Error('资源路径与校验配置冲突')
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  const config = YAML.parse(text) as Record<string, unknown>
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置顶层必须是映射')
  // These resource-bearing options are outside the supported isolated context.
  const reject = new Set(['external-ui', 'external-ui-path', 'certificate', 'private-key', 'ca', 'ca-cert', 'client-cert', 'client-key', 'script'])
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (reject.has(key) && child) throw new Error('无法隔离的配置依赖：' + key)
      if (key === 'path' && typeof child === 'string') copy(child)
      else walk(child)
    }
  }
  walk(config)
  // Cached geodata is copied at the standard paths recognized by mihomo.
  const geodata = ['geoip.dat', 'geosite.dat', 'country.mmdb', 'GeoLite2-ASN.mmdb']
  for (const name of geodata) if (existsSync(resolve(root, name))) copy(name)
  const serialized = JSON.stringify(config)
  if (/GEOSITE|geosite:/i.test(serialized) && !existsSync(resolve(targetDir, 'geosite.dat'))) throw new Error('缺少 geosite.dat')
  if (/GEOIP|geoip:/i.test(serialized)) {
    const name = config['geodata-mode'] === true ? 'geoip.dat' : 'country.mmdb'
    if (!existsSync(resolve(targetDir, name))) throw new Error('缺少 ' + name)
  }
  if (/IP-ASN/i.test(serialized) && !existsSync(resolve(targetDir, 'GeoLite2-ASN.mmdb'))) throw new Error('缺少 GeoLite2-ASN.mmdb')
  for (const key of ['proxy-providers', 'rule-providers']) {
    const providers = config[key]
    if (providers && typeof providers === 'object') for (const provider of Object.values(providers)) {
      if (provider && typeof provider === 'object' && provider.type !== 'inline' && typeof provider.path !== 'string') {
        throw new Error('provider 缺少可隔离的相对缓存路径')
      }
    }
  }
}
