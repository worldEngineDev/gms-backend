// 运维端主布局：侧边栏（分组导航 + 设备下拉）+ 顶栏 + 内容区
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Avatar, Badge, Button, Dropdown, Flex, Input, Layout, Menu, Select, Space, Tag, Tooltip, theme,
} from 'antd';
import {
  DashboardOutlined, DatabaseOutlined, BarChartOutlined, AuditOutlined, BarcodeOutlined,
  LinkOutlined, ToolOutlined, DesktopOutlined, ApiOutlined, HomeOutlined, SettingOutlined,
  UserOutlined, BellOutlined, MessageOutlined, HistoryOutlined, QuestionCircleOutlined,
  AppstoreOutlined, ReloadOutlined, MenuFoldOutlined, MenuUnfoldOutlined, LogoutOutlined,
  ShopOutlined, FileSearchOutlined, SafetyCertificateOutlined, SwapOutlined,
  MonitorOutlined,
} from '@ant-design/icons';
import { useAuthStore, isAdmin, isSuperAdmin } from '@common/stores/auth';
import { useUIStore } from '@common/stores/ui';
import { useInventoryConfig } from '@common/hooks/useData';
import { getNotifications, getServerLoad } from '@common/api';
import { ChatWidget } from '../modules/chat/ChatWidget';
import { GlobalSearch } from './GlobalSearch';
import { getCookie, setCookie } from '@common/utils/cookies';

