import { Result } from 'antd'

// 大部分菜单目标页面还没有实现具体的数据视图（列表/表单），先用统一的占位页面把导航跑通，
// 每个页面标注对应哪个后端接口模块，后续实现时按图索骥，不需要重新设计导航结构。
export function PlaceholderPage({ title, apiModule }: { title: string; apiModule: string }) {
  return (
    <Result
      status="info"
      title={title}
      subTitle={`页面待实现，对应接口模块「${apiModule}」，见 docs/api-design.md。`}
    />
  )
}
