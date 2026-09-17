import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Empty, Input, Segmented, Select, Spin, Tooltip } from 'antd';
import {
  AppstoreOutlined, BarChartOutlined, LogoutOutlined, MenuOutlined,
  ReloadOutlined, SearchOutlined, SettingOutlined, TeamOutlined, ToolOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useMachines } from '@common/hooks/useData';
import { useAuthStore, isSuperAdmin } from '@common/stores/auth';
import { naturalCompare } from '@common/utils/format';
import * as api from '@common/api';
import './overwatch.css';

type RuntimeStatus = 'error' | 'recording' | 'online_idle' | 'offline';
type Machine = Record<string, any> & {
  machineNumber: string;
  _runtimeStatus?: RuntimeStatus;
  _collectionReady?: boolean;
  _collectionReasons?: string[];
  _collectionNotes?: string[];
};

const STATUS_META: Record<RuntimeStatus, { label: string; color: string; glow: string }> = {
  error: { label: '异常', color: '#ff5b63', glow: 'rgba(255,91,99,.18)' },
  recording: { label: '运行中', color: '#41d68a', glow: 'rgba(65,214,138,.14)' },
  online_idle: { label: '空闲', color: '#4ea1ff', glow: 'rgba(78,161,255,.14)' },
  offline: { label: '离线', color: '#78889b', glow: 'rgba(120,136,155,.08)' },
};
const STATUS_ORDER: RuntimeStatus[] = ['error', 'recording', 'online_idle', 'offline'];
const SN_ADVISORY_CODES = new Set([
  'glove_no_sn', 'sn_unusable', 'sn_bound_elsewhere', 'unregistered_sn',
  'bound_but_disconnected',
]);
const INITIAL_MACHINE_RENDER_LIMIT = 120;
const MACHINE_RENDER_BATCH_SIZE = 120;
const OPERATIONS_REFRESH_INTERVAL_MS = 5000;
const isSNAdvisory = (alert: any) => {
  const code = String(alert?.code || '').trim().toLowerCase();
  return SN_ADVISORY_CODES.has(code) || code === 'hand_mismatch' || /(^|_)sn(_|$)/.test(code);
};

const isCollectorInactive = (machine: Machine) => {
  const importer = machine.importer || {};
  const health = importer.health || importer.maintenanceHealth || importer;
  const roleStatus = machine.edgeContainerRoleStatus || machine.containerRoleStatus || {};
  const hasRoleSnapshot = Object.keys(roleStatus).length > 0;
  return importer.collectorAlive === false || health.is_collector_alive === false
    || machine.collectorStarted === false
    || (hasRoleSnapshot && roleStatus.collector?.running !== true);
};

const isIgnoredRuntimeAlert = (machine: Machine, alert: any) =>
  isSNAdvisory(alert) || (alert?.code === 'hermes_unreachable' && isCollectorInactive(machine));

function statusOf(machine: Machine): RuntimeStatus {
  if (machine.hostOnline === false) return 'offline';
  if (isCollectorInactive(machine)) return 'online_idle';
  const hermes = machine.hermes || {};
  const state = hermes.state || {};
  const health = hermes.health || {};
  const alerts = machine.edgeAlerts || machine.alerts || [];
  const collectorInactive = isCollectorInactive(machine);
  const hasOperationalError = state.emergencyStopped || (!collectorInactive && (Number(state.errorCount || 0) > 0
    || (Array.isArray(health.degraded) && health.degraded.length > 0)))
    || (Array.isArray(alerts) && alerts.some((a: any) => !isIgnoredRuntimeAlert(machine, a) && a?.level === 'error'));
  if (hasOperationalError) return 'error';
  // 兼容旧快照：只有 SN 提示时，历史 runtimeStatus=error 不再继续标红。
  // 没有告警上下文的 error 快照仍保留异常，避免吞掉未知的真实故障。
  if (machine.runtimeStatus === 'error' && !collectorInactive
    && (!Array.isArray(alerts) || alerts.length === 0 || alerts.some((a: any) => !isIgnoredRuntimeAlert(machine, a)))) return 'error';
  if (machine.runtimeStatus === 'recording') return 'recording';
  if (machine.runtimeStatus === 'offline' && machine.hostOnline !== true) return 'offline';
  if (state.isRecording || state.controlState === 'RECORD') return 'recording';
  return machine.hostOnline === true ? 'online_idle' : 'offline';
}

function taskOf(machine: Machine) {
  return machine.task || machine.importer?.task || null;
}

