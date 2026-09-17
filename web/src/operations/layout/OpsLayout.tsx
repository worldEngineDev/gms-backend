// 运营端布局（移植 operations.html 侧边栏 + topbar）：
// 分组折叠侧边栏 + 用户信息 + 全局搜索；顶栏健康点/状态/时钟/系统切换/改密/退出
// 权限：普通用户（role=user）仅可访问个人分析与提交技术支持（同旧版 renderCurrentTab）
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp, Avatar, Button, Collapse, Dropdown, Flex, Form, Input, Layout, Modal, Space, Tag, Tooltip, theme as antTheme,
} from 'antd';
import {
  KeyOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoonOutlined, ReloadOutlined, SearchOutlined, SunOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore, isOperationsAdmin, isSuperAdmin } from '@common/stores/auth';
import { useUIStore } from '@common/stores/ui';
import * as api from '@common/api';

const { Sider, Header, Content } = Layout;

interface NavItem { key: string; icon: string; label: string; adminOnly?: boolean }
interface NavGroup { key: string; icon: string; label: string; adminOnly?: boolean; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    key: 'overview', icon: '总', label: '总览',
    items: [
      { key: '/', icon: 'P', label: '机器状态中心', adminOnly: true },
      { key: '/tasks', icon: 'T', label: '任务列表' },
      { key: '/analysis', icon: 'D', label: '数据分析' },
    ],
  },
  {
    key: 'group', icon: '组', label: '分组',
    items: [
      { key: '/team', icon: 'G', label: '组员' },
      { key: '/task-progress', icon: 'S', label: '任务进度' },
      { key: '/requirements', icon: 'R', label: '需求' },
    ],
  },
  {
    key: 'usermgmt', icon: '用', label: '用户管理', adminOnly: true,
    items: [
      { key: '/users', icon: 'U', label: '账户管理' },
      { key: '/popup-messages', icon: 'M', label: '弹窗句子管理' },
    ],
  },
  {
    key: 'support', icon: '技', label: '技术支持',
    items: [
      { key: '/tech-support/submit', icon: 'S', label: '提交请求' },
      { key: '/tech-support/my', icon: 'L', label: '维修日志', adminOnly: true },
      { key: '/machine-status', icon: 'M', label: '机器状态', adminOnly: true },
    ],
  },
  {
    key: 'sopnav', icon: 'S', label: 'SOP 文档',
    items: [{ key: '/sop', icon: 'S', label: 'SOP 文档' }],
  },
];

const TITLE_MAP: Record<string, string> = {
  '/': '机器状态中心',
  '/tasks': '任务列表',
  '/analysis': '数据分析',
  '/team': '组员',
  '/task-progress': '任务进度',
  '/requirements': '需求',
  '/tech-support/submit': '提交技术支持请求',
  '/tech-support/my': '我的技术支持请求',
  '/machine-status': '机器状态',
  '/users': '账户管理',
  '/popup-messages': '弹窗句子管理',
  '/sop': 'SOP 文档',
};

// 普通用户可访问路径（其余显示"正在装修"，同旧版）
const USER_ALLOWED = ['/', '/tech-support/submit'];

const ROLE_LABEL: Record<string, string> = { superadmin: '超级管理员', admin: '管理员' };