const { Sider, Header, Content } = Layout;

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  const collapsed = useUIStore(s => s.sidebarCollapsed);
  const setCollapsed = useUIStore(s => s.setSidebarCollapsed);
  const toggleTheme = useUIStore(s => s.toggleTheme);
  const themeMode = useUIStore(s => s.theme);
  const { token } = theme.useToken();
  const inventoryConfig = useInventoryConfig();

  const [notifCount, setNotifCount] = useState(0);
  const [serverInfo, setServerInfo] = useState<string>('离线');
  const [clock, setClock] = useState('');
  const [healthOk, setHealthOk] = useState(true);

  // 时钟 + 服务器负载轮询（30s，与旧版一致）
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
    tick();
    const t1 = setInterval(tick, 1000);
    const loadStatus = async () => {
      try {
        const data = await getServerLoad();
        const icons: Record<string, string> = { idle: '空闲', smooth: '流畅', busy: '繁忙', full: '满载' };
        setServerInfo(`${icons[data.loadLevel] || data.loadLevel || ''} ${data.onlineUsers ?? 0}人`);
        setHealthOk(true);
      } catch {
        setServerInfo('离线');
        setHealthOk(false);
      }
    };
    loadStatus();
    const t2 = setInterval(loadStatus, 30000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []);

  // 未读通知数
  useEffect(() => {
    const refresh = () => setNotifCount(getNotifications().filter(n => !n.read).length);
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [location.pathname]);

  // 侧边栏设备下拉选项（默认三组 + 自定义库存类型）
  const deviceOptions = useMemo(() => {
    const defaults = [
      { value: 'glove', label: '手套库存' },
      { value: 'dexterous', label: '灵巧手' },
      { value: 'gripper', label: '夹爪' },
    ];
    const defaultIds = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];
    const custom: { value: string; label: string }[] = [];
    (inventoryConfig.data || []).forEach((c: any) => {
      if (defaultIds.includes(c.id)) return;
      if (c.hasLeftRight) {
        custom.push({ value: `${c.id}_left`, label: `${c.icon || ''} ${c.name}左手` });
        custom.push({ value: `${c.id}_right`, label: `${c.icon || ''} ${c.name}右手` });
      } else {
        custom.push({ value: c.id, label: `${c.icon || ''} ${c.name}` });
      }
    });
    return [...defaults, ...custom];
  }, [inventoryConfig.data]);

  // 当前选中菜单
  const selectedKey = useMemo(() => {
    const path = location.pathname;
    if (path.startsWith('/inventory/')) return '';
    return path.slice(1) || 'dashboard';
  }, [location.pathname]);

  const deviceValue = useMemo(() => {
    if (!location.pathname.startsWith('/inventory/')) return undefined;
    return location.pathname.replace('/inventory/', '');
  }, [location.pathname]);

  const admin = isAdmin(user);
  const superAdmin = isSuperAdmin(user);

  const menuItems: any[] = [
    {
      type: 'group', label: '概览',
      children: [{ key: 'dashboard', icon: <DashboardOutlined />, label: '系统总览' }],
    },
    {
      type: 'group', label: '设备资产',
      children: [
        { key: 'transactions', icon: <HistoryOutlined />, label: '流水记录' },
        { key: 'reports', icon: <BarChartOutlined />, label: '报表统计' },
        ...(admin ? [{ key: 'stocktake', icon: <AuditOutlined />, label: '库存盘点' }] : []),
        ...(admin ? [{ key: 'inventory-audit', icon: <FileSearchOutlined />, label: '库存审计' }] : []),
        ...(admin ? [{ key: 'batches', icon: <AppstoreOutlined />, label: '批次管理' }] : []),
        ...(admin ? [{ key: 'warehouse-transfers', icon: <SwapOutlined />, label: '仓库调拨' }] : []),
        { key: 'audit', icon: <AuditOutlined />, label: '审计日志' },
        { key: 'sn-codes', icon: <BarcodeOutlined />, label: 'SN码' },
        { key: 'sn-qr-codes', icon: <LinkOutlined />, label: 'SN码链接' },
        { key: 'after-sales', icon: <ToolOutlined />, label: '售后管理' },
      ],
    },
    {
      type: 'group', label: '现场运维',
      children: [
        { key: 'machines', icon: <DesktopOutlined />, label: '机器管理' },
        { key: 'machine-status', icon: <MonitorOutlined />, label: '机器状态' },
        { key: 'machine-links', icon: <ApiOutlined />, label: '机器链接' },
        { key: 'storage-locations', icon: <HomeOutlined />, label: '库位管理' },
        { key: 'tech-support', icon: <QuestionCircleOutlined />, label: '技术支持' },
      ],
    },
    {
      type: 'group', label: '系统',
      children: [
        ...(admin ? [
          { key: 'equipment-config', icon: <AppstoreOutlined />, label: '设备类型配置' },
          { key: 'inventory-config', icon: <DatabaseOutlined />, label: '库存类型配置' },
          { key: 'warehouses', icon: <ShopOutlined />, label: '仓库管理' },
          { key: 'users', icon: <UserOutlined />, label: '用户管理' },
        ] : []),
        ...(superAdmin ? [{ key: 'roles', icon: <SafetyCertificateOutlined />, label: '角色权限' }] : []),
        { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
        ...(admin ? [{ key: 'popup-messages', icon: <MessageOutlined />, label: '弹窗句子管理' }] : []),
      ],
    },
    {
      type: 'group', label: '个人中心',
      children: [
        { key: 'profile', icon: <UserOutlined />, label: '个人资料' },
        { key: 'notifications', icon: <BellOutlined />, label: '消息中心' },
        { key: 'my-activity', icon: <HistoryOutlined />, label: '我的操作' },
        { key: 'help', icon: <QuestionCircleOutlined />, label: '帮助中心' },
      ],
    },
  ];

  return (
    <Layout className="gms-shell" style={{ height: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="lg"
        collapsedWidth={0}
        onBreakpoint={setCollapsed}
        trigger={null}
        width={230}
        style={{ background: token.colorBgContainer, borderRight: `1px solid ${token.colorBorderSecondary}`, overflow: 'hidden' }}
      >
        <div
          style={{
            height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
            cursor: 'pointer', fontWeight: 700, fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <img src="/icons/logo-we.png" alt="logo" style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0 }} />
        </div>
        {!collapsed && (
          <div style={{ padding: '8px 12px' }}>
            <Flex gap={6}>
              <Select
                placeholder="-- 选择设备 --"
                style={{ flex: 1 }}
                size="small"
                allowClear
                value={deviceValue}
                options={deviceOptions}
                onChange={v => { if (v) navigate(`/inventory/${v}`); else navigate('/dashboard'); }}
              />
              {admin && (
                <Tooltip title="管理设备类型">
                  <Button size="small" onClick={() => navigate('/equipment-config')}>+</Button>
                </Tooltip>
              )}
            </Flex>
          </div>
        )}
        <Menu
          className="sidebar-scroll"
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          items={menuItems}
          onClick={({ key }) => navigate(`/${key}`)}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'transparent', borderInlineEnd: 'none' }}
        />
        <div style={{ padding: 12, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
          <Button block size="small" onClick={toggleTheme}>
            {themeMode === 'dark' ? '切换浅色模式' : '切换深色模式'}
          </Button>
        </div>
      </Sider>
      <Layout className="gms-shell-main">
        <Header className="gms-shell-header" style={{
          background: token.colorBgContainer, padding: '0 16px', height: 56,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}>
          <Space size={12}>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
            />
            <GlobalSearch />
          </Space>
          <Space size={12}>
            <Tooltip title="服务器连接状态">
              <span className="gms-shell-health-dot" style={{
                width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
                background: healthOk ? '#22c55e' : '#ef4444',
              }} />
            </Tooltip>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>刷新</Button>
            <Button size="small" onClick={() => navigate('/notifications')}>
              <Badge count={notifCount} size="small" offset={[6, -2]}>
                <BellOutlined style={{ fontSize: 16 }} />
              </Badge>
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'profile', icon: <UserOutlined />, label: '个人中心' },
                  { type: 'divider' },
                  { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
                ],
                onClick: ({ key }) => {
                  if (key === 'profile') navigate('/profile');
                  else if (key === 'logout') logout();
                },
              }}
              trigger={['click']}
            >
              <Space size={6} style={{ cursor: 'pointer' }}>
                <Avatar size={28} style={{ background: token.colorPrimary, color: token.colorBgContainer }}>
                  {(user?.username || 'U')[0]?.toUpperCase()}
                </Avatar>
                <span style={{ fontSize: 13 }}>{user?.username}</span>
              </Space>
            </Dropdown>
            <Tag className="gms-shell-server" color={healthOk ? 'green' : 'red'} style={{ margin: 0 }}>{serverInfo}</Tag>
            <span className="gms-shell-clock" style={{ fontSize: 12, opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
          </Space>
        </Header>
        <Content className="gms-shell-content" style={{ overflowY: 'auto', background: token.colorBgLayout }}>
          <Outlet />
        </Content>
      </Layout>
      <ChatWidget />
    </Layout>
  );
}

// 保存最后访问的 tab（与旧版 gms_last_tab cookie 行为一致）
export function rememberTab(path: string) {
  setCookie('gms_last_tab', path.replace(/^\//, ''), 7);
}
export function lastTab(): string | null {
  return getCookie('gms_last_tab');
}
