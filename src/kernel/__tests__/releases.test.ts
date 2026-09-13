/**
 * release 数据与资产选择规则的单测（spec settings-kernel §3.4）：
 * 全部 mock fetch。资产命名 mihomo-<goos>-<goarch>-<tag>.gz、amd64 的
 * compatible 回退、alpha sha 解析、语义化版本比较。
 */
import { describe, expect, it } from 'vitest'
import {
  alphaShaFromAssetName,
  assetNamesFor,
  fetchAlphaRelease,
  isNewerVersion,
  listStableReleases,
  selectAlphaAsset,
  selectAsset,
  type ReleaseInfo,
} from '../releases.js'

function releaseJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    tag_name: 'v1.19.30',
    published_at: '2026-09-01T00:00:00Z',
    prerelease: false,
    draft: false,
    assets: [
      { name: 'mihomo-linux-amd64-v1.19.30.gz', size: 18899951, digest: 'sha256:abc' },
      { name: 'mihomo-linux-amd64-compatible-v1.19.30.gz', size: 18800000 },
      { name: 'mihomo-linux-arm64-v1.19.30.gz', size: 18000000 },
      { name: 'checksums.txt', size: 1000 },
    ],
    ...overrides,
  }
}

describe('资产命名与选择', () => {
  it('assetNamesFor：x64 → amd64，附带 compatible 回退名', () => {
    expect(assetNamesFor('v1.19.30', 'linux', 'x64')).toEqual([
      'mihomo-linux-amd64-v1.19.30.gz',
      'mihomo-linux-amd64-compatible-v1.19.30.gz',
    ])
    expect(assetNamesFor('v1.19.30', 'linux', 'arm64')).toEqual(['mihomo-linux-arm64-v1.19.30.gz'])
  })

  it('selectAsset：精确命中主资产；缺失时回退 compatible', () => {
    const release: ReleaseInfo = {
      tag: 'v1.19.30',
      assets: [
        { name: 'mihomo-linux-amd64-compatible-v1.19.30.gz', size: 18800000 },
        { name: 'mihomo-linux-amd64-v1.19.30.gz', size: 18899951, digest: 'sha256:abc' },
      ],
    }
    expect(selectAsset(release, 'v1.19.30', 'linux', 'x64')?.name).toBe(
      'mihomo-linux-amd64-v1.19.30.gz',
    )
    const noPrimary: ReleaseInfo = {
      tag: 'v1.19.30',
      assets: [{ name: 'mihomo-linux-amd64-compatible-v1.19.30.gz', size: 18800000 }],
    }
    expect(selectAsset(noPrimary, 'v1.19.30', 'linux', 'x64')?.name).toBe(
      'mihomo-linux-amd64-compatible-v1.19.30.gz',
    )
    expect(selectAsset({ tag: 'v1.19.30', assets: [] }, 'v1.19.30', 'linux', 'x64')).toBeUndefined()
  })

  it('selectAlphaAsset 与 sha 解析', () => {
    const alpha: ReleaseInfo = {
      tag: 'Prerelease-Alpha',
      assets: [
        { name: 'mihomo-linux-amd64-alpha-2af83f4.gz', size: 19000000 },
        { name: 'mihomo-linux-arm64-alpha-2af83f4.gz', size: 18000000 },
      ],
    }
    const asset = selectAlphaAsset(alpha, 'linux', 'x64')
    expect(asset?.name).toBe('mihomo-linux-amd64-alpha-2af83f4.gz')
    expect(alphaShaFromAssetName(asset!.name)).toBe('2af83f4')
    expect(alphaShaFromAssetName('mihomo-linux-amd64-v1.19.30.gz')).toBeUndefined()
  })
})

describe('版本列表请求', () => {
  it('listStableReleases 过滤 prerelease/draft 并解析资产', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          releaseJson(),
          releaseJson({ tag_name: 'v1.19.31-rc', prerelease: true }),
          releaseJson({ tag_name: 'v1.19.32', draft: true }),
          { nope: true },
        ]),
        { status: 200 },
      )) as unknown as typeof fetch
    const releases = await listStableReleases({ fetchImpl })
    expect(releases).toHaveLength(1)
    expect(releases[0]?.tag).toBe('v1.19.30')
    // 资产原样保留（含 checksums.txt），选择时精确匹配
    expect(releases[0]?.assets).toHaveLength(4)
    expect(releases[0]?.publishedAt).toBe('2026-09-01T00:00:00Z')
  })

  it('fetchAlphaRelease 返回 Alpha tag 数据；缺 tag_name 报错', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(releaseJson({ tag_name: 'Prerelease-Alpha' })), { status: 200 })) as unknown as typeof fetch
    const alpha = await fetchAlphaRelease({ fetchImpl })
    expect(alpha.tag).toBe('Prerelease-Alpha')

    const bad = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    await expect(fetchAlphaRelease({ fetchImpl: bad })).rejects.toThrow(/tag_name/)
  })
})

describe('isNewerVersion 版本比较', () => {
  it('逐段数值比较，位数不足按 0 补齐', () => {
    expect(isNewerVersion('v1.19.30', 'v1.19.24')).toBe(true)
    expect(isNewerVersion('v1.19.9', 'v1.19.24')).toBe(false)
    expect(isNewerVersion('v1.20.0', 'v1.19.99')).toBe(true)
    expect(isNewerVersion('v2.0', 'v1.19.24')).toBe(true)
    expect(isNewerVersion('v1.19.24', 'v1.19.24')).toBe(false)
  })

  it('无法解析时按字符串不等判定（alpha 等非标 tag）', () => {
    expect(isNewerVersion('alpha-abc', 'v1.19.24')).toBe(true)
    expect(isNewerVersion('v1.19.24', 'alpha-abc')).toBe(true)
  })
})
