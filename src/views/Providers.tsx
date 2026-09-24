/** 标签页 2：订阅（Providers），v0.2.0 起支持在 TUI 内增删改订阅 */
import { useEffect, useMemo, useState } from 'react'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Box, Text, useInput } from 'ink'
import { ScrollList } from '../components/ScrollList.js'
import { spinnerFrame } from '../components/DelayBadge.js'
import { FooterLine, type FooterHint } from '../ui/FooterLine.js'
import { Panel } from '../ui/Panel.js'
import { colors, styles, toneColor, type Tone } from '../ui/theme.js'
import { progressBar } from '../components/ProgressDialog.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { InputDialog, type InputField } from '../components/InputDialog.js'
import { TextEditor } from '../components/TextEditor.js'
import { ProgressDialog } from '../components/ProgressDialog.js'
import { formatBytes, formatRelativeTime, fitDisplay, padDisplay } from '../commands/output.js'
import type { ProviderRow } from '../hooks/useProviders.js'
import type { UseProvidersResult } from '../hooks/useProviders.js'
import type { AppConfig } from '../config.js'
import {
  ADD_STEPS,
  DELETE_STEPS,
  EDIT_STEPS,
  depsFromAppConfig,
  addSubscription,
  deleteSubscription,
  editSubscription,
} from '../config/subscriptionService.js'
import type { ServiceDeps, Step } from '../config/subscriptionService.js'
import { ConfigManager } from '../config/manager.js'
import { loadSubscriptions } from '../config/subscriptions.js'
import { useKeyCapture } from '../ui/keyCapture.js'
import type { Subscription } from '../config/types.js'
import { checkProxyFile } from './yamlFile.js'
import { validateGroupInput, validateIntervalInput, validateNameInput, validateUrlInput } from './subscriptionFields.js'

/** 到期语义（纯函数）：长期/已过期/7 天内警告/普通剩余天数 */
export function expireInfo(
  expire: number | undefined,
  now: number,
): { text: string; tone: Tone | undefined } {
  if (!expire) return { text: '长期', tone: undefined }
  const days = Math.ceil((expire - now) / 86_400_000)
  if (days <= 0) return { text: '已过期', tone: 'negative' }
  if (days < 7) return { text: `${days}天`, tone: 'caution' }
  return { text: `${days}天`, tone: undefined }
}

/** 使用率条语义（纯函数）：剩余 <10% 转红，其余绿色；无总量则不渲染条 */
export function usageBar(
  row: Pick<ProviderRow, 'remaining'> & { usage?: { used: number; total: number } },
  barWidth = 12,
): { text: string; tone: Tone } | undefined {
  const { remaining, usage } = row
  if (!usage || usage.total <= 0 || remaining === undefined) return undefined
  const fraction = Math.min(1, Math.max(0, usage.used / usage.total))
  const tone: Tone = remaining / usage.total < 0.1 ? 'negative' : 'positive'
  return { text: progressBar(fraction, barWidth), tone }
}

const HINTS: FooterHint[] = [
  { key: '↑↓', label: '移动' },
  { key: 'a', label: '新增' },
  { key: 'd', label: '删除' },
  { key: 'e', label: '编辑' },
  { key: 'o', label: '编辑文件' },
  { key: 'u', label: '更新' },
  { key: 'U', label: '全部更新' },
  { key: 'c', label: '健康检查' },
  { key: 'r', label: '刷新' },
]

export interface ProvidersViewProps {
  providers: UseProvidersResult
  height: number
  width: number
  tick: number
  active: boolean
  onMessage: (text: string) => void
  /** 应用配置（mihomoDir 在 v0.2.0 起是关键配置） */
  config: AppConfig
  /** 订阅增删改事务成功后回调（App 用它触发节点页立即刷新，不等轮询） */
  onChanged?: () => void
  /** 测试注入用；缺省时由 config 构造（真实 ConfigManager/ServiceManager） */
  serviceDeps?: ServiceDeps
}

type DialogState =
  | { type: 'none' }
  | { type: 'input'; title: string; fields: InputField[]; submitLabel: string }
  | { type: 'confirm'; message: string[]; danger: boolean }
  | { type: 'editor'; name: string; text: string }
  | {
      type: 'progress'
      title: string
      steps: Step[]
      step: number
      currentLabel: string
      completed: string[]
    }
  | { type: 'error'; message: string[] }

