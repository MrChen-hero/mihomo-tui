/**
 * 分区标题组件 —— 设置页左栏分区标题标准（对齐 mihari section_card）
 *
 * 用法：
 *   <SectionHeader title="基础设置" />
 *   <SectionHeader title="mihomo 内核" />
 */

import React from 'react'
import { Text } from 'ink'

interface SectionHeaderProps {
  title: string
}

export function SectionHeader({ title }: SectionHeaderProps): React.JSX.Element {
  return (
    <Text dimColor bold>
      {title}
    </Text>
  )
}
