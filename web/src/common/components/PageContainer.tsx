// 页面容器：统一页头（标题/副标题/操作区）
import React from 'react';
import { Flex, Typography } from 'antd';

const { Title, Text } = Typography;

interface Props {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
}

export function PageContainer({ title, subtitle, extra, children }: Props) {
  return (
    <div className="gms-page">
      <Flex className="gms-page-head" justify="space-between" align="center" style={{ marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>{title}</Title>
          {subtitle && <Text type="secondary" style={{ fontSize: 13 }}>{subtitle}</Text>}
        </div>
        {extra && <Flex className="gms-page-actions" gap={8}>{extra}</Flex>}
      </Flex>
      <section className="gms-page-body">{children}</section>
    </div>
  );
}
