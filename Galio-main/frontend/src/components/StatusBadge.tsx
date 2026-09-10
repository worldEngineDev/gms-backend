import { Tag } from 'antd'

const STATUS_COLOR: Record<string, string> = {
  active: 'green',
  online: 'green',
  disabled: 'default',
  offline: 'default',
  degraded: 'orange',
}

export function StatusBadge({ status }: { status: string }) {
  return <Tag color={STATUS_COLOR[status] ?? 'default'}>{status}</Tag>
}
