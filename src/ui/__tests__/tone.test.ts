import { describe, it, expect } from 'vitest'
import { classifyTone } from '../tone'

describe('tone', () => {
  describe('classifyTone', () => {
    it('应分类 positive（英文）', () => {
      expect(classifyTone('connected')).toBe('positive')
      expect(classifyTone('running')).toBe('positive')
      expect(classifyTone('success')).toBe('positive')
      expect(classifyTone('healthy')).toBe('positive')
    })

    it('应分类 positive（中文）', () => {
      expect(classifyTone('已连接')).toBe('positive')
      expect(classifyTone('运行中')).toBe('positive')
      expect(classifyTone('正常')).toBe('positive')
    })

    it('应分类 caution（英文）', () => {
      expect(classifyTone('reconnecting')).toBe('caution')
      expect(classifyTone('warning')).toBe('caution')
      expect(classifyTone('pending')).toBe('caution')
    })

    it('应分类 caution（中文）', () => {
      expect(classifyTone('重连中')).toBe('caution')
      expect(classifyTone('可更新')).toBe('caution')
      expect(classifyTone('即将到期')).toBe('caution')
    })

    it('应分类 negative（英文）', () => {
      expect(classifyTone('disconnected')).toBe('negative')
      expect(classifyTone('failed')).toBe('negative')
      expect(classifyTone('error')).toBe('negative')
    })

    it('应分类 negative（中文）', () => {
      expect(classifyTone('断开')).toBe('negative')
      expect(classifyTone('失败')).toBe('negative')
      expect(classifyTone('已过期')).toBe('negative')
    })

    it('应分类 neutral（英文）', () => {
      expect(classifyTone('unknown')).toBe('neutral')
      expect(classifyTone('idle')).toBe('neutral')
      expect(classifyTone('closed')).toBe('neutral')
    })

    it('应分类 neutral（中文）', () => {
      expect(classifyTone('未知')).toBe('neutral')
      expect(classifyTone('空闲')).toBe('neutral')
      expect(classifyTone('已关闭')).toBe('neutral')
    })

    it('应兜底为 neutral（未知词）', () => {
      expect(classifyTone('随便什么')).toBe('neutral')
      expect(classifyTone('foobar')).toBe('neutral')
      expect(classifyTone('')).toBe('neutral')
    })

    it('应支持子串匹配', () => {
      expect(classifyTone('reconnecting...')).toBe('caution')
      expect(classifyTone('正常运行中')).toBe('positive')
      expect(classifyTone('连接失败')).toBe('negative')
    })

    it('应忽略大小写', () => {
      expect(classifyTone('CONNECTED')).toBe('positive')
      expect(classifyTone('Reconnecting')).toBe('caution')
      expect(classifyTone('ERROR')).toBe('negative')
    })

    it('应忽略前后空格', () => {
      expect(classifyTone('  connected  ')).toBe('positive')
      expect(classifyTone(' 已连接 ')).toBe('positive')
    })
  })
})
