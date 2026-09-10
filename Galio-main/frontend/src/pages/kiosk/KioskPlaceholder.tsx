import { Button, Result } from 'antd'
import { useNavigate } from 'react-router-dom'

export function KioskPlaceholder({ title, description }: { title: string; description: string }) {
  const navigate = useNavigate()
  return (
    <Result
      status="info"
      title={title}
      subTitle={description}
      extra={<Button onClick={() => navigate('/kiosk')}>返回首页</Button>}
    />
  )
}
