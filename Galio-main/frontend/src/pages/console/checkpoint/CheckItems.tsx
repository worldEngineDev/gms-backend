import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tag, message } from 'antd'

import {
  type CheckItem,
  createCheckItem,
  deleteCheckItem,
  listCheckItems,
  updateCheckItem,
} from '../../../api/checkpoint'

const DEVICE_TYPES = ['arm', 'hand', 'glove', 'quest', 'camera', 'link', 'env', 'svc']

export default function CheckItems() {
  const [items, setItems] = useState<CheckItem[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<CheckItem | null>(null)
  const [form] = Form.useForm()

  const load = () => {
    setLoading(true)
    listCheckItems()
      .then((data) => setItems(data.items))
      .catch((err: Error) => message.error(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ access_method: 'ssh', params: '{}', pass_criteria: '{}', created_by: 'admin' })
    setModalOpen(true)
  }

  const openEdit = (record: CheckItem) => {
    setEditing(record)
    form.setFieldsValue({
      ...record,
      params: JSON.stringify(record.params ?? {}, null, 2),
      pass_criteria: JSON.stringify(record.pass_criteria ?? {}, null, 2),
    })
    setModalOpen(true)
  }

  const handleSubmit = async () => {
    const values = await form.validateFields()
    let params: Record<string, unknown>
    let passCriteria: Record<string, unknown>
    try {
      params = JSON.parse(values.params || '{}')
      passCriteria = JSON.parse(values.pass_criteria || '{}')
    } catch {
      message.error('params / pass_criteria 必须是合法 JSON')
      return
    }
    setSaving(true)
    try {
      const payload = { ...values, params, pass_criteria: passCriteria }
      if (editing) {
        await updateCheckItem(editing.id, payload)
        message.success('已更新')
      } else {
        await createCheckItem(payload)
        message.success('已创建')
      }
      setModalOpen(false)
      load()
    } catch (err) {
      message.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    await deleteCheckItem(id)
    message.success('已删除')
    load()
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openCreate}>
          新建检测项
        </Button>
      </Space>
      <Table<CheckItem>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '设备类型', dataIndex: 'device_type' },
          { title: '探针', dataIndex: 'probe' },
          {
            title: '执行方式',
            dataIndex: 'access_method',
            render: (v: string) => <Tag color={v === 'http' ? 'blue' : 'purple'}>{v}</Tag>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (v: string) => <Tag color={v === 'active' ? 'green' : 'default'}>{v}</Tag>,
          },
          {
            title: '操作',
            render: (_, record) => (
              <Space>
                <a onClick={() => openEdit(record)}>编辑</a>
                <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
                  <a style={{ color: '#ff4d4f' }}>删除</a>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑检测项' : '新建检测项'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="device_type" label="设备类型" rules={[{ required: true }]}>
            <Select options={DEVICE_TYPES.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
          <Form.Item
            name="probe"
            label="探针标识"
            rules={[{ required: true }]}
            extra="探针脚本/服务标识，见 docs/architecture.md「探针脚本协议」"
          >
            <Input />
          </Form.Item>
          <Form.Item name="access_method" label="执行方式" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { label: 'SSH（探针脚本）', value: 'ssh' },
                { label: 'HTTP（本机状态接口）', value: 'http' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="params"
            label="params（JSON）"
            extra='执行方式=HTTP 时约定 {"port": 9100, "path": "/status"}'
          >
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="pass_criteria"
            label="pass_criteria（JSON）"
            rules={[{ required: true }]}
            extra="按字段相等匹配探针返回的结果"
          >
            <Input.TextArea rows={3} />
          </Form.Item>
          {!editing && (
            <Form.Item name="created_by" label="创建人" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  )
}
