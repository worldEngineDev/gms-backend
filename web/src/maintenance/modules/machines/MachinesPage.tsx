// 机器管理页（移植 js/ui/machines.js）：生命周期管理 · 上/下线自动扣减/归还库存
import { useMemo, useState } from 'react';
import {
  Button, Card, Col, Empty, Flex, Input, Modal, Radio, Row, Space, Statistic,
  Table, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  PlusOutlined, ImportOutlined, DeleteOutlined, AppstoreOutlined, TableOutlined, SwapOutlined, WarningOutlined,
  CheckCircleOutlined, DisconnectOutlined, VideoCameraOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useMachines, useSNRegistry, useEquipmentConfig } from '@common/hooks/useData';
import { useAuthStore, isSuperAdmin } from '@common/stores/auth';
import * as api from '@common/api';
import { latestMachineByNumber, buildEffectiveStatusMap, MACHINE_STATUS_META, deviceTypeLabel } from '@common/utils/domain';
import { formatTime, naturalCompare } from '@common/utils/format';
import { MachineFormModal, BulkImportModal, MarkDamagedModal, replaceGloves } from './machineModals';

export default function MachinesPage() {
  const qc = useQueryClient();
  const machines = useMachines();
  const snRegistry = useSNRegistry();
  const equipmentConfig = useEquipmentConfig();
  const user = useAuthStore(s => s.user);
  const superAdmin = isSuperAdmin(user);

  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [formOpen, setFormOpen] = useState<{ number?: string; status?: 'online' | 'offline' } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [damageTarget, setDamageTarget] = useState<{ snCode: string; machineNumber: string } | null>(null);
  const [detailNumber, setDetailNumber] = useState<string | null>(null);

  const machineList = machines.data || [];
  const registry = snRegistry.data || [];
  const eqConfigList = equipmentConfig.data || [];

  const latestMap = useMemo(() => latestMachineByNumber(machineList), [machineList]);
  const numbers = useMemo(() => Object.keys(latestMap).sort(naturalCompare), [latestMap]);
  const latestMachines = useMemo(() => numbers.map(n => latestMap[n]), [numbers, latestMap]);
  const effectiveMap = useMemo(() => buildEffectiveStatusMap(latestMachines, registry), [latestMachines, registry]);

  const counts = useMemo(() => {
    const vals = Object.values(effectiveMap);
    return {
      all: numbers.length,
      online: vals.filter(s => s === 'online').length,
      partial: vals.filter(s => s === 'partial').length,
      offline: vals.filter(s => s === 'offline').length,
    };
  }, [effectiveMap, numbers.length]);

  const visible = useMemo(() => {
    let list = numbers;
    if (filter !== 'all') list = list.filter(n => effectiveMap[n] === filter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(n => n.toLowerCase().includes(q));
    }
    return list;
  }, [numbers, filter, search, effectiveMap]);

  const eqMeta = (deviceType?: string) => {
    const cfg = eqConfigList.find(c => c.id === deviceType);
    return { icon: cfg?.icon || '🖥️', label: cfg?.name || deviceTypeLabel(deviceType) };
  };
  const boundSN = (num: string, hand: 'left' | 'right') =>
    registry.find(r => r.machineNumber === num && r.handType === hand && r.status === 'in_use');

  const equipmentTypeOf = (machine: any) => {
    const type = String(machine?.machineType || '').toLowerCase();
    if (type === 'dexterous') return 'dexterous';
    if (type === 'glove_only') return 'glove';
    return machine?.deviceType || '';
  };

  const collectorMeta = (machine: any) => {
    const hermes = machine?.hermes;
    const importer = machine?.importer;
    if (machine?.hostOnline === false) {
      return { color: 'red', icon: <DisconnectOutlined />, text: '采集代理离线' };
    }
    if (machine?.collectorStarted === false || machine?.edgeContainerRoleStatus?.collector?.running === false
      || machine?.containerRoleStatus?.collector?.running === false) {
      return { color: 'default', icon: <DisconnectOutlined />, text: '采集程序未运行' };
    }
    if (!hermes && !importer) {
      return { color: 'default', icon: <DisconnectOutlined />, text: '未连接采集代理' };
    }
    const hermesOk = hermes?.reachable !== false;
    const importerOk = importer?.reachable !== false;
    const degraded = hermes?.health?.degraded || [];
    const recording = hermes?.state?.isRecording === true;
    const stale = importer?.machineConfigStale || importer?.taskStale
      || hermes?.healthStale || hermes?.stateStale;
    if (!hermesOk || !importerOk) {
      return { color: 'red', icon: <DisconnectOutlined />, text: '采集服务异常' };
    }
    if ((!hermes?.healthStale && (degraded.length || hermes?.health?.allConnected === false))
      || (!hermes?.stateStale && hermes?.state?.emergencyStopped === true)) {
      return { color: 'orange', icon: <WarningOutlined />, text: '采集组件降级' };
    }
    if (stale) return { color: 'orange', icon: <WarningOutlined />, text: '采集状态部分未知' };
    if (recording) return { color: 'green', icon: <VideoCameraOutlined />, text: '正在录制' };
    return { color: 'green', icon: <CheckCircleOutlined />, text: '采集正常' };
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['machines'] });
    qc.invalidateQueries({ queryKey: ['inventory'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['sn-registry'] });
  };

  const doDelete = (num: string) => {
    const m = latestMap[num];
    if (!m) return;
    if (boundSN(num, 'left') || boundSN(num, 'right')) {
      const bound = [boundSN(num, 'left') ? '左手' : '', boundSN(num, 'right') ? '右手' : ''].filter(Boolean);
      message.error(`无法删除：${num} 上绑定了${bound.join('、')}手套，请先解绑`);
      return;
    }
    Modal.confirm({
      title: `确定删除机器 ${num}？`,
      content: '此操作不可撤销，删除后数据无法恢复',
      okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try {
          await api.deleteMachine(m.id);
          invalidate();
          message.success(`机器 ${num} 已删除`);
        } catch (e: any) {
          message.error(e?.message || '删除失败');
          throw e; // 让 Modal 保持打开以便重试
        }
      },
    });
  };

  const doReplace = async (num: string) => {
    const leftSN = boundSN(num, 'left');
    const rightSN = boundSN(num, 'right');
    Modal.confirm({
      title: `替换手套 — ${num}`,
      content: (
        <div>
          {leftSN && <div>左手: <Typography.Text code>{leftSN.snCode}</Typography.Text> ({leftSN.status})</div>}
          {rightSN && <div>右手: <Typography.Text code>{rightSN.snCode}</Typography.Text> ({rightSN.status})</div>}
          <p style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>确认后将绑定手套标记为损坏，请手动绑定新手套。</p>
        </div>
      ),
      okText: '确认替换', cancelText: '取消',
      onOk: async () => {
        try {
          await replaceGloves(num, registry);
          invalidate();
          message.success(`机器 ${num} 手套已标记损坏，请手动绑定新手套`);
        } catch (e: any) {
          message.error(e?.message || '替换失败');
          throw e; // 让 Modal 保持打开以便重试
        }
      },
    });
  };

  const statusTag = (num: string) => {
    const st = effectiveMap[num] || 'offline';
    const meta = MACHINE_STATUS_META[st] || MACHINE_STATUS_META.offline;
    return <Tag color={meta.color}>{meta.label}</Tag>;
  };

  const renderCard = (num: string) => {
    const m = latestMap[num];
    const meta = eqMeta(equipmentTypeOf(m));
    const leftSN = boundSN(num, 'left');
    const rightSN = boundSN(num, 'right');
    return (
      <Col key={num} xs={24} sm={12} md={8} lg={6}>
        <Card
          size="small" hoverable style={{ position: 'relative' }}
          onClick={() => setDetailNumber(num)}
        >
          {superAdmin && (
            <Tooltip title="删除此机器">
              <Button type="text" danger size="small" icon={<DeleteOutlined />}
                style={{ position: 'absolute', top: 4, right: 4 }}
                onClick={e => { e.stopPropagation(); doDelete(num); }} />
            </Tooltip>
          )}
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28 }}>{meta.icon}</div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>#{num}</div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>{meta.label}</div>
            {m.hostOnline !== undefined && (
              <div style={{ marginTop: 4 }}>
                <Tag color={m.hostOnline ? 'green' : 'default'} style={{ margin: 0 }}>
                  {m.hostOnline ? '🟢 主机在线' : '⚫ 主机离线'}
                </Tag>
                {(m.edgeAlerts || []).length > 0 && (
                  <Tooltip title={(m.edgeAlerts || []).map((a: any) => a.message).join('\n')}>
                    <Tag color="red" style={{ margin: '0 0 0 4px' }}>⚠ {m.edgeAlerts.length}</Tag>
                  </Tooltip>
                )}
              </div>
            )}
            <div style={{ marginTop: 4 }}>
              {(() => {
                const collector = collectorMeta(m);
                return collector ? (
                  <Tag color={collector.color} icon={collector.icon} style={{ margin: 0 }}>
                    {collector.text}
                  </Tag>
                ) : null;
              })()}
            </div>
          </div>
          <div style={{ fontSize: 12, opacity: leftSN ? 0.85 : 0.45, marginTop: 6 }}>
            🧤 左手: {leftSN ? leftSN.snCode : '未绑定'}
          </div>
          <div style={{ fontSize: 12, opacity: rightSN ? 0.85 : 0.45 }}>
            🧤 右手: {rightSN ? rightSN.snCode : '未绑定'}
          </div>
          {(leftSN || rightSN) && (
            <Flex gap={4} justify="center" style={{ marginTop: 8 }}>
              {leftSN && <Button size="small" color="orange" variant="outlined" icon={<WarningOutlined />} onClick={e => { e.stopPropagation(); setDamageTarget({ snCode: leftSN.snCode, machineNumber: num }); }}>左手损坏</Button>}
              {rightSN && <Button size="small" color="orange" variant="outlined" icon={<WarningOutlined />} onClick={e => { e.stopPropagation(); setDamageTarget({ snCode: rightSN.snCode, machineNumber: num }); }}>右手损坏</Button>}
              <Button size="small" type="primary" icon={<SwapOutlined />} onClick={e => { e.stopPropagation(); doReplace(num); }}>替换</Button>
            </Flex>
          )}
          <Flex justify="space-between" align="center" style={{ marginTop: 8, fontSize: 11, opacity: 0.65 }}>
            <span>{formatTime(m.updatedAt)}</span>
            {statusTag(num)}
          </Flex>
        </Card>
      </Col>
    );
  };

  const columns: any[] = [
    { title: '机器编号', dataIndex: 'machineNumber', render: (_: any, r: any) => <a onClick={() => setDetailNumber(r.machineNumber)}><strong>{r.machineNumber}</strong></a> },
    { title: '设备类型', dataIndex: 'deviceType', render: (_v: string, r: any) => { const meta = eqMeta(equipmentTypeOf(r)); return `${meta.icon} ${meta.label}`; } },
    { title: '状态', dataIndex: 'machineNumber', key: 'status', render: (num: string) => statusTag(num) },
    {
      title: '主机在线', key: 'host',
      render: (_: any, r: any) => r.hostOnline === undefined
        ? <span style={{ opacity: 0.45 }}>无代理</span>
        : (
          <Flex gap={4} align="center">
            <Tag color={r.hostOnline ? 'green' : 'default'} style={{ margin: 0 }}>{r.hostOnline ? '🟢 在线' : '⚫ 离线'}</Tag>
            {(r.edgeAlerts || []).length > 0 && (
              <Tooltip title={(r.edgeAlerts || []).map((a: any) => a.message).join('\n')}>
                <Tag color="red" style={{ margin: 0 }}>⚠{r.edgeAlerts.length}</Tag>
              </Tooltip>
            )}
          </Flex>
        ),
    },
    {
      title: '采集状态', key: 'collector',
      render: (_: any, r: any) => {
        const meta = collectorMeta(r);
        return meta ? <Tag color={meta.color} icon={meta.icon}>{meta.text}</Tag> : <span style={{ opacity: 0.45 }}>无采集代理</span>;
      },
    },
    {
      title: '手套绑定', dataIndex: 'machineNumber', key: 'binding',
      render: (num: string) => {
        const l = boundSN(num, 'left'), r = boundSN(num, 'right');
        if (!l && !r) return <span style={{ opacity: 0.45 }}>未绑定</span>;
        return <span style={{ fontSize: 12 }}>{l ? `左:${l.snCode.slice(-6)}` : ''} {r ? `右:${r.snCode.slice(-6)}` : ''}</span>;
      },
    },
    { title: '上线时间', dataIndex: 'onlineTime', render: (v: string) => formatTime(v) },
    { title: '下线时间', dataIndex: 'offlineTime', render: (v: string) => formatTime(v) },
    { title: '更新人', dataIndex: 'updatedBy', render: (v: string) => v || '-' },
    ...(superAdmin ? [{
      title: '操作', dataIndex: 'machineNumber', key: 'op', width: 60,
      render: (num: string) => <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => doDelete(num)} />,
    }] : []),
  ];

  // 详情
  const detailMachine = detailNumber ? latestMap[detailNumber] : null;

  return (
    <PageContainer
      title="机器管理"
      subtitle="机器生命周期管理 · 上/下线自动扣减/归还库存"
      extra={
        <>
          <Button icon={<ImportOutlined />} onClick={() => setBulkOpen(true)}>批量导入</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen({})}>添加记录</Button>
        </>
      }
    >
      {/* 统计卡片 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={counts.partial > 0 ? 6 : 8}><Card size="small"><Statistic title="机器总数" value={counts.all} /></Card></Col>
        <Col span={counts.partial > 0 ? 6 : 8}><Card size="small"><Statistic title="在线" value={counts.online} valueStyle={{ color: '#22c55e' }} /></Card></Col>
        {counts.partial > 0 && <Col span={6}><Card size="small"><Statistic title="部分绑定" value={counts.partial} valueStyle={{ color: '#f59e0b' }} /></Card></Col>}
        <Col span={counts.partial > 0 ? 6 : 8}><Card size="small"><Statistic title="离线" value={counts.offline} valueStyle={{ color: '#94a3b8' }} /></Card></Col>
      </Row>

      {/* 筛选栏 */}
      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <Radio.Group value={filter} onChange={e => setFilter(e.target.value)} optionType="button" buttonStyle="solid">
          <Radio.Button value="all">全部 ({counts.all})</Radio.Button>
          <Radio.Button value="online">在线 ({counts.online})</Radio.Button>
          {counts.partial > 0 && <Radio.Button value="partial">部分 ({counts.partial})</Radio.Button>}
          <Radio.Button value="offline">离线 ({counts.offline})</Radio.Button>
        </Radio.Group>
        <Input.Search placeholder="搜索机器编号..." allowClear style={{ width: 220 }} onSearch={setSearch}
          onChange={e => { if (!e.target.value) setSearch(''); }} />
        <Space style={{ marginLeft: 'auto' }}>
          <Button type={viewMode === 'card' ? 'primary' : 'default'} icon={<AppstoreOutlined />} onClick={() => setViewMode('card')}>卡片</Button>
          <Button type={viewMode === 'table' ? 'primary' : 'default'} icon={<TableOutlined />} onClick={() => setViewMode('table')}>表格</Button>
        </Space>
      </Flex>

      {visible.length === 0 && !machines.isLoading ? (
        <Empty description="暂无机器记录" style={{ marginTop: 60 }}>
          <Button type="primary" onClick={() => setFormOpen({})}>添加上/下线记录</Button>
        </Empty>
      ) : viewMode === 'card' ? (
        <Row gutter={[12, 12]}>{visible.map(renderCard)}</Row>
      ) : (
        <Table rowKey="machineNumber" size="small" loading={machines.isLoading}
          columns={columns} dataSource={visible.map(n => latestMap[n])}
          pagination={{ pageSize: 20, showTotal: t => `共 ${t} 台` }} />
      )}

      {/* 机器详情 */}
      <Modal
        title={`机器 #${detailNumber || ''} 详情`}
        open={!!detailNumber}
        onCancel={() => setDetailNumber(null)}
        footer={null}
        width={560}
      >
        {detailMachine && (
          <div>
            <Flex align="center" gap={14} style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
              <div style={{ fontSize: 40 }}>{eqMeta(equipmentTypeOf(detailMachine)).icon}</div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>#{detailNumber}</div>
                <div style={{ opacity: 0.65, fontSize: 13 }}>{eqMeta(equipmentTypeOf(detailMachine)).label}</div>
              </div>
              <div style={{ marginLeft: 'auto' }}>{statusTag(detailNumber!)}</div>
            </Flex>
            <Row gutter={[12, 8]} style={{ fontSize: 13 }}>
              <Col span={12}><div style={{ opacity: 0.6 }}>上线时间</div>{formatTime(detailMachine.onlineTime)}</Col>
              <Col span={12}><div style={{ opacity: 0.6 }}>下线时间</div>{formatTime(detailMachine.offlineTime)}</Col>
              <Col span={12}>
                <div style={{ opacity: 0.6 }}>左手手套</div>
                {boundSN(detailNumber!, 'left')
                  ? <Typography.Text code>{boundSN(detailNumber!, 'left')!.snCode}</Typography.Text>
                  : <span style={{ opacity: 0.45 }}>未绑定</span>}
              </Col>
              <Col span={12}>
                <div style={{ opacity: 0.6 }}>右手手套</div>
                {boundSN(detailNumber!, 'right')
                  ? <Typography.Text code>{boundSN(detailNumber!, 'right')!.snCode}</Typography.Text>
                  : <span style={{ opacity: 0.45 }}>未绑定</span>}
              </Col>
              <Col span={12}><div style={{ opacity: 0.6 }}>更新人</div>{detailMachine.updatedBy || '-'}</Col>
              <Col span={12}><div style={{ opacity: 0.6 }}>最近原因</div>{(detailMachine.onlineReason || detailMachine.offlineReason) || '-'}</Col>
            </Row>
            {detailMachine && (
              <>
                <div style={{ marginTop: 18, marginBottom: 8, fontWeight: 600 }}>采集程序</div>
                {!detailMachine.importer && !detailMachine.hermes && (
                  <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 10 }}>
                    尚未收到 Agent 实时快照；请检查目标机 Agent 和网络配置。
                  </Typography.Text>
                )}
                <Row gutter={[12, 8]} style={{ fontSize: 13 }}>
                  <Col span={12}>
                    <div style={{ opacity: 0.6 }}>采集状态</div>
                    {(() => { const meta = collectorMeta(detailMachine); return meta ? <Tag color={meta.color} icon={meta.icon}>{meta.text}</Tag> : '-'; })()}
                  </Col>
                  <Col span={12}>
                    <div style={{ opacity: 0.6 }}>Hermes 版本</div>
                    {detailMachine.hermes?.version || '-'}
                  </Col>
                  <Col span={12}>
                    <div style={{ opacity: 0.6 }}>控制阶段</div>
                    {detailMachine.hermes?.state?.controlState || '-'}
                    {detailMachine.hermes?.state?.isRecording === true && <Tag color="green" style={{ marginLeft: 6 }}>录制中</Tag>}
                  </Col>
                  <Col span={12}>
                    <div style={{ opacity: 0.6 }}>Importer 机器 ID</div>
                    {detailMachine.importer?.machineId || detailMachine.importer?.computerId || '-'}
                  </Col>
                  <Col span={12}>
                    <div style={{ opacity: 0.6 }}>最近采集检查</div>
                    {formatTime(detailMachine.hermes?.checkedAt || detailMachine.importer?.checkedAt)}
                  </Col>
                  <Col span={24}>
                    <div style={{ opacity: 0.6 }}>当前任务</div>
                    {detailMachine.importer?.task
                      ? <span>{detailMachine.importer.task.template?.refName || detailMachine.importer.task.template?.name || detailMachine.importer.task.id || '-'}
                        {detailMachine.importer.task.hours != null && <span style={{ opacity: 0.65 }}>（{detailMachine.importer.task.hoursCompleted || 0}/{detailMachine.importer.task.hours} 小时）</span>}
                        {detailMachine.importer.task.operator?.name && <span style={{ opacity: 0.65 }}> · {detailMachine.importer.task.operator.name}</span>}
                        {detailMachine.importer.taskStale && <Tag color="orange" style={{ marginLeft: 6 }}>可能已过期</Tag>}
                      </span>
                      : <span style={{ opacity: 0.45 }}>{detailMachine.importer?.taskStale ? '任务状态未知' : '当前无任务'}</span>}
                  </Col>
                  <Col span={24}>
                    <div style={{ opacity: 0.6 }}>异常</div>
                    {(() => {
                      const alerts = detailMachine.edgeAlerts || [];
                      const degraded = detailMachine.hermes?.health?.degraded || [];
                      const errors = detailMachine.hermes?.state?.errors || [];
                      if (!alerts.length && !degraded.length && !errors.length) return <span style={{ color: '#22c55e' }}>无</span>;
                      return <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        {alerts.slice(0, 5).map((a: any, i: number) => <Typography.Text type="danger" key={`${a.code || 'alert'}-${i}`}>{a.message || a.code}</Typography.Text>)}
                        {degraded.length > 0 && <Typography.Text type="warning">降级组件：{degraded.join('、')}</Typography.Text>}
                        {errors.length > 0 && <Typography.Text type="danger">Hermes 错误：{errors.slice(0, 3).map((e: any) => typeof e === 'string' ? e : JSON.stringify(e)).join('；')}</Typography.Text>}
                      </Space>;
                    })()}
                  </Col>
                </Row>
              </>
            )}
            <Flex gap={8} wrap style={{ marginTop: 16 }}>
              <Button type="primary" onClick={() => { setDetailNumber(null); setFormOpen({ number: detailNumber!, status: 'online' }); }}>上线</Button>
              <Button danger onClick={() => { setDetailNumber(null); setFormOpen({ number: detailNumber!, status: 'offline' }); }}>下线</Button>
              {(boundSN(detailNumber!, 'left') || boundSN(detailNumber!, 'right')) && (
                <Button icon={<SwapOutlined />} onClick={() => doReplace(detailNumber!)}>替换手套</Button>
              )}
              {superAdmin && <Button danger icon={<DeleteOutlined />} onClick={() => doDelete(detailNumber!)}>删除机器</Button>}
            </Flex>
          </div>
        )}
      </Modal>

      {/* 弹窗 */}
      <MachineFormModal
        open={!!formOpen}
        presetNumber={formOpen?.number}
        presetStatus={formOpen?.status}
        onClose={() => setFormOpen(null)}
      />
      <BulkImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} />
      <MarkDamagedModal
        open={!!damageTarget}
        snCode={damageTarget?.snCode || ''}
        machineNumber={damageTarget?.machineNumber || ''}
        onClose={() => setDamageTarget(null)}
      />
    </PageContainer>
  );
}

// 路由懒加载要求默认导出
export { MachinesPage };
