import { Layout, Typography } from 'antd'
import { Outlet } from 'react-router-dom'

const { Header, Content } = Layout

// 工位端不是传统意义的"菜单"——采集员在工位上更需要的是任务流（上机体检 → 开始采集）
// 和一个随时能点的报修入口，不是一堆分类菜单。见 docs/architecture.md「上机流程」。
// 布局只保留一个大标题和内容区，具体的 3 个入口（体检/报修/我的工单）在 Home 页用大按钮呈现。
export default function KioskLayout() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Galio 工位端
        </Typography.Title>
      </Header>
      <Content style={{ padding: 24, background: '#fafafa' }}>
        <Outlet />
      </Content>
    </Layout>
  )
}
