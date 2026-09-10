import { KioskPlaceholder } from './KioskPlaceholder'

export default function MyTickets() {
  return (
    <KioskPlaceholder
      title="我的工单"
      description="查询 GET /tickets?reporter_id=当前采集员，追踪自己报修的处理进度。"
    />
  )
}
