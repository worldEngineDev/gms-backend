import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Dropdown, Empty, Flex, Input, Modal, Progress, Radio,
  Row, Select, Spin, Statistic, Table, Tag, Tooltip, Typography, message,
} from 'antd';
import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useMachines, useEquipmentConfig } from '@common/hooks/useData';
import * as api from '@common/api';
import {
  latestMachineByNumber, buildEffectiveStatusMap, MACHINE_STATUS_META,
  PRODUCTION_STATUS_META, PRODUCTION_STATUS_ORDER, productionStatusOf, deviceTypeLabel,
} from '@common/utils/domain';
import { useSNRegistry } from '@common/hooks/useData';
import { formatTime, naturalCompare } from '@common/utils/format';

export default function MachineStatusPage() {
  const qc = useQueryClient();
  const machines = useMachines();
  const snRegistry = useSNRegistry();
  const equipmentConfig = useEquipmentConfig();

  const [prodFilter, setProdFilter] = useState('all');
  const [deviceTypeFilter, setDeviceTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [histSearch, setHistSearch] = useState('');
  const [target, setTarget] = useState<{ number: string; status: string } | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [histMachine, setHistMachine] = useState<string | null>(null);
  const [infoMachine, setInfoMachine] = useState<string | null>(null);

  const machineList = machines.data || [];
  const registry = snRegistry.data || [];
  const eqConfigList = equipmentConfig.data || [];

  const latestMap = useMemo(() => latestMachineByNumber(machineList), [machineList]);
  const numbers = useMemo(() => Object.keys(latestMap).sort(naturalCompare), [latestMap]);
  const latestMachines = useMemo(() => numbers.map(n => latestMap[n]), [numbers, latestMap]);
  const effectiveMap = useMemo(() => buildEffectiveStatusMap(latestMachines, registry), [latestMachines, registry]);

  const deviceFiltered = useMemo(() => {
    if (deviceTypeFilter === 'all') return numbers;
    return numbers.filter(n => (latestMap[n]?.deviceType || '') === deviceTypeFilter);
  }, [numbers, deviceTypeFilter, latestMap]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ready: 0, in_production: 0, waiting_repair: 0, testing: 0 };
    for (const n of deviceFiltered) c[productionStatusOf(latestMap[n])]++;
    return c;
  }, [deviceFiltered, latestMap]);

  const visible = useMemo(() => {
    let list = deviceFiltered;
    if (prodFilter !== 'all') list = list.filter(n => productionStatusOf(latestMap[n]) === prodFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(n => n.toLowerCase().includes(q));
    }
    return list;
  }, [deviceFiltered, prodFilter, search, latestMap]);

  const history = useQuery({
    queryKey: ['production-history'],
    queryFn: () => api.getProductionHistory(),
  });

  const machineHistory = useQuery({
    queryKey: ['production-history', histMachine],
    queryFn: () => api.getProductionHistory(histMachine!),
    enabled: !!histMachine,
  });

  const machineInfo = useQuery({
    queryKey: ['machine-info', infoMachine],
    queryFn: () => api.getMachineInfo(infoMachine!),
    enabled: !!infoMachine,
  });
  useEffect(() => {
    if (!infoMachine) return;
    const ctrl = new AbortController();
    api.streamMachineLive(infoMachine, (data) => {
      qc.setQueryData(['machine-info', infoMachine], data);
    }, ctrl.signal).catch(() => { });
    return () => ctrl.abort();
  }, [infoMachine, qc]);
  const liveInfo = useMutation({
    mutationFn: (m: string) => api.getMachineInfo(m, { refresh: true }),
    onSuccess: (data) => qc.setQueryData(['machine-info', infoMachine], data),
  });
  const histItems = useMemo(() => {
    let list = history.data || [];
    const q = histSearch.trim().toLowerCase();
    if (q) list = list.filter((h: any) => (h.machineNumber || '').toLowerCase().includes(q));
    return list;
  }, [history.data, histSearch]);

  const eqLabel = (deviceType?: string) => {
    const cfg = eqConfigList.find(c => c.id === deviceType);
    return cfg ? `${cfg.icon || ''} ${cfg.name}` : deviceTypeLabel(deviceType);
  };

  const deviceTypeOptions = useMemo(() => {
    const opts = [{ value: 'all', label: '全部设备类型' }];
    const seen = new Set<string>();
    for (const n of numbers) {
      const dt = latestMap[n]?.deviceType;
      if (!dt || seen.has(dt)) continue;
      seen.add(dt);
      opts.push({ value: dt, label: eqLabel(dt) });
    }
    return opts;
  }, [numbers, latestMap, eqConfigList]);

  const openSwitch = (number: string, status: string) => {
    setTarget({ number, status });
    setReason('');
  };
  const menuItems = (number: string) =>
    PRODUCTION_STATUS_ORDER.filter(s => s !== 'waiting_repair').map(s => ({
      key: s,
      label: `标记为「${PRODUCTION_STATUS_META[s].label}」`,
      onClick: () => openSwitch(number, s),
    }));
  const confirmSwitch = async () => {
    if (!target) return;
    setSaving(true);
    try {
      await api.setProductionStatus(target.number, target.status, reason.trim());
      message.success(`${target.number} 已标记为「${PRODUCTION_STATUS_META[target.status].label}」`);
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['production-history'] });
      setTarget(null);
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    } finally {
      setSaving(false);
    }
  };

  const prodTag = (number: string) => {
    const st = productionStatusOf(latestMap[number]);
    const meta = PRODUCTION_STATUS_META[st] || PRODUCTION_STATUS_META.ready;
    const tag = <Tag color={meta.color} style={{ margin: 0, fontWeight: 600 }}>{meta.label}</Tag>;
    if (st === 'waiting_repair') {
      return (
        <Tooltip title="待维修由维修工单自动驱动；工单完成后自动恢复可生产">
          <span>{tag}</span>
        </Tooltip>
      );
    }
    return (
      <Dropdown menu={{ items: menuItems(number) }} trigger={['click']}>
        <a onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
          {tag} <DownOutlined style={{ fontSize: 10 }} />
        </a>
      </Dropdown>
    );
  };

  const isCollectorMachine = (n: string) => /^(?:we|szx3)-\d+$/.test(n);

  const devTag = (d: any) => {
    if (!d) return <Tag style={{ margin: 0, opacity: 0.5 }}>无</Tag>;
    if (d.probeConnected === false) return <Tag color="red" style={{ margin: 0 }}>未连接</Tag>;
    const age = d.ageS ?? d.age_s;
    const seen = d.everSeen ?? d.ever_seen;
    if (d.status === 'connected') {
      if (seen === false) return <Tag color="orange" style={{ margin: 0 }}>已连接·无数据</Tag>;
      if (typeof age === 'number') {
        if (age <= 2) return <Tag color="green" style={{ margin: 0 }}>实时 {age}s</Tag>;
        if (age <= 10) return <Tag color="orange" style={{ margin: 0 }}>延迟 {age}s</Tag>;
        return <Tag color="red" style={{ margin: 0 }}>断流 {age}s</Tag>;
      }
      return <Tag color="green" style={{ margin: 0 }}>已连接</Tag>;
    }
    return <Tag color="red" style={{ margin: 0 }}>{d.status === 'unknown' ? '未知' : '断开'}</Tag>;
  };

  const histColumns = [
    { title: '时间', dataIndex: 'createdAt', width: 160, render: (v: string) => formatTime(v) },
    {
      title: '变更', key: 'change', width: 180,
      render: (_: any, r: any) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          <Tag style={{ margin: 0 }}>{r.oldStatus ? (PRODUCTION_STATUS_META[r.oldStatus]?.label || r.oldStatus) : '初始'}</Tag>
          {' → '}
          <Tag color={PRODUCTION_STATUS_META[r.newStatus]?.color} style={{ margin: 0 }}>
            {PRODUCTION_STATUS_META[r.newStatus]?.label || r.newStatus}
          </Tag>
        </span>
      ),
    },
    { title: '原因', dataIndex: 'reason', render: (v: string) => v || '-' },
    { title: '操作人', key: 'op', render: (_: any, r: any) => r.operatorName || (r.source === 'ticket' ? '工单联动' : '-') },
    {
      title: '来源', dataIndex: 'source', width: 80,
      render: (v: string) => (v === 'ticket'
        ? <Tag color="purple" style={{ margin: 0 }}>工单</Tag>
        : <Tag style={{ margin: 0 }}>人工</Tag>),
    },
  ];

  const columns: any[] = [
    {
      title: '机器编号', dataIndex: 'machineNumber',
      render: (v: string) => <strong style={{ fontFamily: 'monospace' }}>{v}</strong>,
    },
    { title: '设备类型', dataIndex: 'deviceType', render: (v: string) => eqLabel(v) },
    { title: '生产状态', dataIndex: 'machineNumber', key: 'prod', render: (num: string) => prodTag(num) },
    {
      title: '设备挂接', dataIndex: 'machineNumber', key: 'bind',
      render: (num: string) => {
        const st = effectiveMap[num] || 'offline';
        const meta = MACHINE_STATUS_META[st] || MACHINE_STATUS_META.offline;
        return <Tag color={meta.color} style={{ margin: 0 }}>{meta.label}</Tag>;
      },
    },
    {
      title: '主机', dataIndex: 'machineNumber', key: 'host',
      render: (num: string) => {
        const m = latestMap[num];
        if (m?.hostOnline === undefined) return <span style={{ opacity: 0.45 }}>无代理</span>;
        return <span style={{ color: m.hostOnline ? '#52c41a' : '#999' }}>{m.hostOnline ? '🟢 在线' : '⚫ 离线'}</span>;
      },
    },
    {
      title: '备注/原因', key: 'reason',
      render: (_: any, r: any) => r.productionReason
        ? <Typography.Text ellipsis style={{ maxWidth: 220 }} title={r.productionReason}>{r.productionReason}</Typography.Text>
        : <span style={{ opacity: 0.45 }}>-</span>,
    },
    { title: '更新人', dataIndex: 'productionUpdatedByName', render: (v: string, r: any) => v || (r.productionSource === 'ticket' ? '工单联动' : '-') },
    { title: '更新时间', dataIndex: 'productionUpdatedAt', render: (v: string) => v ? formatTime(v) : '-' },
    {
      title: '操作', dataIndex: 'machineNumber', key: 'op', width: 220,
      render: (num: string) => (
        <Flex gap={4} wrap="wrap">
          <Button size="small" type="link" onClick={e => { e.stopPropagation(); setHistMachine(num); }}>历史</Button>
          {isCollectorMachine(num) && (
            <Button size="small" type="link" onClick={e => { e.stopPropagation(); setInfoMachine(num); }}>采集器</Button>
          )}
          <Dropdown menu={{ items: menuItems(num) }} trigger={['click']}>
            <Button size="small" icon={<DownOutlined />} onClick={e => e.stopPropagation()}>变更状态</Button>
          </Dropdown>
        </Flex>
      ),
    },
  ];

  return (
    <PageContainer
      title="机器状态"
      subtitle="生产状态可视化：可生产 / 在生产 / 待维修 / 在测试（待维修由维修工单自动驱动）"
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => {
          qc.invalidateQueries({ queryKey: ['machines'] });
          qc.invalidateQueries({ queryKey: ['production-history'] });
        }}>刷新</Button>
      }
    >
      
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={Math.floor(24 / (PRODUCTION_STATUS_ORDER.length + 1))}><Card size="small"><Statistic title={deviceTypeFilter === 'all' ? '机器总数' : `${eqLabel(deviceTypeFilter)} 数量`} value={deviceFiltered.length} /></Card></Col>
        {PRODUCTION_STATUS_ORDER.map(s => (
          <Col key={s} span={Math.floor(24 / (PRODUCTION_STATUS_ORDER.length + 1))}>
            <Card size="small">
              <Statistic
                title={PRODUCTION_STATUS_META[s].label}
                value={counts[s]}
                valueStyle={{ color: PRODUCTION_STATUS_META[s].color === 'red' ? '#ff4d4f' : undefined }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      
      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <Radio.Group value={prodFilter} onChange={e => setProdFilter(e.target.value)} optionType="button" buttonStyle="solid">
          <Radio.Button value="all">全部 ({deviceFiltered.length})</Radio.Button>
          {PRODUCTION_STATUS_ORDER.map(s => (
            <Radio.Button key={s} value={s}>{PRODUCTION_STATUS_META[s].label} ({counts[s]})</Radio.Button>
          ))}
        </Radio.Group>
        <Select
          value={deviceTypeFilter}
          onChange={setDeviceTypeFilter}
          options={deviceTypeOptions}
          style={{ width: 180 }}
          size="middle"
        />
        <Input.Search
          placeholder="搜索机器编号..." allowClear style={{ width: 220 }}
          onSearch={setSearch}
          onChange={e => { if (!e.target.value) setSearch(''); }}
        />
      </Flex>

      {visible.length === 0 && !machines.isLoading ? (
        <Empty description="暂无符合条件的机器" style={{ marginTop: 60 }} />
      ) : (
        <Table
          rowKey="machineNumber" size="small" loading={machines.isLoading}
          columns={columns}
          dataSource={visible.map(n => latestMap[n])}
          onRow={(r: any) => ({
            style: {
              cursor: 'pointer',
              background: productionStatusOf(r) === 'waiting_repair' ? '#fff7f6' : undefined,
            },
            onClick: () => setHistMachine(r.machineNumber),
          })}
          pagination={{ pageSize: 20, showTotal: t => `共 ${t} 台` }}
        />
      )}

      
      <Card size="small" style={{ marginTop: 20 }} title="生产状态变更记录" extra={
        <Input.Search
          placeholder="按机器编号筛选..." allowClear style={{ width: 200 }} size="small"
          onSearch={setHistSearch}
          onChange={e => { if (!e.target.value) setHistSearch(''); }}
        />
      }>
        <Table
          size="small"
          rowKey="id"
          loading={history.isLoading}
          dataSource={histItems}
          locale={{ emptyText: '暂无变更记录' }}
          pagination={{ pageSize: 10, showTotal: t => `共 ${t} 条` }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 150, render: (v: string) => formatTime(v) },
            { title: '机器', dataIndex: 'machineNumber', width: 110, render: (v: string) => <strong style={{ fontFamily: 'monospace' }}>{v}</strong> },
            {
              title: '变更', key: 'change', width: 180,
              render: (_: any, r: any) => (
                <span style={{ whiteSpace: 'nowrap' }}>
                  <Tag style={{ margin: 0 }}>{r.oldStatus ? (PRODUCTION_STATUS_META[r.oldStatus]?.label || r.oldStatus) : '初始'}</Tag>
                  {' → '}
                  <Tag color={PRODUCTION_STATUS_META[r.newStatus]?.color} style={{ margin: 0 }}>
                    {PRODUCTION_STATUS_META[r.newStatus]?.label || r.newStatus}
                  </Tag>
                </span>
              ),
            },
            { title: '原因', dataIndex: 'reason', render: (v: string) => v || '-' },
            { title: '操作人', key: 'op', render: (_: any, r: any) => r.operatorName || (r.source === 'ticket' ? '工单联动' : '-') },
            {
              title: '来源', dataIndex: 'source', width: 80,
              render: (v: string) => (v === 'ticket'
                ? <Tag color="purple" style={{ margin: 0 }}>工单</Tag>
                : <Tag style={{ margin: 0 }}>人工</Tag>),
            },
          ]}
        />
      </Card>

      
      <Modal
        title={histMachine ? `${histMachine} · 生产状态变更历史` : ''}
        open={!!histMachine}
        onCancel={() => setHistMachine(null)}
        footer={null}
        width={720}
      >
        {machineHistory.isLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : (machineHistory.data || []).length === 0 ? (
          <Empty description="暂无变更记录" />
        ) : (
          <Table
            size="small"
            rowKey="id"
            dataSource={machineHistory.data || []}
            pagination={{ pageSize: 10, showTotal: t => `共 ${t} 条` }}
            columns={histColumns}
          />
        )}
      </Modal>

      
      <Modal
        title={infoMachine ? `${infoMachine} · 机器状态信息` : ''}
        open={!!infoMachine}
        onCancel={() => setInfoMachine(null)}
        footer={
          <Flex gap={8} justify="flex-end">
            <Button
              icon={<ReloadOutlined spin={liveInfo.isPending} />}
              loading={liveInfo.isPending}
              onClick={() => infoMachine && liveInfo.mutate(infoMachine)}
            >
              实时刷新
            </Button>
            <Button type="primary" onClick={() => setInfoMachine(null)}>关闭</Button>
          </Flex>
        }
        width={720}
      >
        {machineInfo.isLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="正在从采集器读取状态..." /></div>
        ) : machineInfo.isError ? (
          <Alert type="error" showIcon message="无法连接采集器" description={(machineInfo.error as Error)?.message || '请确认机器在线后重试'} />
        ) : !machineInfo.data?.success ? (
          <Empty description={machineInfo.data?.error || '暂无数据'} />
        ) : (() => {
          const info = machineInfo.data;
          const sys = info.system || {};
          const dev = info.devices || {};
          const wuji = info.wuji || {};
          const task = info.task;
          const csMeta: Record<string, { l: string; c?: string }> = {
            RECORD: { l: '录制中', c: 'red' }, ACTIVE: { l: '就绪', c: 'green' },
            ALIGN: { l: '对齐中', c: 'orange' }, INIT: { l: '准备中', c: 'orange' },
            BOOT: { l: '启动中', c: 'orange' }, STOPPED: { l: '已停止' },
          };

          const stale = !!sys.stateStale;
          const csRaw = stale ? sys.lastControlState : sys.controlState;
          const cs = stale
            ? { l: '已停止' }
            : (csMeta[sys.controlState] || { l: sys.controlState || '未知' });
          const camName = (n: string) => ({
            front: '前置相机', left_wrist: '左手腕相机', right_wrist: '右手腕相机',
            ego_camera: '前置相机', wrist_left: '左手腕相机', wrist_right: '右手腕相机',
            vst_left: '头显左眼', vst_right: '头显右眼', overlay: '合成画面',
          } as Record<string, string>)[n] || n;
          const cell = (label: string, node: ReactNode, detail?: ReactNode) => (
            <div key={label} style={{ flex: '1 1 30%', minWidth: 150, background: '#fafafa', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>{label}</div>
              <div>{node}</div>
              {!!detail && <div style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>{detail}</div>}
            </div>
          );

          const netTag = (d: any) => {
            if (!d || d.connected === undefined) return <Tag style={{ margin: 0, opacity: 0.5 }}>无</Tag>;
            if (d.connected && (d.dataStreamOk === false || d.healthy === false)) {
              return <Tag color="red" style={{ margin: 0 }}>设备异常</Tag>;
            }
            if (d.connected && d.onlineJoints != null && Number(d.onlineJoints) < Number(d.expectedJoints || 20)) {
              return <Tag color="orange" style={{ margin: 0 }}>关节不全</Tag>;
            }
            return d.connected
              ? <Tag color="blue" style={{ margin: 0 }}>网络在线</Tag>
              : <Tag color="red" style={{ margin: 0 }}>网络不可达</Tag>;
          };
          const tagFor = (stream: any, net: any) => (
            net && (net.dataStreamOk === false || net.healthy === false || (net.onlineJoints != null && Number(net.onlineJoints) < Number(net.expectedJoints || 20)))
              ? netTag(net)
              : (stream ? devTag(stream) : netTag(net))
          );
          return (
            <div>
              {(machineInfo.data as any)?.partial?.importer && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="Importer(5025) 暂不可达" />}
              {(machineInfo.data as any)?.partial?.hermesOffline && (
                <div style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 8, padding: '6px 12px', fontSize: 13, color: '#8c8c8c', marginBottom: 8 }}>
                  采集程序未运行
                </div>
              )}
              {(machineInfo.data as any)?.partial?.hermesFailed && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="采集程序(5006) 暂不可达" />}

              
              <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}
                items={[
                  { key: 'act', label: '系统程序', children: (
                    <Flex gap={4} wrap="wrap" align="center">
                      <Tag color={sys.activity === 'running' ? 'green' : 'default'} style={{ margin: 0 }}>{sys.activity === 'running' ? '运行中' : sys.activity === 'idle' ? '空闲' : (sys.activity || '未知')}</Tag>
                      <Tag color={cs.c || 'default'} style={{ margin: 0 }}>{cs.l}</Tag>
                      {!stale && sys.isRecording && <Tag color="red" style={{ margin: 0 }}>● 录制中</Tag>}
                      {sys.emergencyStopped && <Tag color="red" style={{ margin: 0 }}>急停</Tag>}
                      {stale && csRaw && (
                        <span style={{ fontSize: 11, opacity: 0.65 }}>
                          停止前: {csMeta[csRaw]?.l || csRaw}{sys.lastIsRecording ? '·录制中' : ''}（{sys.lastStateAgeSec ? `${Math.round(sys.lastStateAgeSec / 60)} 分钟前` : '时间未知'}）
                        </span>
                      )}
                    </Flex>
                  ) },
                  { key: 'err', label: '错误数', children: (sys.errorCount ?? 0) > 0 ? <Tag color="red" style={{ margin: 0 }}>{sys.errorCount}</Tag> : <Tag color="green" style={{ margin: 0 }}>0</Tag> },
                  { key: 'ver', label: '程序版本', children: `Importer ${info.importerVersion || '-'} / 采集 ${info.collectorVersion || '-'}` },
                  { key: 'id', label: '采集器', children: `${info.collectorName || '-'}（主机 ${info.computerId || '-'}）` },
                ]}
              />

              
              <Card size="small" title="当前任务" style={{ marginBottom: 12 }}>
                {task ? (
                  <>
                    <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                      <div>
                        <Typography.Text strong>{task.name}</Typography.Text>
                        {task.isTraining && <Tag color="purple" style={{ marginLeft: 8 }}>培训</Tag>}
                        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                          采集员：{task.operator?.name}{task.operator?.level != null ? `（等级 ${task.operator.level}）` : ''}
                        </div>
                      </div>
                      <Tag color={task.state === 'active' ? 'blue' : 'default'} style={{ margin: 0 }}>{task.state === 'active' ? '进行中' : (task.state || '-')}</Tag>
                    </Flex>
                    <Progress
                      style={{ marginTop: 10, marginBottom: 0 }}
                      percent={task.percent ?? 0}
                      format={() => `${task.hoursCompleted != null ? Number(task.hoursCompleted).toFixed(2) : '0'} / ${task.hours != null ? Number(task.hours).toFixed(2) : '-'} 小时`}
                    />
                  </>
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有任务" />}
              </Card>

              
              <Card size="small" title="设备状态" style={{ marginBottom: 12 }}>
                {!dev.dexterousHands?.left && !dev.dexterousHands?.right && !dev.quest && !dev.gloves?.left && !dev.gloves?.right && !dev.cameras?.length && !dev.other?.length && !info.questInfo && !info.devicesNet && !info.camerasFps?.length && !info.cameras?.length && !info.wuji ? (
                  <div style={{ color: '#8c8c8c', fontSize: 13, padding: '4px 0' }}>
                    采集程序未运行
                  </div>
                ) : (
                  <>
                    <Flex wrap="wrap" gap={8}>
                      {(() => {
                        const handDetail = (side: string, net: any) => {
                          const hs = info.handStream?.[side === 'left' ? 'left' : 'right'];
                          const hsLive = hs && hs.ageSec != null && hs.ageSec <= 90 && hs.hz != null;
                          return (
                            <>
                              {net?.snCode && <span style={{ fontFamily: 'monospace' }}>SN: {net.snCode}　</span>}
                              {net?.onlineJoints != null && (
                                <span style={{ fontFamily: 'monospace' }}>
                                  关节 {net.onlineJoints}/{net.expectedJoints || 20}　
                                </span>
                              )}
                              {info.teleopDelay && info.teleopDelay[side] != null && <span>延迟 {Math.round(Number(info.teleopDelay[side]))}ms　</span>}
                              {hsLive && (
                                <span style={{ fontFamily: 'monospace' }}>
                                  {hs.hz} Hz{hs.target != null ? `/${hs.target}` : ''}
                                  {hs.lateTicks != null && hs.totalTicks != null ? ` 迟到${hs.lateTicks}/${hs.totalTicks}` : ''}　
                                </span>
                              )}
                              {net?.connected === false && <span style={{ color: '#cf1322' }}>网络不可达</span>}
                              {net?.error && <span style={{ color: '#cf1322' }}>{net.error}</span>}
                            </>
                          );
                        };
                        const lNet = info.devicesNet?.dexterousHands?.left || wuji.dexterousHands?.left;
                        const rNet = info.devicesNet?.dexterousHands?.right || wuji.dexterousHands?.right;
                        return (
                          <>
                            {cell('灵巧手（左）', tagFor(dev.dexterousHands?.left, lNet), handDetail('left', lNet))}
                            {cell('灵巧手（右）', tagFor(dev.dexterousHands?.right, rNet), handDetail('right', rNet))}
                          </>
                        );
                      })()}
                      {(() => {
                        const qi = info.questInfo;
                        const netOff = qi && qi.netConnected === false;
                        return cell('Quest', tagFor(dev.quest, qi ? { connected: qi.netConnected } : null),
                          <span>
                            {qi?.serialNumber && <span style={{ fontFamily: 'monospace' }}>SN: {qi.serialNumber}　</span>}
                            {qi && !qi.serialNumber && qi.adbStatus === 'unauthorized' && <span style={{ color: '#d46b08' }}>USB 调试未授权　</span>}
                            {qi && qi.batteryLevel != null && <span>电量 {qi.batteryLevel}%{qi.batteryStatus === 'charging' ? '（充电中）' : qi.batteryStatus === 'full' ? '（已充满）' : ''}{qi.batteryTemp != null ? `　${qi.batteryTemp}℃` : ''}</span>}
                            {!qi?.serialNumber && !qi?.batteryLevel && netOff && <span style={{ color: '#cf1322' }}>网络不可达</span>}
                          </span>);
                      })()}
                      {(() => {
                        const gloveDetail = (net: any) => net ? (
                          <span style={{ fontFamily: 'monospace' }}>
                            {net.snCode || net.sn ? `SN: ${net.snCode || net.sn}` : 'SN: 未读取'}
                            {(net.tactileOk != null || net.emfPosesOk != null) && (
                              <>　触觉 {net.tactileOk ? '✓' : '×'} · 姿态 {net.emfPosesOk ? '✓' : '×'}</>
                            )}
                            {net.dataStreamOk != null && <>　数据流 {net.dataStreamOk ? '✓' : '×'}</>}
                            {(net.tactileFrames != null || net.emfPosesFrames != null) && (
                              <span>　帧 {net.tactileFrames ?? 0}/{net.emfPosesFrames ?? 0}</span>
                            )}
                            {net.error && <span style={{ color: '#cf1322' }}>　{net.error}</span>}
                          </span>
                        ) : null;
                        const lGlove = info.devicesNet?.gloves?.left || wuji.gloves?.left;
                        const rGlove = info.devicesNet?.gloves?.right || wuji.gloves?.right;
                        return (
                          <>
                            {cell('手套（左）', tagFor(dev.gloves?.left, lGlove), gloveDetail(lGlove))}
                            {cell('手套（右）', tagFor(dev.gloves?.right, rGlove), gloveDetail(rGlove))}
                          </>
                        );
                      })()}
                      {(dev.marvin || dev.other?.some((o: any) => o.key === 'robot/marvin') || info.devicesNet?.roboticArm) && cell('机械臂 Marvin',
                        tagFor(dev.marvin, info.devicesNet?.roboticArm ? { connected: info.devicesNet.roboticArm.connected } : null),
                        info.devicesNet?.roboticArm && info.devicesNet.roboticArm.connected === false ? <span style={{ color: '#cf1322' }}>网络不可达</span> : null)}
                      {(() => {
                        const cameraRows = (dev.cameras && dev.cameras.length)
                          ? dev.cameras
                          : ((info.camerasFps && info.camerasFps.length)
                            ? info.camerasFps
                            : ((info.cameras && info.cameras.length)
                              ? info.cameras : (info.cameraFps?.cameras || [])));
                        return cameraRows.map((c: any) => {
                        const cameraKey = c.name || c.cameraId || c.device;
                        const res = (info.sensors || []).find((s: any) => s.id === c.name);
                        const fpsCamera = (info.cameraFps?.cameras || []).find((x: any) =>
                          x.cameraId === cameraKey || x.name === cameraKey || x.device === cameraKey
                          || (x.cameraId === 'ego_camera' && cameraKey === 'front')
                          || (x.cameraId === 'wrist_left' && cameraKey === 'left_wrist')
                          || (x.cameraId === 'wrist_right' && cameraKey === 'right_wrist')
                        ) || c;
                        const rawFps = fpsCamera && (fpsCamera.currentFPS ?? fpsCamera.fps);
                        const fps = Number(rawFps);
                        const fpsDetail = Number.isFinite(fps) && fps > 0
                          ? `${fps.toFixed(1)} fps`
                          : 'FPS 暂无';
                        const resolution = res && res.width ? `${res.width}×${res.height}` : null;
                        const cameraStatus = Number.isFinite(fps) && fps > 0
                          ? (fpsCamera.isDropping ? <Tag color="orange" style={{ margin: 0 }}>掉帧</Tag> : <Tag color="green" style={{ margin: 0 }}>正常</Tag>)
                          : <Tag style={{ margin: 0, opacity: 0.6 }}>无数据</Tag>;
                        return cell(
                          camName(cameraKey),
                          <Flex align="center" gap={6} wrap="wrap">
                            {dev.cameras?.length ? devTag(c) : cameraStatus}
                            <span style={{ fontFamily: 'monospace', fontSize: 12, color: Number.isFinite(fps) && fps > 0 ? '#389e0d' : '#8c8c8c' }}>
                              {fpsDetail}
                            </span>
                          </Flex>,
                          resolution,
                        );
                        });
                      })()}
                    </Flex>
                    {(info.cameraFps?.fps != null || !!info.vstFps) && (() => {
                      const cf = info.cameraFps;
                      const age: number | null = cf?.ageSec ?? null;
                      const ageTxt = age == null ? ''
                        : age <= 60 ? '（录制中·实时）'
                        : age < 3600 ? `（${Math.round(age / 60)} 分钟前日志）`
                        : `（${Math.round(age / 3600)} 小时前日志）`;
                      return (
                        <div style={{ fontSize: 11, opacity: 0.65, marginTop: 8 }}>
                          {cf?.fps != null && <span>三路平均 <b>{Number(cf.fps).toFixed(1)}</b> fps{ageTxt}　·　</span>}
                          {!!info.vstFps && <span>透视配置 {info.vstFps} fps</span>}
                        </div>
                      );
                    })()}
                  </>
                )}
              </Card>

              
              <Card size="small" title="采集器容器">
                <Flex gap={4} wrap="wrap" style={{ marginBottom: (info.degraded?.length || info.errors?.length) ? 8 : 0 }}>
                  {(info.containers || []).map((c: any) => (
                    <Tag key={c.name} color={c.status === 'running' ? 'green' : 'red'} style={{ margin: 0 }}>
                      {c.name}: {c.status === 'running' ? '运行中' : c.status}
                    </Tag>
                  ))}
                  {!info.containers?.length && <span style={{ opacity: 0.45 }}>-</span>}
                </Flex>
                {!!info.degraded?.length && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`降级部件：${info.degraded.join('、')}`} />}
                {!!info.errors?.length && <Alert type="error" showIcon message={`采集器错误：${info.errors.length} 条`} description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(info.errors, null, 2)}</pre>} />}
              </Card>
              <div style={{ color: '#8c8c8c', fontSize: 12, textAlign: 'right' }}>
                {info.source === 'agent'
                  ? <>数据来源：心跳快照（{info.dataAgeSec != null ? info.dataAgeSec : '?'} 秒前上报，每 30 秒自动更新）</>
                  : '数据来源：实时抓取'}
              </div>
            </div>
          );
        })()}
      </Modal>

      
      <Modal
        title={target ? `${target.number} 标记为「${PRODUCTION_STATUS_META[target.status]?.label || ''}」` : ''}
        open={!!target}
        onOk={confirmSwitch}
        confirmLoading={saving}
        onCancel={() => setTarget(null)}
        okText="确认" cancelText="取消"
      >
        <p style={{ marginBottom: 8 }}>
          机器编号：<strong>{target?.number}</strong>
        </p>
        <Input.TextArea
          rows={3} maxLength={500} showCount
          placeholder="变更原因/备注（可选），如：排产任务、维修后复测…"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
      </Modal>
    </PageContainer>
  );
}
