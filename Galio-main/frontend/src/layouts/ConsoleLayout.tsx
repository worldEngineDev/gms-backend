import { useMemo } from 'react'
import { Layout, Menu, Select, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

import { CONSOLE_MENU, ROLE_LABELS, type Role } from '../nav/menu'
import { useRole } from '../nav/useRole'

const { Sider, Header, Content } = Layout
const ALL_ROLES = Object.keys(ROLE_LABELS) as Role[]

export default function ConsoleLayout() {
  const [role, setRole] = useRole()
  const location = useLocation()
  const navigate = useNavigate()

  // 菜单项直接从 nav/menu.ts 生成并按当前角色过滤，保证"菜单里有的项"和路由能打开的页面
  // 不会脱节，见 docs/project-structure.md「frontend/」。
  const items: MenuProps['items'] = useMemo(
    () =>
      CONSOLE_MENU.map((group) => {
        const children = group.items.filter((item) => item.roles.includes(role))
        if (children.length === 0) return null
        return {
          key: group.label,
          type: 'group' as const,
          label: group.label,
          children: children.map((item) => ({ key: item.path, label: item.label })),
        }
      }).filter((group): group is NonNullable<typeof group> => group !== null),
    [role],
  )

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={220} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ fontWeight: 700, fontSize: 18, padding: 16 }}>Galio</div>
        <Menu mode="inline" selectedKeys={[location.pathname]} items={items} onClick={({ key }) => navigate(key)} />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
            padding: '0 24px',
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            演示角色（真实登录见 docs/api-design.md 待定问题 A2）：
          </Typography.Text>
          <Select<Role>
            size="small"
            value={role}
            style={{ width: 120 }}
            onChange={setRole}
            options={ALL_ROLES.filter((r) => r !== 'collector').map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
