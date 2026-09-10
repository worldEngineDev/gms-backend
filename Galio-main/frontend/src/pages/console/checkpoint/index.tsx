import { Tabs } from 'antd'

import CheckItems from './CheckItems'
import CheckSuites from './CheckSuites'

// 菜单里只有一个"检测集与检测项"入口（/console/checkpoint），两类字典放一个页面里用 Tab 切换，
// 不为了区分两张表另开一条菜单/路由。
export default function CheckpointDictionary() {
  return (
    <Tabs
      items={[
        { key: 'items', label: '检测项', children: <CheckItems /> },
        { key: 'suites', label: '检测集', children: <CheckSuites /> },
      ]}
    />
  )
}
