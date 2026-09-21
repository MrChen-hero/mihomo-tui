/**
 * 状态语义分类器（2026-09-22 标准化美化）
 *
 * 为各类业务状态（订阅/内核/连接）提供统一的语义色映射与词汇表，
 * 避免每个组件独立维护颜色逻辑和文案。
 */

import type { Tone } from './theme.js'

/** 订阅状态类型 */
export type SubscriptionState = 'normal' | 'expiring' | 'expired' | 'unknown'

/** 内核版本状态类型 */
export type KernelVersionState = 'latest' | 'updateAvailable' | 'checking' | 'unknown'

/**
 * 订阅状态 → 语义色（纯函数）
 *
 * @example
 * subscriptionTone('normal') // => 'positive'
 * subscriptionTone('expired') // => 'caution'
 */
export function subscriptionTone(state: SubscriptionState): Tone {
  switch (state) {
    case 'normal':
      return 'positive'
    case 'expiring':
      return 'caution'
    case 'expired':
      return 'caution'
    case 'unknown':
    default:
      return 'neutral'
  }
}

/**
 * 内核版本状态 → 语义色（纯函数）
 *
 * @example
 * kernelVersionTone('updateAvailable') // => 'caution'
 * kernelVersionTone('latest') // => 'positive'
 */
export function kernelVersionTone(state: KernelVersionState): Tone {
  switch (state) {
    case 'latest':
      return 'positive'
    case 'updateAvailable':
      return 'caution'
    case 'checking':
    case 'unknown':
    default:
      return 'neutral'
  }
}

/**
 * 订阅状态中文词表（纯函数）
 *
 * @example
 * subscriptionLabel('normal') // => '正常'
 * subscriptionLabel('expired') // => '已过期'
 */
export function subscriptionLabel(state: SubscriptionState): string {
  switch (state) {
    case 'normal':
      return '正常'
    case 'expiring':
      return '即将到期'
    case 'expired':
      return '已过期'
    case 'unknown':
    default:
      return '未知'
  }
}

/**
 * 内核版本状态中文词表（纯函数）
 *
 * @example
 * kernelVersionLabel('updateAvailable') // => '可更新'
 * kernelVersionLabel('latest') // => '最新'
 */
export function kernelVersionLabel(state: KernelVersionState): string {
  switch (state) {
    case 'latest':
      return '最新'
    case 'updateAvailable':
      return '可更新'
    case 'checking':
      return '检查中'
    case 'unknown':
    default:
      return '未知'
  }
}

/**
 * 通用状态文本 → 语义色分类器（纯函数）
 *
 * 支持中英文关键词匹配，用于业务层从任意状态字符串推断语义色调。
 * 子串匹配、忽略大小写、忽略前后空格。
 *
 * @example
 * classifyTone('connected') // => 'positive'
 * classifyTone('重连中') // => 'caution'
 * classifyTone('failed') // => 'negative'
 * classifyTone('unknown') // => 'neutral'
 */
export function classifyTone(text: string): Tone {
  const normalized = text.trim().toLowerCase()

  // Negative 故障态：断开、失败、错误、已过期（优先级最高，避免被 connected 子串误判）
  if (
    normalized.includes('disconnect') ||
    normalized.includes('failed') ||
    normalized.includes('error') ||
    normalized.includes('断开') ||
    normalized.includes('失败') ||
    normalized.includes('已过期')
  ) {
    return 'negative'
  }

  // Positive 健康态：已连接、运行中、成功、正常
  if (
    normalized.includes('connected') ||
    normalized.includes('running') ||
    normalized.includes('success') ||
    normalized.includes('healthy') ||
    normalized.includes('已连接') ||
    normalized.includes('运行中') ||
    normalized.includes('正常')
  ) {
    return 'positive'
  }

  // Caution 注意态：重连中、警告、可更新、即将到期
  if (
    normalized.includes('reconnecting') ||
    normalized.includes('warning') ||
    normalized.includes('pending') ||
    normalized.includes('重连中') ||
    normalized.includes('可更新') ||
    normalized.includes('即将到期')
  ) {
    return 'caution'
  }

  // Neutral 中性态：未知、空闲、已关闭、其他未匹配文本
  return 'neutral'
}