function operatorOf(machine: Machine) {
  const task = taskOf(machine);
  return task?.operator || null;
}

function importerOf(machine: Machine) {
  return machine.importer || {};
}

function processingOf(machine: Machine) {
  const importer = importerOf(machine);
  return importer.processing || machine.processing || {};
}

function machineTypeLabel(machine: Machine) {
  const machineId = machine.importer?.machineId || machine.machineId || machine.system?.machineId || '';
  if (/iris/i.test(String(machineId))) return '灵巧手';
  if (machine.machineType === 'glove_only' || machine.deviceType === 'glove') return '纯手套';
  if (machine.machineType === 'dexterous' || machine.deviceType === 'dexterous') return '灵巧手';
  return machine.deviceType || '设备';
}

function collectionReadiness(machine: Machine): { ready: boolean; reasons: string[]; notes: string[] } {
  const reasons: string[] = [];
  const notes: string[] = [];
  const status = statusOf(machine);
  const hermes = machine.hermes || {};
  const state = hermes.state || {};
  const alerts = Array.isArray(machine.edgeAlerts || machine.alerts) ? (machine.edgeAlerts || machine.alerts) : [];

  if (machine.hostOnline !== true) reasons.push('主机离线');
  if (status === 'recording') reasons.push('机器正在采集');
  const onlySnAlerts = alerts.length > 0 && alerts.every(isSNAdvisory);
  if (state.emergencyStopped) reasons.push('机器处于急停状态');
  else if (status === 'error' && !onlySnAlerts) reasons.push(firstProblem(machine));
  // SN 归属、登记和损坏状态属于资产管理信息；不影响机器是否能启动采集。

  return {
    ready: reasons.length === 0,
    reasons: Array.from(new Set(reasons)),
    notes: Array.from(new Set(notes)),
  };
}

function formatSeconds(value: any) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return '-';
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小时`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)} 分钟`;
  return `${Math.round(seconds * 10) / 10} 秒`;
}

function formatBytes(value: any) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTimestamp(value: any) {
  if (value == null || value === '') return '-';
  const raw = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))
    ? Number(value) : NaN;
  const date = Number.isFinite(raw)
    ? new Date(raw > 1e12 ? raw : raw * 1000)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function firstProblem(machine: Machine) {
  const alerts = machine.edgeAlerts || machine.alerts || [];
  const first = Array.isArray(alerts) ? alerts.find((alert: any) => !isIgnoredRuntimeAlert(machine, alert)) : null;
  if (first?.message) return first.message;
  const degraded = machine.hermes?.health?.degraded;
  if (Array.isArray(degraded) && degraded.length) return `异常部件：${degraded.slice(0, 3).join('、')}`;
  if (machine.emergencyStopped || machine.hermes?.state?.emergencyStopped) return '机器处于急停状态';
  return '设备或采集程序异常';
}

function LiveClock() {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleString('zh-CN', { hour12: false }));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="ow-clock">{clock}</span>;
}