export function ProvidersView({
  providers,
  height,
  width,
  tick,
  active,
  onMessage,
  config,
  onChanged,
  serviceDeps,
}: ProvidersViewProps) {
  const [index, setIndex] = useState(0)
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' })
  const rows = providers.providers

  const deps = useMemo(
    () => serviceDeps ?? depsFromAppConfig(config),
    [serviceDeps, config],
  )

  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1))
  }, [rows.length, index])

  const current = rows[index]

  /** 统一的事务执行：进度对话框 → 成功消息/警告 → 失败转错误对话框 */
  const runFlow = async (
    title: string,
    steps: Step[],
    run: (onProgress: (current: Step, completed: Step[]) => void) => Promise<string | undefined>,
  ): Promise<void> => {
    setDialog({
      type: 'progress',
      title,
      steps,
      step: 0,
      currentLabel: steps[0]?.label ?? '',
      completed: [],
    })
    try {
      const message = await run((currentStep, completedSteps) => {
        setDialog({
          type: 'progress',
          title,
          steps,
          step: Math.max(0, steps.findIndex((s) => s.key === currentStep.key)),
          currentLabel: currentStep.label,
          completed: completedSteps.map((s) => s.label),
        })
      })
      setDialog({ type: 'none' })
      providers.refresh()
      // 配置与内核已随事务重启变化，让节点页也立即重拉（组列表增删）
      onChanged?.()
      if (message) onMessage(message)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setDialog({ type: 'error', message: text.split('\n') })
    }
  }

  const openAddDialog = (): void => {
    setDialog({
      type: 'input',
      title: '添加订阅',
      submitLabel: 'add',
      fields: [
        {
          label: '类型（remote 远程 / local 本地）',
          key: 'type',
          placeholder: 'remote',
          validate: (value) =>
            value && value !== 'remote' && value !== 'local'
              ? '类型只能是 remote 或 local'
              : undefined,
        },
        {
          label: '订阅名称',
          key: 'name',
          placeholder: 'my-airport',
          required: true,
          validate: (value) => {
            let known: Subscription[] = []
            try {
              known = loadSubscriptions(deps.subscriptionsPath)
            } catch {
              known = []
            }
            return validateNameInput(value, known)
          },
        },
        {
          label: '订阅 URL（本地订阅留空）',
          key: 'url',
          placeholder: 'https://...',
          validate: validateUrlInput,
        },
        {
          label: '更新间隔（分钟，留空禁用自动更新）',
          key: 'interval',
          placeholder: '如 60',
          validate: validateIntervalInput,
        },
        {
          label: '分组（可选）',
          key: 'group',
          placeholder: '如 香港专线',
          validate: validateGroupInput,
        },
      ],
    })
  }

  const openEditDialog = (): void => {
    if (!current) return
    let sub: Subscription | undefined
    try {
      sub = loadSubscriptions(deps.subscriptionsPath).find((s) => s.name === current.name)
    } catch {
      sub = undefined
    }
    setDialog({
      type: 'input',
      title: `编辑订阅：${current.name}`,
      submitLabel: 'edit',
      fields: [
        {
          label: '类型（remote 远程 / local 本地）',
          key: 'type',
          value: sub?.type ?? 'remote',
          validate: (value) =>
            value !== 'remote' && value !== 'local' ? '类型只能是 remote 或 local' : undefined,
        },
        {
          label: '订阅名称（修改即重命名）',
          key: 'name',
          value: current.name,
          required: true,
          validate: (value) => {
            let known: Subscription[] = []
            try {
              known = loadSubscriptions(deps.subscriptionsPath).filter((s) => s.name !== current.name)
            } catch {
              known = []
            }
            return validateNameInput(value, known)
          },
        },
        {
          label: '订阅 URL（本地订阅留空）',
          key: 'url',
          value: sub?.url ?? '',
          validate: (value) => (value ? validateUrlInput(value) : undefined),
        },
        {
          label: '更新间隔（分钟，留空禁用自动更新）',
          key: 'interval',
          value: sub?.interval ? String(sub.interval) : '',
          validate: validateIntervalInput,
        },
        {
          label: '分组（可选）',
          key: 'group',
          value: sub?.group ?? '',
          validate: validateGroupInput,
        },
      ],
    })
  }

  const openEditor = (): void => {
    if (!current) return
    const manager = deps.manager ?? new ConfigManager(config?.mihomoDir)
    const path = manager.providerCachePath(current.name)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : 'proxies: []\n'
    setDialog({ type: 'editor', name: current.name, text })
  }

  const saveEditor = (name: string, text: string): void => {
    const manager = deps.manager ?? new ConfigManager(config?.mihomoDir)
    const path = manager.providerCachePath(name)
    manager.ensureProvidersDir()
    writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    // 远程订阅手动编辑后锁定，防止内核按 URL 重新拉取覆盖
    let sub: Subscription | undefined
    try {
      sub = loadSubscriptions(deps.subscriptionsPath).find((s) => s.name === name)
    } catch {
      sub = undefined
    }
    if (sub?.type === 'remote' && !sub.locked) {
      void runFlow('锁定订阅', EDIT_STEPS, async (onProgress) => {
        await editSubscription(name, { locked: true }, { ...deps, onProgress })
        return `已保存并锁定订阅 ${name}（自动更新已禁用）`
      })
      return
    }
    setDialog({ type: 'none' })
    onMessage(`已保存订阅文件 ${name}`)
  }

  const openDeleteConfirm = (): void => {
    if (!current) return
    setDialog({
      type: 'confirm',
      danger: true,
      message: [
        `确认删除订阅 ${current.name}？`,
        '对应代理组将从配置中移除，缓存文件将被清理',
        'mihomo 服务将自动重启',
        '此操作不可撤销！',
      ],
    })
  }

  // 错误对话框「任意键关闭」期间捕获按键，避免全局键穿透
  useKeyCapture(dialog.type === 'error')
  useInput(
    (input, key) => {
      // 错误对话框：任意键关闭
      if (dialog.type === 'error') {
        setDialog({ type: 'none' })
        return
      }
      // 对话框打开时，视图不处理任何键（由对话框自己处理）
      if (dialog.type !== 'none') return

      if (key.upArrow || input === 'k') {
        setIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setIndex((i) => Math.min(rows.length - 1, i + 1))
        return
      }
      // 设计稿 8.2：更新进行中不允许打开新对话框
      if ((input === 'a' || input === 'd' || input === 'e' || input === 'o') && rows.some((row) => row.updating)) {
        onMessage('订阅更新进行中，请稍后再试')
        return
      }
      if (input === 'a') {
        openAddDialog()
        return
      }
      if (input === 'd') {
        if (!current) {
          onMessage('没有可删除的订阅')
          return
        }
        openDeleteConfirm()
        return
      }
      if (input === 'e') {
        if (!current) {
          onMessage('没有可编辑的订阅')
          return
        }
        openEditDialog()
        return
      }
      if (input === 'o') {
        if (!current) {
          onMessage('没有可编辑的订阅')
          return
        }
        openEditor()
        return
      }
      if (input === 'u' && current) {
        onMessage(`正在更新 ${current.name} ...`)
        void providers.update(current.name).then(() => {
          onMessage(`${current.name} 更新完成`)
        })
        return
      }
      if (input === 'U') {
        onMessage('正在更新全部订阅 ...')
        void providers.updateAll().then(() => onMessage('全部订阅更新完成'))
        return
      }
      if (input === 'c' && current) {
        onMessage(`正在检查 ${current.name} ...`)
        void providers.check(current.name).then(() => onMessage(`${current.name} 健康检查完成`))
        return
      }
      if (input === 'r') {
        providers.refresh()
        onMessage('已刷新')
      }
    },
    { isActive: active },
  )

  // Panel 顶线/底边共 2 行
  const listHeight = Math.max(3, height - 6)

  // 列宽：窄终端收窄使用率条。
  // 表格最小可用宽度约 72 列（更窄表头会折行）；spec 只承诺页脚降级与
  // Panel<20 退化，更窄档位留待后续按需收窄 UPDATED/EXPIRES。
  const barWidth = width >= 100 ? 14 : 10
  // 末尾 +1 列给条与 UPDATED 之间留呼吸空隙
  const usageColWidth = 10 + 1 + barWidth + 2 + 1

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* 模态语义：对话框打开时替代页面内容独占 body（对齐 cc-switch
        FullScreenPanel / mihari 模态占屏）——固定高度下卡片与表格互相
        挤压，窄终端（24 行）内层输入盒会被压塌错边 */}
      {dialog.type !== 'none' ? (
        <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
          {dialog.type === 'editor' ? (
            <TextEditor
              title={`编辑订阅文件 · ${dialog.name}.yaml`}
              initialText={dialog.text}
              height={height}
              width={Math.min(width, 100)}
              validate={(text) => {
                const result = checkProxyFile(text)
                return result.ok ? undefined : result.error
              }}
              onSave={(text) => saveEditor(dialog.name, text)}
              onCancel={() => setDialog({ type: 'none' })}
            />
          ) : null}
          {dialog.type === 'input' ? (
            <InputDialog
              title={dialog.title}
              fields={dialog.fields}
              width={width}
              onSubmit={(values) => {
                const name = values['name'] ?? ''
                const type = (values['type'] || 'remote') as 'remote' | 'local'
                const url = values['url'] ?? ''
                const group = values['group'] ?? ''
                const intervalText = (values['interval'] ?? '').trim()
                const interval = intervalText ? Number(intervalText) : 0
                const fields = {
                  name,
                  type,
                  url,
                  group: group || undefined,
                  interval,
                }
                if (dialog.submitLabel === 'add') {
                  void runFlow('添加订阅', ADD_STEPS, async (onProgress) => {
                    const result = await addSubscription(fields, { ...deps, onProgress })
                    return result.warnings[0] ?? `已添加订阅 ${name}`
                  })
                } else {
                  void runFlow('编辑订阅', EDIT_STEPS, async (onProgress) => {
                    const result = await editSubscription(current?.name ?? name, fields, {
                      ...deps,
                      onProgress,
                    })
                    if (result.unchanged) {
                      setDialog({ type: 'none' })
                      return '未做修改'
                    }
                    return result.warnings[0] ?? `已更新订阅 ${name}`
                  })
                }
              }}
              onCancel={() => setDialog({ type: 'none' })}
            />
          ) : null}
          {dialog.type === 'confirm' ? (
            <ConfirmDialog
              message={dialog.message}
              danger
              onConfirm={() => {
                const name = current?.name ?? ''
                void runFlow('删除订阅', DELETE_STEPS, async (onProgress) => {
                  await deleteSubscription(name, { ...deps, onProgress })
                  return `已删除订阅 ${name}`
                })
              }}
              onCancel={() => setDialog({ type: 'none' })}
            />
          ) : null}
          {dialog.type === 'progress' ? (
            <ProgressDialog
              title={dialog.title}
              current={dialog.currentLabel}
              total={dialog.steps.length}
              step={dialog.step}
              completed={dialog.completed}
            />
          ) : null}
          {dialog.type === 'error' ? (
            <Panel danger title="操作失败" width={width}>
              {dialog.message.map((line, i) => (
                <Text key={i} color={colors.danger} wrap="wrap">{line}</Text>
              ))}
              <Text {...styles.keyHint}>按任意键关闭</Text>
            </Panel>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          {/* 非展开且无错误盒时主列表撑满到页脚（对齐日志/连接页的底框贴底）；
              row 包裹层让交叉轴 stretch 拉伸 Panel，fillHeight 随之生效 */}
          <Box flexDirection="row" flexGrow={current?.error ? undefined : 1}>
            <Panel
              title={`订阅 · ${rows.length}`}
              width={width}
              fillHeight={!current?.error}
            >
            <Text {...styles.tableHeader}>
              {padDisplay('NAME', 14)}
              {padDisplay('NODES', 12)}
              {padDisplay('USAGE', usageColWidth)}
              {padDisplay('UPDATED', 12)}
              {'EXPIRES'}
            </Text>
            <ScrollList
              items={rows}
              selected={index}
              height={listHeight}
              emptyText="当前配置没有 proxy-providers（按 a 添加订阅）"
              renderItem={(row, _i, isSelected) => {
                const bar = usageBar(row, barWidth)
                const expire = expireInfo(row.expire, Date.now())
                return (
                  <Text>
                    {/* ▌ 属 ambiguous 宽度字符（部分终端 2 列），依赖列宽余量吸收 */}
                    {isSelected ? <Text {...styles.rowFocus}>{'▌'}</Text> : ' '}
                    {` ${padDisplay(fitDisplay(row.name, 12), 12)}`}
                    {row.updating ? (
                      <Text color={colors.info}>{padDisplay(`${spinnerFrame(tick)} 更新中`, 12)}</Text>
                    ) : (
                      <Text color={row.alive > 0 ? colors.success : colors.danger}>
                        {padDisplay(`${row.alive}/${row.nodes}`, 12)}
                      </Text>
                    )}
                    <Text color={colors.muted}>
                      {padDisplay(row.remaining === undefined ? '---' : formatBytes(row.remaining), 10)}
                    </Text>
                    {bar ? (
                      <Text color={toneColor[bar.tone]}>{padDisplay(` ${bar.text}`, usageColWidth - 10)}</Text>
                    ) : (
                      padDisplay(' ---', usageColWidth - 10)
                    )}
                    <Text {...styles.keyHint}>
                      {padDisplay(formatRelativeTime(row.updatedAt), 12)}
                    </Text>
                    <Text color={expire.tone ? toneColor[expire.tone] : colors.muted}>
                      {expire.text}
                    </Text>
                  </Text>
                )
              }}
            />
            </Panel>
          </Box>

          {/* 更新失败是常态（域名失效、经代理 403），错误必须完整展示 */}
          {current?.error ? (
            <Panel danger title={`${current.name} 更新失败`} width={width}>
              <Text color={colors.danger} wrap="wrap">
                {current.error}
              </Text>
            </Panel>
          ) : null}

        </Box>
      )}

      <Box paddingLeft={1}>
        <FooterLine hints={HINTS} width={width - 2} />
      </Box>
    </Box>
  )
}
