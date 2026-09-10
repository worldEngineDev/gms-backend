import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'

import ConsoleLayout from './layouts/ConsoleLayout'
import KioskLayout from './layouts/KioskLayout'
import Dashboard from './pages/console/Dashboard'
import { PlaceholderPage } from './pages/console/PlaceholderPage'
import CheckpointDictionary from './pages/console/checkpoint'
import CheckRuns from './pages/console/checkpoint/CheckRuns'
import CheckIn from './pages/kiosk/CheckIn'
import KioskHome from './pages/kiosk/Home'
import MyTickets from './pages/kiosk/MyTickets'
import ReportIssue from './pages/kiosk/ReportIssue'
import { CONSOLE_MENU } from './nav/menu'

// 菜单路径 -> 已经实现的真实页面；没在这张表里的菜单项还是走 PlaceholderPage。
// 加一个新页面只要在这里注册一行，不用动 CONSOLE_MENU 或下面的路由生成逻辑。
const REAL_PAGES: Record<string, React.ComponentType> = {
  '/console/checkpoint': CheckpointDictionary,
  '/console/checkpoint/runs': CheckRuns,
}

// "一套代码两种形态"：console 和 kiosk 是同一构建产物里的两组路由，不是两个独立前端项目。
// 见 docs/project-structure.md「frontend/」。console 的子路由从 menu.ts 生成，
// 保证"菜单里有的项"和"路由能打开的页面"永远一一对应，不会出现点了菜单却 404。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/console" replace />} />

          <Route path="/console" element={<ConsoleLayout />}>
            <Route index element={<Dashboard />} />
            {CONSOLE_MENU.flatMap((group) => group.items)
              .filter((item) => item.path !== '/console')
              .map((item) => {
                const RealPage = REAL_PAGES[item.path]
                return (
                  <Route
                    key={item.path}
                    path={item.path.replace(/^\/console\//, '')}
                    element={
                      RealPage ? <RealPage /> : <PlaceholderPage title={item.label} apiModule={item.apiModule} />
                    }
                  />
                )
              })}
          </Route>

          <Route path="/kiosk" element={<KioskLayout />}>
            <Route index element={<KioskHome />} />
            <Route path="check-in" element={<CheckIn />} />
            <Route path="report" element={<ReportIssue />} />
            <Route path="my-tickets" element={<MyTickets />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>,
)