export default function PersonalAnalysisPage() {
  const query = useMachines();
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  const [liveMap, setLiveMap] = useState<Record<string, Machine>>({});
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [detailMachine, setDetailMachine] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [operationsCenter, setOperationsCenter] = useState<any>(null);
  const [operationsUpdatedAt, setOperationsUpdatedAt] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'collection' | 'quality' | 'processing'>('overview');
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_MACHINE_RENDER_LIMIT);
  const liveQueue = useRef<Map<string, Machine>>(new Map());
  const liveFlushTimer = useRef<number | null>(null);

  useEffect(() => {
    const flushLiveUpdates = () => {
      liveFlushTimer.current = null;
      const queued = liveQueue.current;
      if (!queued.size) return;
      liveQueue.current = new Map();
      setLiveMap(prev => {
        const next = { ...prev };
        for (const [machineNumber, update] of queued) {
          next[machineNumber] = { ...(prev[machineNumber] || {}), ...update };
        }
        return next;
      });
    };
    const handler = (event: Event) => {
      const update = (event as CustomEvent).detail as Machine;
      if (!update?.machineNumber) return;
      liveQueue.current.set(update.machineNumber, {
        ...(liveQueue.current.get(update.machineNumber) || {}),
        ...update,
      });
      if (liveFlushTimer.current === null) {
        liveFlushTimer.current = window.setTimeout(flushLiveUpdates, 100);
      }
    };
    window.addEventListener('gms_event:machine_live_updated', handler);
    return () => {
      window.removeEventListener('gms_event:machine_live_updated', handler);
      if (liveFlushTimer.current !== null) window.clearTimeout(liveFlushTimer.current);
      liveFlushTimer.current = null;
      liveQueue.current.clear();
    };
  }, []);

  useEffect(() => {
    setVisibleLimit(INITIAL_MACHINE_RENDER_LIMIT);
  }, [statusFilter, typeFilter, search]);

  useEffect(() => {
    if (!detailMachine) {
      setDetail(null);
      setOperationsCenter(null);
      setOperationsUpdatedAt(null);
      setDetailTab('overview');
      return;
    }
    setDetail(null);
    setOperationsCenter(null);
    setOperationsUpdatedAt(null);
    const controller = new AbortController();
    let active = true;
    let operationsBusy = false;
    const refreshOperations = async () => {
      if (operationsBusy) return;
      operationsBusy = true;
      try {
        const value = await api.getMachineOperationsCenter(detailMachine);
        if (active) {
          setOperationsCenter(value);
          setOperationsUpdatedAt(Date.now());
        }
      } catch {
        // 保留最后一次成功结果；短暂断线不应让实时面板整块闪空。
      } finally {
        operationsBusy = false;
      }
    };
    api.getMachineInfo(detailMachine).then(value => { if (active) setDetail(value); }).catch(() => {});
    void refreshOperations();
    api.streamMachineLive(detailMachine, value => { if (active) setDetail(value); }, controller.signal).catch(() => {});
    const operationsTimer = window.setInterval(refreshOperations, OPERATIONS_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(operationsTimer);
    };
  }, [detailMachine]);

  const baseMachines = useMemo(() => {
    const map: Record<string, Machine> = {};
    for (const raw of query.data || []) {
      const number = raw.machineNumber || raw.id;
      if (!number) continue;
      map[number] = { ...(map[number] || {}), ...raw, machineNumber: number };
    }
    return map;
  }, [query.data]);

  const machines = useMemo(() => {
    const map: Record<string, Machine> = { ...baseMachines };
    for (const [number, live] of Object.entries(liveMap)) {
      map[number] = { ...(map[number] || { machineNumber: number }), ...live, machineNumber: number };
    }
    return Object.values(map).map(machine => {
      const readiness = collectionReadiness(machine);
      return {
        ...machine,
        _runtimeStatus: statusOf(machine),
        _collectionReady: readiness.ready,
        _collectionReasons: readiness.reasons,
        _collectionNotes: readiness.notes,
      };
    })
      .sort((a, b) => naturalCompare(a.machineNumber, b.machineNumber));
  }, [baseMachines, liveMap]);

  const counts = useMemo(() => {
    const value: Record<string, number> = { all: machines.length, collectable: 0, error: 0, recording: 0, online_idle: 0, offline: 0 };
    machines.forEach(machine => {
      value[machine._runtimeStatus!] += 1;
      if (machine._collectionReady) value.collectable += 1;
    });
    return value;
  }, [machines]);

  const typeOptions = useMemo(() => {
    const values = new Set(machines.map(machineTypeLabel));
    return [{ value: 'all', label: '全部机器类型' }, ...Array.from(values).sort().map(v => ({ value: v, label: v }))];
  }, [machines]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return machines.filter(machine => {
      if (statusFilter === 'collectable' && !machine._collectionReady) return false;
      if (statusFilter !== 'all' && statusFilter !== 'collectable' && machine._runtimeStatus !== statusFilter) return false;
      if (typeFilter !== 'all' && machineTypeLabel(machine) !== typeFilter) return false;
      if (!q) return true;
      const task = taskOf(machine);
      const operator = operatorOf(machine);
      return [machine.machineNumber, task?.name, task?.taskName, operator?.name, operator?.username]
        .some(value => String(value || '').toLowerCase().includes(q));
    });
  }, [machines, statusFilter, typeFilter, search]);

  const renderedVisible = useMemo(() => visible.slice(0, visibleLimit), [visible, visibleLimit]);

  const groups = useMemo(() => {
    const out: Record<RuntimeStatus, Machine[]> = { error: [], recording: [], online_idle: [], offline: [] };
    renderedVisible.forEach(machine => out[machine._runtimeStatus!].push(machine));
    return out;
  }, [renderedVisible]);

  const menuItems = [
    { key: 'tasks', icon: <AppstoreOutlined />, label: '任务列表', onClick: () => navigate('/tasks') },
    { key: 'analysis', icon: <BarChartOutlined />, label: '数据分析', onClick: () => navigate('/analysis') },
    { key: 'team', icon: <TeamOutlined />, label: '组员', onClick: () => navigate('/team') },
    { key: 'support', icon: <ToolOutlined />, label: '技术支持', onClick: () => navigate('/tech-support/submit') },
    ...(isSuperAdmin(user) ? [{ key: 'maintenance', icon: <SettingOutlined />, label: '切换到运维端', onClick: () => { window.location.href = 'index.html'; } }] : []),
    { type: 'divider' as const },
    { key: 'logout', danger: true, icon: <LogoutOutlined />, label: '退出登录', onClick: () => logout() },
  ];

  const renderCard = (machine: Machine) => {
    const status = machine._runtimeStatus!;
    const meta = STATUS_META[status];
    const task = taskOf(machine);
    const operator = operatorOf(machine);
    const taskName = task?.name || task?.taskName || '暂无任务';
    const operatorName = operator?.name || operator?.displayName || operator?.username || '未分配';
    const importer = importerOf(machine);
    const processing = processingOf(machine);
    const workers = Array.isArray(importer.workers) ? importer.workers : (Array.isArray(processing.workers) ? processing.workers : []);
    const busyWorkers = workers.filter((worker: any) => Number(worker?.busy || 0) > 0).length;
    const pending = workers.reduce((sum: number, worker: any) => sum + Number(worker?.pending || worker?.queue || 0), 0);
    const health = importer.health || importer.maintenanceHealth || importer;
    const collectorAlive = importer.collectorAlive ?? health.is_collector_alive;
    const loggedIn = importer.loggedIn ?? health.is_logged_in;
    const runtimeLabel = collectorAlive === false ? '采集器停止' : (loggedIn === false ? '未登录' : (health.activity || '运行状态未知'));
    return (
      <button
        key={machine.machineNumber}
        className={`ow-machine-card ow-${status}`}
        style={{ '--ow-status': meta.color, '--ow-glow': meta.glow } as React.CSSProperties}
        onClick={() => setDetailMachine(machine.machineNumber)}
      >
        <div className="ow-card-top">
          <strong>{machine.machineNumber}</strong>
          <span className="ow-status-stack">
            <Tooltip title={machine._collectionReady
              ? (machine._collectionNotes?.length ? machine._collectionNotes.join('；') : '采集条件已满足')
              : machine._collectionReasons?.join('；')}>
              <span className={`ow-production-status ${machine._collectionReady ? (machine._collectionNotes?.length ? 'is-standby' : 'is-ready') : 'is-blocked'}`}>
                {status === 'recording' ? '采集中' : machine._collectionReady ? (machine._collectionNotes?.length ? '待上电确认' : '可采集') : '不可采集'}
              </span>
            </Tooltip>
            <span className="ow-status"><i />{meta.label}</span>
          </span>
        </div>
        <div className="ow-card-task" title={taskName}>{taskName}</div>
        <div className="ow-card-details">
          <span>{operatorName}</span><span>{machineTypeLabel(machine)}</span><span>{task?.state || '任务状态未知'}</span>
        </div>
        <div className="ow-card-runtime">
          <span title="机器 ID">机器 {importer.machineId || machine.machineId || '-'}</span>
          <span title="Computer ID">Computer {importer.computerId || machine.computerId || '-'}</span>
          <span title="Workflow">{importer.workflow || machine.workflow || 'hermes'}</span>
          <span title="采集器类型">{importer.collectorType || machine.collectorType || '-'}</span>
          <span title="Worker 状态">Worker {workers.length ? `${busyWorkers}/${workers.length} 忙碌` : '-'}</span>
          <span title="待处理数量">待处理 {pending}</span>
          <span title="Importer 版本">Importer {importer.importerVersion || machine.importerVersion || '-'}</span>
          <span title="运行/登录状态">{runtimeLabel} · {loggedIn === true ? '已登录' : loggedIn === false ? '未登录' : '登录未知'}</span>
        </div>
        {status === 'error' && <div className="ow-card-problem">{firstProblem(machine)}</div>}
        {status !== 'error' && !machine._collectionReady && <div className="ow-card-blocked">不可采集：{machine._collectionReasons?.[0] || '条件未满足'}</div>}
        {status !== 'error' && machine._collectionReady && !!machine._collectionNotes?.length && <div className="ow-card-standby">待确认：{machine._collectionNotes[0]}</div>}
      </button>
    );
  };

  const detailStatus = detailMachine
    ? STATUS_META[statusOf({ ...(machines.find(m => m.machineNumber === detailMachine) || { machineNumber: detailMachine }), ...(detail || {}) })]
    : null;

  return (
    <div className="ops-overwatch">
      <header className="ow-header">
        <div className="ow-brand">
          <span className="ow-logo">W</span>
          <div><h1>机器状态中心</h1><p>WORLDENGINE · OPERATIONS OVERWATCH</p></div>
        </div>
        <div className="ow-header-right">
          <div className="ow-realtime"><i /> 实时连接 <small>约 2 秒</small></div>
          <LiveClock />
          <Tooltip title="刷新基础机器列表"><Button type="text" icon={<ReloadOutlined />} onClick={() => query.refetch()} /></Tooltip>
          <Dropdown menu={{ items: menuItems }} trigger={['click']}>
            <Button className="ow-menu-button" icon={<MenuOutlined />}>{user?.displayName || user?.username}</Button>
          </Dropdown>
        </div>
      </header>

      <section className="ow-toolbar">
        <div className="ow-counts">
          <button className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>全部 <b>{counts.all}</b></button>
          <button className={`ow-collectable-filter ${statusFilter === 'collectable' ? 'active' : ''}`} onClick={() => setStatusFilter('collectable')}>
            <i />可采集 <b>{counts.collectable}</b>
          </button>
          {STATUS_ORDER.map(status => (
            <button key={status} className={statusFilter === status ? 'active' : ''} onClick={() => setStatusFilter(status)}>
              <i style={{ background: STATUS_META[status].color }} />{STATUS_META[status].label} <b>{counts[status]}</b>
            </button>
          ))}
        </div>
        <div className="ow-filters">
          <Select value={typeFilter} onChange={setTypeFilter} options={typeOptions} />
          <Input allowClear prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索机器、任务或操作员" />
          <Segmented value={grouped ? 'group' : 'grid'} onChange={v => setGrouped(v === 'group')} options={[{ label: '状态分组', value: 'group' }, { label: '统一网格', value: 'grid' }]} />
        </div>
      </section>

      <main className="ow-content">
        {query.isLoading && machines.length === 0 ? <div className="ow-loading"><Spin /><span>正在加载机器状态...</span></div> : null}
        {!query.isLoading && visible.length === 0 ? <Empty description="暂无符合条件的机器" /> : null}
        {visible.length > 0 && (grouped ? (
          STATUS_ORDER.map(status => groups[status].length > 0 && (
            <section className="ow-group" key={status}>
              <div className="ow-group-heading" style={{ color: STATUS_META[status].color }}>
                <span>{STATUS_META[status].label}</span><b>{groups[status].length}</b><i />
              </div>
              <div className="ow-grid">{groups[status].map(renderCard)}</div>
            </section>
          ))
        ) : <div className="ow-grid">{renderedVisible.map(renderCard)}</div>)}
        {visible.length > renderedVisible.length && (
          <div className="ow-load-more">
            <Button onClick={() => setVisibleLimit(limit => limit + MACHINE_RENDER_BATCH_SIZE)}>
              加载更多（剩余 {visible.length - renderedVisible.length} 台）
            </Button>
          </div>
        )}
      </main>

      {detailMachine && (
        <div className="ow-detail-mask" onMouseDown={e => { if (e.target === e.currentTarget) setDetailMachine(null); }}>
          <aside className="ow-detail ow-detail-wide">
            <div className="ow-detail-head">
              <div className="ow-detail-title"><small>机器状态中心 / 实时详情</small><h2>{detailMachine}</h2><span>{detail?.source === 'agent' ? `实时刷新 · 状态 2 秒 / 统计 5 秒 · Agent 数据 ${detail.dataAgeSec ?? '?'} 秒前${operationsUpdatedAt ? ` · 统计更新 ${new Date(operationsUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}` : 'Importer 实时读取'}</span></div>
              <div className="ow-detail-actions"><Button icon={<ReloadOutlined />} onClick={() => { api.getMachineInfo(detailMachine).then(setDetail).catch(() => {}); api.getMachineOperationsCenter(detailMachine).then(value => { setOperationsCenter(value); setOperationsUpdatedAt(Date.now()); }).catch(() => {}); }}>立即刷新</Button><button aria-label="关闭" onClick={() => setDetailMachine(null)}>×</button></div>
            </div>
            {!detail ? <div className="ow-loading"><Spin /><span>实时连接中...</span></div> : (
              <div className="ow-detail-body">
                <div className="ow-detail-status" style={{ color: detailStatus?.color }}><i style={{ background: detailStatus?.color }} />{detailStatus?.label}<span>{detail.system?.activity || detail.system?.controlState || '状态未知'}</span></div>
                <section className="ow-center-summary">
                  <div className="ow-center-title">Importer 系统概览</div>
                  <div className="ow-center-grid">
                    <div><small>运行状态</small><b>{operationsCenter?.login?.activity || detail.system?.activity || '-'}</b></div>
                    <div><small>Collector</small><b>{(detail.collectorAlive ?? detail.system?.collectorAlive) == null ? '-' : (detail.collectorAlive ?? detail.system?.collectorAlive) ? '存活' : '停止'}</b></div>
                    <div><small>登录状态</small><b>{operationsCenter?.login?.loggedIn == null ? '-' : operationsCenter.login.loggedIn ? '已登录' : '未登录'}</b></div>
                    <div><small>Importer 版本</small><b>{operationsCenter?.machine?.importerVersion || detail.importerVersion || '-'}</b></div>
                  </div>
                  <div className="ow-center-task"><span>机器 ID：{operationsCenter?.machine?.machineId || detail.machineId || '-'}</span><span>Computer ID：{operationsCenter?.machine?.computerId || '-'}</span><span>Workflow：{operationsCenter?.machine?.workflow || 'hermes'} · 采集器：{operationsCenter?.machine?.collectorType || detail.collectorName || '-'}</span></div>
                </section>
                <nav className="ow-status-tabs" aria-label="状态分类">{[['overview','状态总览'],['collection','数据采集'],['quality','数据质量'],['processing','数据处理']].map(([key,label]) => <button key={key} className={detailTab === key ? 'active' : ''} onClick={() => setDetailTab(key as any)}>{label}</button>)}</nav>
                {detailTab === 'overview' && <div className="ow-detail-kpis"><div><small>当前登录</small><b>{operationsCenter?.login?.loggedIn ? '已登录 ✓' : operationsCenter?.login?.loggedIn === false ? '未登录' : '-'}</b></div><div><small>本工作日在线时长</small><b>{operationsCenter?.sessions?.attendedSeconds == null ? '-' : `${Math.round(operationsCenter.sessions.attendedSeconds / 60)} 分钟`}</b></div><div><small>Episode</small><b>{operationsCenter?.uploads?.episodeCount ?? '-'}</b></div><div><small>队列待处理</small><b>{operationsCenter?.processing?.queue?.pending ?? '-'}</b></div></div>}
                {detailTab === 'overview' && <div className="ow-detail-columns">
                  <section className="ow-info-panel"><h3>采集账户与任务（Importer）</h3><dl><div><dt>操作员</dt><dd>{operationsCenter?.task?.operator?.name || detail.task?.operator?.name || '未分配'}</dd></div><div><dt>操作员 ID</dt><dd className="mono">{operationsCenter?.task?.operator?.id || '-'}</dd></div><div><dt>等级</dt><dd>Level {operationsCenter?.task?.operator?.level ?? '-'}</dd></div><div><dt>当前任务</dt><dd>{operationsCenter?.task?.name || detail.task?.name || '暂无任务'}</dd></div><div><dt>任务状态</dt><dd>{operationsCenter?.task?.state || detail.task?.state || '-'}</dd></div><div><dt>任务 ID</dt><dd className="mono">{operationsCenter?.task?.id || detail.task?.id || '-'}</dd></div><div><dt>训练任务</dt><dd>{operationsCenter?.task?.training ? '是' : '否'}</dd></div><div><dt>登录状态</dt><dd>{operationsCenter?.login?.loggedIn == null ? '-' : operationsCenter.login.loggedIn ? '已登录' : '未登录'}</dd></div><div><dt>空闲时间</dt><dd>{formatSeconds(operationsCenter?.login?.idleTimeSecs)}</dd></div></dl></section>
                  <section className="ow-info-panel"><h3>设备资产与采集（GMS）</h3><dl><div><dt>机器类型</dt><dd>{machineTypeLabel(detail)}</dd></div><div><dt>机器 ID</dt><dd className="mono">{operationsCenter?.machine?.machineId || detail.machineId || '-'}</dd></div><div><dt>Computer ID</dt><dd className="mono">{operationsCenter?.machine?.computerId || '-'}</dd></div><div><dt>Workflow</dt><dd>{operationsCenter?.machine?.workflow || 'hermes'}</dd></div><div><dt>Importer 版本</dt><dd>{operationsCenter?.machine?.importerVersion || '-'}</dd></div><div><dt>采集器类型</dt><dd>{operationsCenter?.machine?.collectorType || detail.collectorName || '-'}</dd></div><div><dt>运行状态</dt><dd>{operationsCenter?.login?.activity || detail.system?.activity || '-'}</dd></div><div><dt>Collector</dt><dd>{(detail.collectorAlive ?? detail.system?.collectorAlive) == null ? '-' : (detail.collectorAlive ?? detail.system?.collectorAlive) ? '存活' : '停止'}</dd></div><div><dt>错误数</dt><dd>{detail.system?.errorCount ?? 0}</dd></div></dl></section>
                  <section className="ow-info-panel"><h3>工位运维（Galio）</h3>{operationsCenter?.stationOperations?.stationId ? <dl><div><dt>工位</dt><dd>{operationsCenter.stationOperations.code}</dd></div><div><dt>登记地址</dt><dd className="mono">{operationsCenter.stationOperations.host || '-'}</dd></div><div><dt>运维快照</dt><dd>{operationsCenter.stationOperations.snapshotStatus || '-'}</dd></div><div><dt>活动工单</dt><dd>{operationsCenter.stationOperations.activeTicketCount ?? 0}</dd></div><div><dt>24h 运维检查通过</dt><dd>{operationsCenter.stationOperations.checks24h?.pass ?? 0}</dd></div><div><dt>24h 运维检查失败</dt><dd>{operationsCenter.stationOperations.checks24h?.fail ?? 0}</dd></div><div><dt>快照更新时间</dt><dd>{formatTimestamp(operationsCenter.stationOperations.snapshotUpdatedAt)}</dd></div></dl> : <div className="ow-empty">Galio 未登记此工位</div>}</section>
                  <section className="ow-info-panel"><h3>Agent 性能</h3>{detail.performance ? <dl><div><dt>Agent 运行时长</dt><dd>{formatSeconds(detail.performance.agent?.uptimeSecs)}</dd></div><div><dt>内存 RSS</dt><dd>{formatBytes(detail.performance.agent?.memory?.rssBytes)}</dd></div><div><dt>事件循环延迟</dt><dd>{detail.performance.agent?.eventLoopLagMs == null ? '-' : `${detail.performance.agent.eventLoopLagMs} ms`}</dd></div><div><dt>心跳延迟</dt><dd>{detail.performance.heartbeat?.lastLatencyMs == null ? '-' : `${detail.performance.heartbeat.lastLatencyMs} ms`}</dd></div><div><dt>心跳成功率</dt><dd>{detail.performance.heartbeat?.attempts ? `${((detail.performance.heartbeat.successes / detail.performance.heartbeat.attempts) * 100).toFixed(1)}%` : '-'}</dd></div><div><dt>Importer 轮询延迟</dt><dd>{detail.performance.collectorPoll?.lastLatencyMs == null ? '-' : `${detail.performance.collectorPoll.lastLatencyMs} ms`}</dd></div></dl> : <div className="ow-empty">等待 Agent 1.3.7 上报性能指标</div>}</section>
                </div>}
                {detailTab === 'collection' && <div className="ow-detail-columns">
                  <section className="ow-info-panel"><h3>采集运行状态</h3><dl><div><dt>Collector</dt><dd>{(detail.collectorAlive ?? detail.system?.collectorAlive) == null ? '-' : (detail.collectorAlive ?? detail.system?.collectorAlive) ? '存活' : '停止'}</dd></div><div><dt>运行状态</dt><dd>{operationsCenter?.login?.activity || detail.system?.activity || '-'}</dd></div><div><dt>采集器类型</dt><dd>{operationsCenter?.machine?.collectorType || detail.collectorName || '-'}</dd></div><div><dt>空闲时间</dt><dd>{formatSeconds(operationsCenter?.login?.idleTimeSecs)}</dd></div></dl></section>
                  <section className="ow-info-panel"><h3>Worker 状态</h3>{Array.isArray(operationsCenter?.processing?.workers) && operationsCenter.processing.workers.length ? <div className="ow-table">{operationsCenter.processing.workers.map((worker: any, i: number) => <div className="ow-table-row" key={worker.id || worker.name || i}><span>{worker.name || worker.id || `Worker ${i + 1}`}</span><b className={Number(worker.busy) > 0 ? 'is-busy' : ''}>{Number(worker.busy) > 0 ? '忙碌' : '空闲'}</b><small>{worker.pending ?? worker.queue ?? 0} 待处理</small></div>)}</div> : <div className="ow-empty">暂无 Worker 数据</div>}</section>
                </div>}
                {detailTab === 'processing' && <div className="ow-detail-columns">
                  <section className="ow-info-panel"><h3>Worker 状态</h3>{Array.isArray(operationsCenter?.processing?.workers) && operationsCenter.processing.workers.length ? <div className="ow-table">{operationsCenter.processing.workers.map((worker: any, i: number) => <div className="ow-table-row" key={worker.id || worker.name || i}><span>{worker.name || worker.id || `Worker ${i + 1}`}</span><b className={Number(worker.busy) > 0 ? 'is-busy' : ''}>{Number(worker.busy) > 0 ? '忙碌' : '空闲'}</b><small>{worker.pending ?? worker.queue ?? 0} 待处理</small></div>)}</div> : <div className="ow-empty">暂无 Worker 数据</div>}</section>
                  <section className="ow-info-panel"><h3>处理队列</h3><div className="ow-queue-grid"><div><small>忙碌</small><b>{operationsCenter?.processing?.queue?.busy ?? '-'}</b></div><div><small>待处理</small><b>{operationsCenter?.processing?.queue?.pending ?? '-'}</b></div><div><small>可用容量</small><b>{operationsCenter?.processing?.queue?.available_capacity ?? '-'}</b></div><div><small>利用率</small><b>{operationsCenter?.processing?.queue?.utilization_percent == null ? '-' : `${operationsCenter.processing.queue.utilization_percent}%`}</b></div></div>{Array.isArray(operationsCenter?.processing?.workflows) && <div className="ow-sublist">{operationsCenter.processing.workflows.map((w: any, i: number) => <span key={w.name || i}>{w.name || w.workflow || 'workflow'}：{w.status || w.state || '-'}</span>)}</div>}</section>
                </div>}
                {detailTab === 'quality' && <div className="ow-detail-columns"><section className="ow-info-panel"><h3>数据质量</h3><div className="ow-queue-grid"><div><small>通过</small><b>{operationsCenter?.quality?.pass ?? '-'}</b></div><div><small>判废</small><b>{operationsCenter?.quality?.fail ?? '-'}</b></div><div><small>检查失败</small><b>{operationsCenter?.quality?.error ?? '-'}</b></div><div><small>质检通过率</small><b>{operationsCenter?.qualityPassRate == null ? '-' : `${(operationsCenter.qualityPassRate <= 1 ? operationsCenter.qualityPassRate * 100 : operationsCenter.qualityPassRate).toFixed(1)}%`}</b></div></div><p>上传 Episode：{operationsCenter?.uploads?.episodeCount ?? '-'}</p></section><section className="ow-info-panel"><h3>最近 MCAP 检查报告</h3>{operationsCenter?.latestMcapReport ? <div className="ow-table-row"><span>{operationsCenter.latestMcapReport.report_id || operationsCenter.latestMcapReport.id || '最新报告'}</span><b>{operationsCenter.latestMcapReport.status || operationsCenter.latestMcapReport.result || '-'}</b></div> : <div className="ow-empty">暂无报告</div>}{Array.isArray(operationsCenter?.recentMcapReports) && operationsCenter.recentMcapReports.slice(0, 5).map((r: any, i: number) => <div className="ow-table-row" key={r.report_id || r.id || i}><span>{formatTimestamp(r.created_at || r.timestamp)}</span><small>{r.status || r.result || '-'}</small></div>)}</section></div>}
                {detailTab === 'overview' && <section className="ow-info-panel ow-session-panel"><h3>本工作日会话与上传记录</h3><div className="ow-session-meta"><span>本工作日在线时长 <b>{operationsCenter?.sessions?.attendedSeconds == null ? '-' : `${Math.round(operationsCenter.sessions.attendedSeconds / 60)} 分钟`}</b></span><span>上传 Episode <b>{operationsCenter?.uploads?.episodeCount ?? '-'}</b></span><span>数据量 <b>{operationsCenter?.uploads?.sizeKnown ? `${(operationsCenter.uploads.sizeBytes / 1048576).toFixed(1)} MB` : '未知'}</b></span></div><div className="ow-session-list">{(operationsCenter?.sessions?.items || []).slice(0, 8).map((s: any, i: number) => <div key={s.id || i}><span>{formatTimestamp(s.started_at || s.start)}</span><b>{s.duration_seconds != null ? `${Math.round(s.duration_seconds / 60)} 分钟` : s.status || '-'}</b></div>)}</div></section>}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