export function OpsLayout() {
  const user = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  const { message } = AntApp.useApp();
  const { token } = antTheme.useToken();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useUIStore(s => s.theme);
  const toggleTheme = useUIStore(s => s.toggleTheme);
  const collapsed = useUIStore(s => s.sidebarCollapsed);
  const setCollapsed = useUIStore(s => s.setSidebarCollapsed);

  const [search, setSearch] = useState('');
  const [navKeys, setNavKeys] = useState<string[]>(NAV_GROUPS.map(g => g.key));
  const [clock, setClock] = useState('--');
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdForm] = Form.useForm();
  const [pwdLoading, setPwdLoading] = useState(false);

  // 健康状态 / 负载（15s 轮询，对应旧版 startHealthCheck + initStatusBar）
  const statusQuery = useQuery({
    queryKey: ['ops-server-load'],
    queryFn: () => api.getServerLoad(),
    refetchInterval: 15000,
    retry: 0,
  });
  const online = statusQuery.isSuccess;
  const status = statusQuery.data as any;

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const isLeader = isOperationsAdmin(user);
  const isPlainUser = user?.role === 'user';
  const isMachineStatusCenter = location.pathname === '/' || location.pathname === '/machine-status';

  useEffect(() => {
    if (user && isMachineStatusCenter && !isLeader) {
      navigate('/tech-support/submit', { replace: true });
    }
  }, [user, isMachineStatusCenter, isLeader, navigate]);

  // 可见分组与全局搜索过滤
  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return NAV_GROUPS
      .filter(g => !g.adminOnly || isLeader)
      .map(g => ({
        ...g,
        items: g.items
          .filter(it => !it.adminOnly || isLeader)
          .filter(it => !q || it.label.toLowerCase().includes(q)),
      }))
      .filter(g => g.items.length > 0);
  }, [search, isLeader]);

  const activeKeys = search.trim() ? visibleGroups.map(g => g.key) : navKeys;

  const doLogout = () => {
    logout();
  };

  const switchToMaintenance = () => {
    sessionStorage.setItem('gms_fast_switch', '1');
    window.location.href = 'index.html';
  };

  const changePwd = async () => {
    const v = await pwdForm.validateFields().catch(() => null);
    if (!v) return;
    if (v.newPassword !== v.confirm) { message.warning('两次新密码输入不一致'); return; }
    if (v.newPassword.length < 4) { message.warning('新密码至少4个字符'); return; }
    setPwdLoading(true);
    try {
      await api.changePassword(v.oldPassword, v.newPassword);
      message.success('密码修改成功');
      setPwdOpen(false);
      pwdForm.resetFields();
    } catch (e: any) {
      message.error(e?.message || '修改失败');
    }
    setPwdLoading(false);
  };

  const pageAllowed = (!isMachineStatusCenter || isLeader)
    && (!isPlainUser || USER_ALLOWED.includes(location.pathname));
  const isOverwatchHome = location.pathname === '/';

  return (
    <Layout className={`gms-shell${isOverwatchHome ? ' ops-overwatch-shell' : ''}`} style={{ minHeight: '100vh' }}>
      {!isOverwatchHome && (
      <Sider
        theme={theme === 'dark' ? 'dark' : 'light'}
        collapsed={collapsed}
        width={240}
        collapsedWidth={0}
        breakpoint="lg"
        onBreakpoint={setCollapsed}
        style={{ borderRight: '1px solid rgba(128,128,128,.12)', overflow: 'hidden' }}
      >
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* 全局搜索 */}
        <div style={{ padding: '12px 12px 4px' }}>
          <Input
            prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
            placeholder="搜索..."
            size="small"
            allowClear
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* 用户信息 */}
        <Flex gap={10} align="center" style={{ padding: '12px 16px' }}>
          <Avatar style={{ background: theme === 'dark' ? '#fafafa' : '#0a0a0a', color: theme === 'dark' ? '#0a0a0a' : '#fff', flexShrink: 0 }}>
            {(user?.username || '?')[0].toUpperCase()}
          </Avatar>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.username || '--'}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>{ROLE_LABEL[user?.role || ''] || '普通用户'}</div>
          </div>
        </Flex>

        {/* 分组折叠导航（独立滚动区） */}
        <div className="sidebar-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Collapse
          ghost
          activeKey={activeKeys}
          onChange={ks => setNavKeys(ks as string[])}
          items={visibleGroups.map(g => ({
            key: g.key,
            label: (
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                <span style={{
                  display: 'inline-flex', width: 20, height: 20, borderRadius: 5, marginRight: 8,
                  alignItems: 'center', justifyContent: 'center', fontSize: 11,
                  background: theme === 'dark' ? 'rgba(255,255,255,.12)' : 'rgba(10,10,10,.06)',
                }}>{g.icon}</span>
                {g.label}
              </span>
            ),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {g.items.map(it => {
                  const active = location.pathname === it.key;
                  return (
                    <Button
                      key={it.key}
                      type="text"
                      size="small"
                      onClick={() => navigate(it.key)}
                      style={{
                        textAlign: 'left', height: 34, borderRadius: 8,
                        background: active ? (theme === 'dark' ? 'rgba(255,255,255,.1)' : '#f1f3f5') : undefined,
                        color: active ? (theme === 'dark' ? '#fafafa' : '#0a0a0a') : undefined,
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      <span style={{
                        display: 'inline-flex', width: 18, height: 18, borderRadius: 4, marginRight: 8,
                        alignItems: 'center', justifyContent: 'center', fontSize: 10,
                        background: active ? (theme === 'dark' ? 'rgba(255,255,255,.18)' : '#e5e5e5') : 'rgba(128,128,128,.12)',
                      }}>{it.icon}</span>
                      {it.label}
                    </Button>
                  );
                })}
              </div>
            ),
          }))}
        />
        </div>

        {/* 主题切换 */}
        <div style={{ padding: '12px 16px', marginTop: 'auto' }}>
          <Button block icon={theme === 'dark' ? <SunOutlined /> : <MoonOutlined />} onClick={toggleTheme}>
            切换主题
          </Button>
        </div>
        </div>
      </Sider>
      )}

      <Layout className="gms-shell-main">
        {!isOverwatchHome && (
        <Header className="gms-shell-header" style={{
          background: token.colorBgContainer, padding: '0 16px', height: 56,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}>
          <Flex align="center" gap={10}>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
            />
            <strong style={{ fontSize: 15 }}>{TITLE_MAP[location.pathname] || '运营系统'}</strong>
          </Flex>
          <Flex align="center" gap={10}>
            <Tooltip title={online ? '服务器已连接' : '服务器未连接'}>
              <span className="gms-shell-health-dot" style={{
                width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
                background: online ? '#22c55e' : '#ef4444',
              }} />
            </Tooltip>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>刷新</Button>
            {isSuperAdmin(user) && (
              <Button size="small" onClick={switchToMaintenance}>🔧 运维</Button>
            )}
            <Dropdown
              menu={{
                items: [
                  { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
                ],
                onClick: ({ key }) => { if (key === 'logout') doLogout(); },
              }}
              trigger={['click']}
            >
              <Space size={6} style={{ cursor: 'pointer' }}>
                <Avatar size={28} style={{ background: theme === 'dark' ? '#fafafa' : '#0a0a0a', color: theme === 'dark' ? '#0a0a0a' : '#fff' }}>
                  {(user?.username || '?')[0].toUpperCase()}
                </Avatar>
                <span style={{ fontSize: 13 }}>{user?.displayName || user?.username || '--'}</span>
              </Space>
            </Dropdown>
            <Tag className="gms-shell-server" color={online ? 'green' : 'red'} style={{ margin: 0 }}>
              {online ? `${{ idle: '空闲', smooth: '流畅', busy: '繁忙', full: '满载' }[status?.loadLevel as string] || ''} ${status?.onlineUsers ?? 0}人` : '离线'}
            </Tag>
            <span className="gms-shell-clock" style={{ fontSize: 12, opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
            <Tooltip title="修改密码">
              <Button type="text" size="small" icon={<KeyOutlined />} onClick={() => setPwdOpen(true)} />
            </Tooltip>
          </Flex>
        </Header>
        )}

        <Content className="gms-shell-content" style={{ overflow: isOverwatchHome ? 'hidden' : 'auto' }}>
          {pageAllowed ? (
            <Outlet />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 56, marginBottom: 20 }}>🚧</div>
                <p style={{ fontSize: 18, opacity: 0.6, fontWeight: 500 }}>该页面正在装修，请耐心等待</p>
              </div>
            </div>
          )}
        </Content>
      </Layout>

      {/* 修改密码 */}
      <Modal
        title="修改密码"
        open={pwdOpen}
        onCancel={() => setPwdOpen(false)}
        onOk={changePwd}
        confirmLoading={pwdLoading}
        destroyOnClose
      >
        <Form form={pwdForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password placeholder="输入当前密码" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }]}>
            <Input.Password placeholder="输入新密码(不少于4个字符)" />
          </Form.Item>
          <Form.Item name="confirm" label="确认新密码" rules={[{ required: true, message: '请再次输入新密码' }]}>
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
