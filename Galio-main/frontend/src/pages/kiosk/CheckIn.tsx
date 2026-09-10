import { KioskPlaceholder } from './KioskPlaceholder'

export default function CheckIn() {
  return (
    <KioskPlaceholder
      title="一键体检"
      description="触发 POST /check-runs（scenario=pre_op_check），全绿解锁采集 checklist；见 docs/architecture.md「上机流程」。"
    />
  )
}
