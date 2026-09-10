import { useEffect, useState } from 'react'
import { Button, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd'

import { apiFetch, type Paginated } from '../../../api/client'
import {
  type CheckRun,
  type CheckRunDetail,
  type CheckSuite,
  getCheckRun,
  listCheckRuns,
  listCheckSuites,
  triggerCheckRun,
} from '../../../api/checkpoint'

interface Station {
  id: string
  code: string
  name: string
}

const CONCLUSION_COLOR: Record<string, string> = { pass: 'green', fail: 'red', partial: 'orange' }

export default function CheckRuns() {
  const [runs, setRuns] = useState<CheckRun[]>([])
  const [loading, setLoading] = useState(true)
  const [suites, setSuites] = useState<CheckSuite[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [triggerOpen, setTriggerOpen] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [form] = Form.useForm()
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CheckRunDetail | null>(null)

  const load = () => {
    setLoading(true)
    listCheckRuns()
      .then((data) => setRuns(data.items))
      .catch((err: Error) => message.error(err.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const openTrigger = async () => {
    const [suiteResp, stationResp] = await Promise.all([
      listCheckSuites(),
      apiFetch<Paginated<Station>>('/stations?page_size=100'),
    ])
    setSuites(suiteResp.items)
    setStations(stationResp.items)
    form.resetFields()
    form.setFieldsValue({ created_by: 'admin' })
    setTriggerOpen(true)
  }

  const handleTrigger = async () => {
    const values = await form.validateFields()
    setTriggering(true)
    try {
      await triggerCheckRun({ ...values, trigger_reason: 'manual' })
      message.success('已触发，结果见列表')
      setTriggerOpen(false)
      load()
    } catch (err) {
      message.error((err as Error).message)
    } finally {
      setTriggering(false)
    }
  }

  const openDetail = async (id: string) => {
    setDetailId(id)
    const data = await getCheckRun(id)
    setDetail(data)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openTrigger}>
          手动触发检测
        </Button>
      </Space>
      <Table<CheckRun>
        rowKey="id"
        loading={loading}
        dataSource={runs}
        pagination={false}
        columns={[
          { title: '触发原因', dataIndex: 'trigger_reason' },
          {
            title: '结论',
            dataIndex: 'conclusion',
            render: (v: string | null) => (v ? <Tag color={CONCLUSION_COLOR[v]}>{v}</Tag> : <Tag>执行中</Tag>),
          },
          { title: '开始时间', dataIndex: 'started_at', render: (v: string) => new Date(v).toLocaleString() },
          {
            title: '完成时间',
            dataIndex: 'finished_at',
            render: (v: string | null) => (v ? new Date(v).toLocaleString() : '-'),
          },
          { title: '操作', render: (_, record) => <a onClick={() => openDetail(record.id)}>查看详情</a> },
        ]}
      />

      <Modal
        title="手动触发检测"
        open={triggerOpen}
        onCancel={() => setTriggerOpen(false)}
        onOk={handleTrigger}
        confirmLoading={triggering}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="check_suite_id" label="检测集" rules={[{ required: true }]}>
            <Select options={suites.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="station_id" label="工位" rules={[{ required: true }]}>
            <Select options={stations.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} />
          </Form.Item>
          <Form.Item name="created_by" label="触发人" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title="检测执行详情" open={!!detailId} onClose={() => setDetailId(null)} width={520}>
        {detail && (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="结论">
                {detail.run.conclusion ? (
                  <Tag color={CONCLUSION_COLOR[detail.run.conclusion]}>{detail.run.conclusion}</Tag>
                ) : (
                  '执行中'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="触发原因">{detail.run.trigger_reason}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{new Date(detail.run.started_at).toLocaleString()}</Descriptions.Item>
            </Descriptions>
            <Table
              style={{ marginTop: 16 }}
              rowKey="id"
              size="small"
              dataSource={detail.results}
              pagination={false}
              columns={[
                {
                  title: '结果',
                  dataIndex: 'result',
                  render: (v: string) => (
                    <Tag color={v === 'pass' ? 'green' : v === 'fail' ? 'red' : 'default'}>{v}</Tag>
                  ),
                },
                {
                  title: 'evidence',
                  dataIndex: 'evidence',
                  render: (v: unknown) => <code style={{ fontSize: 12 }}>{JSON.stringify(v)}</code>,
                },
                { title: 'suggestion', dataIndex: 'suggestion' },
              ]}
            />
          </>
        )}
      </Drawer>
    </div>
  )
}
