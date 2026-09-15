// 全局 Provider：QueryClient + AntD 主题（深浅色）+ 中文语言环境
import React, { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, theme as antTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { queryClient } from '../query';
import { useUIStore } from '../stores/ui';
import { GlobalOverlays } from './GlobalOverlays';

dayjs.locale('zh-cn');

// 统一桌面与移动端的 Worldengine 视觉语言；旧页面结构和业务行为保持不变。
const FONT_SANS = "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const FONT_MONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const theme = useUIStore(s => s.theme);
  const dark = theme === 'dark';
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
          token: {
            colorPrimary: dark ? '#8ec2e5' : '#153a5b',
            colorInfo: dark ? '#8ec2e5' : '#153a5b',
            colorTextBase: dark ? undefined : '#152238',
            colorBgLayout: dark ? undefined : '#f3f6f8',
            colorBgContainer: dark ? undefined : '#ffffff',
            colorBorder: dark ? undefined : '#dce5ec',
            colorBorderSecondary: dark ? undefined : '#edf1f4',
            colorError: '#c84f4a',
            colorSuccess: '#16866b',
            colorWarning: '#b7791f',
            borderRadius: 8,
            borderRadiusLG: 12,
            fontFamily: FONT_SANS,
            fontFamilyCode: FONT_MONO,
            controlHeight: 40,
          },
          components: {
            Card: { borderRadiusLG: 14, colorBorderSecondary: dark ? undefined : '#dce5ec' },
            Button: { fontWeight: 600, defaultBorderColor: dark ? undefined : '#cfdbe4', defaultColor: dark ? undefined : '#556579' },
            Input: { activeBorderColor: dark ? undefined : '#153a5b', hoverBorderColor: dark ? undefined : '#b9c8d6' },
            Select: { optionSelectedBg: dark ? undefined : '#f1f3f5' },
            Menu: {
              itemBorderRadius: 8,
              itemSelectedBg: dark ? undefined : '#e7f0f7',
              itemSelectedColor: dark ? undefined : '#153a5b',
              itemHoverBg: dark ? undefined : '#f1f5f8',
              itemColor: dark ? undefined : '#556579',
              groupTitleColor: dark ? undefined : '#8a98a9',
              groupTitleFontSize: 11,
            },
            Table: { headerBg: dark ? undefined : '#eef3f6', headerColor: dark ? undefined : '#64748b', borderColor: dark ? undefined : '#edf1f4' },
            Tag: { borderRadiusSM: 6 },
            Layout: { siderBg: dark ? undefined : '#ffffff', headerBg: dark ? undefined : '#ffffff', bodyBg: dark ? undefined : '#f3f6f8' },
          },
        }}
      >
        <AntApp message={{ duration: 5 }}>
          {children}
          <GlobalOverlays />
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
