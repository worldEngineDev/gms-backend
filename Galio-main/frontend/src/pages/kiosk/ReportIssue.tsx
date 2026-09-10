import { KioskPlaceholder } from './KioskPlaceholder'

export default function ReportIssue() {
  return (
    <KioskPlaceholder
      title="一键报修"
      description="触发 POST /tickets（source=manual_report），自动带工位/设备上下文；见 docs/api-design.md「工单调度」。"
    />
  )
}
