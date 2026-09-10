import { useCallback, useEffect, useState } from 'react'
import { Alert, Card, Col, Empty, Row, Space, Spin, Tag, Typography } from 'antd'

import { apiFetch } from '../../api/client'

interface ProbeHealth {
  status?: string
  last_checked?: string
}

interface StationHealth {
  id: string
  code: string
  name: string
  status: string
  snapshot?: {
    last_polled_at?: string | null
    updated_at?: string | null
  }
  metrics: Record<string, number>
  probes: Record<string, ProbeHealth>
}

const CAMERAS = [
  { id: 'front', label: '前置相机' },
  { id: 'left_wrist', label: '左手腕相机' },
  { id: 'right_wrist', label: '右手腕相机' },
]

function metricValue(station: StationHealth, name: string): number | null {
  const value = station.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function stateTag(ok: boolean | null, okText = '正常', badText = '异常') {
  if (ok === null) return <Tag>暂无数据</Tag>
  return <Tag color={ok ? 'green' : 'red'}>{ok ? okText : badText}</Tag>
}

function stationTag(status: string) {
  const color: Record<string, string> = {
    online: 'green',
    degraded: 'orange',
    offline: 'red',
    unknown: 'default',
  }
  const label: Record<string, string> = {
    online: '在线',
    degraded: '部分异常',
    offline: '离线',
    unknown: '未知',
  }
  return <Tag color={color[status] ?? 'default'}>{label[status] ?? status}</Tag>
}

function CameraLine({ station, id, label }: { station: StationHealth; id: string; label: string }) {
  const fps = metricValue(station, `camera_${id}_fps`)
  const frameOk = metricValue(station, `camera_${id}_frame_ok`)
  const healthy = fps !== null && fps > 0 && (frameOk === null || frameOk === 1)
  const known = fps !== null || frameOk !== null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Typography.Text>{label}</Typography.Text>
      <Space size={8}>
        <Typography.Text strong style={{ minWidth: 76, textAlign: 'right' }}>
          {fps === null ? '--' : `${fps.toFixed(1)} FPS`}
        </Typography.Text>
        {stateTag(known ? healthy : null)}
      </Space>
    </div>
  )
}

function DeviceLine({
  station,
  label,
  onlineMetric,
  detail,
}: {
  station: StationHealth
  label: string
  onlineMetric: string
  detail?: string
}) {
  const online = metricValue(station, onlineMetric)
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Typography.Text>{label}</Typography.Text>
      <Space size={8}>
        {detail && <Typography.Text type="secondary">{detail}</Typography.Text>}
        {stateTag(online === null ? null : online === 1)}
      </Space>
    </div>
  )
}

function StationCard({ station }: { station: StationHealth }) {
  const gloveL = metricValue(station, 'glove_l_online')
  const gloveR = metricValue(station, 'glove_r_online')
  const handL = metricValue(station, 'hand_l_online')
  const handR = metricValue(station, 'hand_r_online')
  const gloveLTactile = metricValue(station, 'glove_l_tactile')
  const gloveRTactile = metricValue(station, 'glove_r_tactile')
  const gloveLEmf = metricValue(station, 'glove_l_emf_poses')
  const gloveREmf = metricValue(station, 'glove_r_emf_poses')
  const handLJoints = metricValue(station, 'hand_l_joints')
  const handRJoints = metricValue(station, 'hand_r_joints')

  const gloveDetail = (tactile: number | null, emf: number | null) =>
    tactile === null && emf === null ? undefined : `触觉 ${tactile === 1 ? '✓' : '×'} · 姿态 ${emf === 1 ? '✓' : '×'}`

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>{station.code}</span>
          <Typography.Text type="secondary">{station.name}</Typography.Text>
        </Space>
      }
      extra={stationTag(station.status)}
    >
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        摄像头
      </Typography.Text>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        {CAMERAS.map((camera) => (
          <CameraLine key={camera.id} station={station} {...camera} />
        ))}
      </Space>

      <Typography.Text type="secondary" style={{ display: 'block', margin: '14px 0 8px' }}>
        数据手套
      </Typography.Text>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <DeviceLine
          station={station}
          label="手套 L"
          onlineMetric="glove_l_online"
          detail={gloveDetail(gloveLTactile, gloveLEmf)}
        />
        <DeviceLine
          station={station}
          label="手套 R"
          onlineMetric="glove_r_online"
          detail={gloveDetail(gloveRTactile, gloveREmf)}
        />
      </Space>

      <Typography.Text type="secondary" style={{ display: 'block', margin: '14px 0 8px' }}>
        灵巧手
      </Typography.Text>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <DeviceLine
          station={station}
          label="灵巧手 L"
          onlineMetric="hand_l_online"
          detail={handLJoints === null ? undefined : `${handLJoints} 个关节`}
        />
        <DeviceLine
          station={station}
          label="灵巧手 R"
          onlineMetric="hand_r_online"
          detail={handRJoints === null ? undefined : `${handRJoints} 个关节`}
        />
      </Space>
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 14, fontSize: 12 }}>
        最近指标：{station.snapshot?.last_polled_at ? new Date(station.snapshot.last_polled_at).toLocaleString() : '暂无'}
      </Typography.Text>
    </Card>
  )
}

export default function Dashboard() {
  const [stations, setStations] = useState<StationHealth[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<StationHealth[]>('/monitor/stations/health-summary')
      setStations(data)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load])

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        状态大盘
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        摄像头 FPS、手套数据流和灵巧手状态每 5 秒刷新一次；实际数据由工位探针巡检产生。
      </Typography.Paragraph>
      {error && (
        <Alert
          type="error"
          showIcon
          message="状态数据加载失败"
          description={`${error}（后端/数据库或工位探针还没起来）`}
          style={{ marginBottom: 16 }}
        />
      )}
      {loading ? (
        <Spin />
      ) : stations.length === 0 ? (
        <Empty description="暂无工位数据" />
      ) : (
        <Row gutter={[16, 16]}>
          {stations.map((station) => (
            <Col key={station.id} xs={24} xl={12} xxl={8}>
              <StationCard station={station} />
            </Col>
          ))}
        </Row>
      )}
    </div>
  )
}
