/** 标签页 2：订阅（Providers），v0.2.0 起支持在 TUI 内增删改订阅 */
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { ScrollList } from '../components/ScrollList.js'
import { spinnerFrame } from '../components/DelayBadge.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { InputDialog, type InputField } from '../components/InputDialog.js'
import { ProgressDialog } from '../components/ProgressDialog.js'
import { formatBytes, formatRelativeTime, fitDisplay, padDisplay } from '../commands/output.js'
import type { UseProvidersResult } from '../hooks/useProviders.js'
import type { AppConfig } from '../config.js'
import {
  ADD_STEPS,
  DELETE_STEPS,
  EDIT_STEPS,
  depsFromAppConfig,
  addSubscription,
  deleteSubscription,
  editSubscriptionPrefix,
} from '../config/subscriptionService.js'
import type { ServiceDeps, Step } from '../config/subscriptionService.js'
import { loadSubscriptions } from '../config/subscriptions.js'
import type { Subscription } from '../config/types.js'
import { validateNameInput, validatePrefixInput, validateUrlInput } from './subscriptionFields.js'

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
  | { type: 'confirm'; title: string; message: string[]; danger: boolean }
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
  const [expanded, setExpanded] = useState<string | undefined>()
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

  const expandedNodes = useMemo(
    () => (expanded ? providers.nodesOf(expanded) : []),
    [expanded, providers],
  )

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
          label: '订阅 URL',
          key: 'url',
          placeholder: 'https://...',
          required: true,
          validate: validateUrlInput,
        },
        {
          label: '节点名前缀',
          key: 'prefix',
          placeholder: '可选，如 [X] ',
          validate: validatePrefixInput,
        },
      ],
    })
  }

  const openEditDialog = (): void => {
    if (!current) return
    let prefix = ''
    try {
      prefix = loadSubscriptions(deps.subscriptionsPath).find((s) => s.name === current.name)?.prefix ?? ''
    } catch {
      prefix = ''
    }
    setDialog({
      type: 'input',
      title: `编辑订阅：${current.name}`,
      submitLabel: 'edit',
      fields: [
        { label: '订阅名称', key: 'name', readOnly: true, value: current.name },
        { label: '节点名前缀', key: 'prefix', value: prefix, validate: validatePrefixInput },
      ],
    })
  }

  const openDeleteConfirm = (): void => {
    if (!current) return
    setDialog({
      type: 'confirm',
      title: '删除订阅',
      danger: true,
      message: [
        `将删除订阅：${current.name}`,
        '对应代理组将从配置中移除，缓存文件将被清理',
        'mihomo 服务将自动重启',
        '此操作不可撤销！',
      ],
    })
  }

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
      if (key.return) {
        setExpanded((prev) => (prev === current?.name ? undefined : current?.name))
        return
      }
      // 设计稿 8.2：更新进行中不允许打开新对话框
      if ((input === 'a' || input === 'd' || input === 'e') && rows.some((row) => row.updating)) {
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

  const listHeight = expanded ? Math.max(2, Math.floor((height - 5) / 2)) : Math.max(3, height - 4)

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold underline>
        {padDisplay('NAME', 14)}
        {padDisplay('NODES', 12)}
        {padDisplay('USAGE', 14)}
        {'UPDATED'}
      </Text>
      <ScrollList
        items={rows}
        selected={index}
        height={listHeight}
        emptyText="当前配置没有 proxy-providers（按 a 添加订阅）"
        renderItem={(row, _i, isSelected) => (
          <Text
            color={isSelected ? 'black' : undefined}
            backgroundColor={isSelected ? 'cyan' : undefined}
          >
            {`${isSelected ? '>' : ' '} `}
            {padDisplay(row.name, 12)}
            {row.updating ? (
              <Text color="cyan">{padDisplay(`${spinnerFrame(tick)} 更新中`, 12)}</Text>
            ) : (
              <Text color={row.alive > 0 ? 'green' : 'red'}>
                {padDisplay(`${row.alive}/${row.nodes}`, 12)}
              </Text>
            )}
            {padDisplay(row.remaining === undefined ? '---' : formatBytes(row.remaining), 14)}
            {formatRelativeTime(row.updatedAt)}
          </Text>
        )}
      />

      {/* 更新失败是常态（域名失效、经代理 403），错误必须完整展示 */}
      {current?.error && dialog.type === 'none' ? (
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
          <Text color="red" bold>
            {`${current.name} 更新失败`}
          </Text>
          <Text color="red" wrap="wrap">
            {current.error}
          </Text>
        </Box>
      ) : null}

      {expanded && dialog.type === 'none' ? (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold underline>{`${expanded} 的节点（${expandedNodes.length}）`}</Text>
          <ScrollList
            items={expandedNodes}
            selected={-1}
            height={Math.max(2, height - listHeight - 6)}
            renderItem={(node) => (
              <Text>
                {'  '}
                {fitDisplay(node.name, Math.max(20, width - 20))}
                {node.delay ? (
                  <Text color="green">{`${node.delay}ms`}</Text>
                ) : (
                  <Text dimColor>---</Text>
                )}
              </Text>
            )}
          />
        </Box>
      ) : null}

      {dialog.type === 'input' ? (
        <InputDialog
          title={dialog.title}
          fields={dialog.fields}
          onSubmit={(values) => {
            const name = values['name'] ?? ''
            const url = values['url'] ?? ''
            const prefix = values['prefix'] ?? ''
            if (dialog.submitLabel === 'add') {
              void runFlow('添加订阅', ADD_STEPS, async (onProgress) => {
                const result = await addSubscription(
                  { name, url, prefix: prefix || undefined },
                  { ...deps, onProgress },
                )
                return result.warnings[0] ?? `已添加订阅 ${name}`
              })
            } else {
              void runFlow('编辑订阅', EDIT_STEPS, async (onProgress) => {
                const result = await editSubscriptionPrefix(name, prefix || undefined, {
                  ...deps,
                  onProgress,
                })
                if (result.unchanged) {
                  setDialog({ type: 'none' })
                  return '未做修改'
                }
                return result.warnings[0] ?? `已更新订阅 ${name} 的前缀`
              })
            }
          }}
          onCancel={() => setDialog({ type: 'none' })}
        />
      ) : null}

      {dialog.type === 'confirm' ? (
        <ConfirmDialog
          title={dialog.title}
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
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" bold>操作失败</Text>
          {dialog.message.map((line, i) => (
            <Text key={i} color="red" wrap="wrap">{line}</Text>
          ))}
          <Text dimColor>按任意键关闭</Text>
        </Box>
      ) : null}

      <Text dimColor>
        {' ↑↓ 移动  a 新增  d 删除  e 编辑  u 更新  U 全部更新  c 健康检查  Enter 展开节点  r 刷新'}
      </Text>
    </Box>
  )
}
