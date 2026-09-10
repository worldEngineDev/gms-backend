import { useEffect, useState } from 'react'
import { Button, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd'

import {
  type CheckItem,
  type CheckSuite,
  type CheckSuiteDetail,
  createCheckSuite,
  deleteCheckSuite,
  getCheckSuite,
  listCheckItems,
  listCheckSuites,
  setCheckSuiteItems,
  updateCheckSuite,
} from '../../../api/checkpoint'

const SCENARIOS = [
  { value: 'pre_op_check', label: '上机体检' },
  { value: 'repair_acceptance', label: '维修验收' },
  { value: 'release_verify', label: '发布核验' },
  { value: 'handover_check', label: '交接检查' },
]
const SCENARIO_LABEL = Object.fromEntries(SCENARIOS.map((s) => [s.value, s.label]))

export default function CheckSuites() {
  const [suites, setSuites] = useState<CheckSuite[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<CheckSuite | null>(null)
  const [form] = Form.useForm()

  const [drawerSuiteId, setDrawerSuiteId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CheckSuiteDetail | null>(null)
  const [allItems, setAllItems] = useState<CheckItem[]>([])
  const [addItemId, setAddItemId] = useState<string | undefined>()

  const load = () => {
    setLoading(true)
    listCheckSuites()
      .then((data) => setSuites(data.items))
      .catch((err: Error) => message.error(err.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ created_by: 'admin' })
    setModalOpen(true)
  }
  const openEdit = (record: CheckSuite) => {
    setEditing(record)
    form.setFieldsValue(record)
    setModalOpen(true)
  }
  const handleSubmit = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await updateCheckSuite(editing.id, values)
        message.success('已更新')
      } else {
        await createCheckSuite(values)
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
    await deleteCheckSuite(id)
    message.success('已删除')
    load()
  }

  const openItemsDrawer = async (suiteId: string) => {
    setDrawerSuiteId(suiteId)
    const [suiteDetail, itemsResp] = await Promise.all([getCheckSuite(suiteId), listCheckItems()])
    setDetail(suiteDetail)
    setAllItems(itemsResp.items)
  }

  const saveItemOrder = async (items: { seq: number; item: CheckItem }[]) => {
    if (!drawerSuiteId) return
    const ids = [...items].sort((a, b) => a.seq - b.seq).map((i) => i.item.id)
    const updated = await setCheckSuiteItems(drawerSuiteId, ids)
    setDetail(updated)
    load()
  }

  const moveItem = (index: number, dir: -1 | 1) => {
    if (!detail) return
    const items = [...detail.items]
    const target = index + dir
    if (target < 0 || target >= items.length) return
    ;[items[index], items[target]] = [items[target], items[index]]
    saveItemOrder(items.map((it, idx) => ({ ...it, seq: idx + 1 })))
  }

  const removeItem = (itemId: string) => {
    if (!detail) return
    saveItemOrder(
      detail.items.filter((i) => i.item.id !== itemId).map((it, idx) => ({ ...it, seq: idx + 1 })),
    )
  }

  const addItem = () => {
    if (!detail || !addItemId) return
    const item = allItems.find((i) => i.id === addItemId)
    if (!item) return
    saveItemOrder([...detail.items, { seq: detail.items.length + 1, item }])
    setAddItemId(undefined)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openCreate}>
          新建检测集
        </Button>
      </Space>
      <Table<CheckSuite>
        rowKey="id"
        loading={loading}
        dataSource={suites}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '场景', dataIndex: 'scenario', render: (v: string) => SCENARIO_LABEL[v] ?? v },
          { title: '设备类型', dataIndex: 'device_type', render: (v: string | null) => v ?? '（整机/工位级）' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (v: string) => <Tag color={v === 'active' ? 'green' : 'default'}>{v}</Tag>,
          },
          {
            title: '操作',
            render: (_, record) => (
              <Space>
                <a onClick={() => openItemsDrawer(record.id)}>检测项</a>
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
        title={editing ? '编辑检测集' : '新建检测集'}
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
          <Form.Item name="scenario" label="场景" rules={[{ required: true }]}>
            <Select options={SCENARIOS} />
          </Form.Item>
          <Form.Item name="device_type" label="设备类型（留空 = 整机/工位级）">
            <Input />
          </Form.Item>
          {!editing && (
            <Form.Item name="created_by" label="创建人" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Drawer
        title={`检测项清单${detail ? ' - ' + detail.suite.name : ''}`}
        open={!!drawerSuiteId}
        onClose={() => setDrawerSuiteId(null)}
        width={480}
      >
        {detail && (
          <>
            <Table
              rowKey={(r) => r.item.id}
              dataSource={detail.items}
              pagination={false}
              size="small"
              columns={[
                { title: '序号', dataIndex: 'seq', width: 50 },
                { title: '名称', render: (_, r) => r.item.name },
                { title: '设备类型', render: (_, r) => r.item.device_type },
                {
                  title: '操作',
                  render: (_, r, index) => (
                    <Space>
                      <a onClick={() => moveItem(index, -1)}>上移</a>
                      <a onClick={() => moveItem(index, 1)}>下移</a>
                      <a style={{ color: '#ff4d4f' }} onClick={() => removeItem(r.item.id)}>
                        移除
                      </a>
                    </Space>
                  ),
                },
              ]}
            />
            <Space style={{ marginTop: 16 }}>
              <Select
                style={{ width: 240 }}
                placeholder="选择要添加的检测项"
                value={addItemId}
                onChange={setAddItemId}
                options={allItems
                  .filter((i) => !detail.items.some((di) => di.item.id === i.id))
                  .map((i) => ({ value: i.id, label: `${i.name}（${i.device_type}）` }))}
              />
              <Button onClick={addItem}>添加</Button>
            </Space>
          </>
        )}
      </Drawer>
    </div>
  )
}
