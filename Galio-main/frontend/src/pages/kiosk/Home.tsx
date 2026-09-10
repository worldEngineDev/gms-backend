import { Button, Flex } from 'antd'
import { useNavigate } from 'react-router-dom'

// 3 个大按钮对应 docs/architecture.md「上机流程」：一键体检（解锁采集）、一键报修（红项/异常时）、
// 我的工单（追踪报修状态）。不做成侧边栏菜单——kiosk 场景下触屏大按钮比分类导航更合适。
const BUTTON_STYLE: React.CSSProperties = { height: 80, fontSize: 24 }

export default function KioskHome() {
  const navigate = useNavigate()

  return (
    <Flex vertical gap={16} style={{ maxWidth: 480, margin: '0 auto' }}>
      <Button type="primary" style={BUTTON_STYLE} onClick={() => navigate('/kiosk/check-in')}>
        一键体检 · 开始采集
      </Button>
      <Button danger type="primary" style={BUTTON_STYLE} onClick={() => navigate('/kiosk/report')}>
        一键报修
      </Button>
      <Button style={BUTTON_STYLE} onClick={() => navigate('/kiosk/my-tickets')}>
        我的工单
      </Button>
    </Flex>
  )
}
