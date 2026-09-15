// 登录页（移植自 app.js showLogin：账号下拉 + 错误提示 + 离线检测）
import { useEffect, useState } from 'react';
import { App as AntApp, AutoComplete, Button, ConfigProvider, Input, theme as antTheme } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuthStore } from '@common/stores/auth';
import { getLoginUsers } from '@common/api';

export function LoginScreen() {
  const login = useAuthStore(s => s.login);
  const online = useAuthStore(s => s.online);
  const { message } = AntApp.useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [userOptions, setUserOptions] = useState<{ value: string }[]>([]);

  useEffect(() => {
    getLoginUsers().then(users => setUserOptions(users.map(u => ({ value: u }))));
  }, []);

  const doLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    setError('');
    const result = await login(username.trim(), password.trim());
    setLoading(false);
    if (!result.success) {
      setError(result.message || '登录失败');
    } else if ((result.user?.system || 'maintenance') === 'operations') {
      window.location.replace('operations.html');
    } else {
      message.success('登录成功');
    }
  };

  return (
    // 登录页对齐 sn-status.html 的浅色风格，强制浅色算法避免深色模式下组件变色
    <ConfigProvider theme={{ algorithm: antTheme.defaultAlgorithm }}>
    <div className="gms-login" style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#f5f5f7', padding: 20,
    }}>
      {/* 对齐 status-pages 的 .sheet 风格 */}
      <div className="gms-login-panel" style={{
        width: '100%', maxWidth: 360, background: '#fff',
        border: '1px solid #e5e5e5', borderRadius: 12,
        boxShadow: '0 8px 32px rgba(0,0,0,0.08)', padding: 28,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img src="/icons/logo-we.png" alt="logo" style={{ width: 64, height: 64, borderRadius: 14, display: 'block', margin: '0 auto 14px' }} />
          <div style={{
            fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
            fontSize: 10, color: '#a1a1a1', textTransform: 'uppercase',
            letterSpacing: '0.14em', marginBottom: 4,
          }}>glove management system</div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.03em' }}>Worldengine</h1>
          {!online && <div style={{ color: '#be123c', fontSize: 12, marginTop: 8 }}>离线模式 — 检查网络连接后刷新页面重试</div>}
        </div>
        <AutoComplete
          options={userOptions}
          value={username}
          onChange={setUsername}
          style={{ width: '100%', marginBottom: 12 }}
        >
          <Input size="large" prefix={<UserOutlined style={{ color: '#a1a1a1' }} />} placeholder="请输入账号" autoComplete="username" />
        </AutoComplete>
        <Input.Password
          size="large"
          prefix={<LockOutlined style={{ color: '#a1a1a1' }} />}
          placeholder="请输入密码"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onPressEnter={doLogin}
          autoComplete="current-password"
          style={{ marginBottom: 12 }}
        />
        {error && (
          <div style={{ color: '#be123c', fontSize: 12, textAlign: 'center', minHeight: 20, marginBottom: 8, fontWeight: 500 }}>{error}</div>
        )}
        <Button type="primary" size="large" block loading={loading} onClick={doLogin} style={{ fontWeight: 600 }}>
          登 录
        </Button>
      </div>
    </div>
    </ConfigProvider>
  );
}
