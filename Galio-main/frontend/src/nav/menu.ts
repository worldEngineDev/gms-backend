// Web 控制台的菜单结构，按角色过滤。对照 person.primary_role（见 docs/database-schema.md）
// 和 docs/api-design.md 的 9 个接口模块——每个菜单项都能说清楚自己对应哪个模块，
// 不为"以后可能要加的功能"预留空菜单项。
// 只有这四种角色，没有"区域负责人"/"技术支持"这两个独立角色——`zone_owner` 是 person 与 zone
// 的绑定表（谁对某区域负责），不是角色；系统配置类权限（检测字典/发布/告警规则）没有
// 专职技术角色可以分，先收拢给管理员，见 docs/database-schema.md 设计评审「取舍 4」。
export type Role = 'collector' | 'operator' | 'team_lead' | 'admin'

// 采集员（collector）不用控制台，走工位端（kiosk），所以下面每一项的 roles 都不包含它。
const OPS_ROLES: Role[] = ['operator', 'team_lead', 'admin']
const MANAGE_ROLES: Role[] = ['team_lead', 'admin']
const ADMIN_ONLY: Role[] = ['admin']

export interface MenuItem {
  label: string
  path: string
  roles: Role[]
  apiModule: string // 对应 docs/api-design.md 的模块名，方便核对菜单和接口是否一一对应
}

export interface MenuGroup {
  label: string
  items: MenuItem[]
}

export const CONSOLE_MENU: MenuGroup[] = [
  {
    label: '总览',
    items: [
      { label: '状态大盘', path: '/console', roles: OPS_ROLES, apiModule: '人员与组织资产 + 监控与告警' },
    ],
  },
  {
    label: '资产',
    items: [
      { label: '工位与设备', path: '/console/stations', roles: OPS_ROLES, apiModule: '人员与组织资产' },
      { label: '站点与区域', path: '/console/zones', roles: MANAGE_ROLES, apiModule: '人员与组织资产' },
    ],
  },
  {
    label: '工单',
    items: [{ label: '工单列表', path: '/console/tickets', roles: OPS_ROLES, apiModule: '工单调度' }],
  },
  {
    label: '检测',
    items: [
      { label: '检测集与检测项', path: '/console/checkpoint', roles: ADMIN_ONLY, apiModule: '检测引擎' },
      { label: '执行记录', path: '/console/checkpoint/runs', roles: OPS_ROLES, apiModule: '检测引擎' },
    ],
  },
  {
    label: '发布',
    items: [
      { label: '发布列表', path: '/console/releases', roles: ADMIN_ONLY, apiModule: '发布与配置' },
      { label: '配置模板', path: '/console/releases/config-templates', roles: ADMIN_ONLY, apiModule: '发布与配置' },
      { label: '版本对账', path: '/console/releases/version-drift', roles: ADMIN_ONLY, apiModule: '发布与配置' },
      { label: '发布冻结', path: '/console/releases/freezes', roles: ADMIN_ONLY, apiModule: '发布与配置' },
    ],
  },
  {
    label: '监控告警',
    items: [
      { label: '告警规则', path: '/console/alerts/rules', roles: ADMIN_ONLY, apiModule: '监控与告警' },
      { label: '告警事件', path: '/console/alerts/events', roles: OPS_ROLES, apiModule: '监控与告警' },
    ],
  },
  {
    label: '采集业务',
    items: [
      { label: '采集任务', path: '/console/collection/tasks', roles: OPS_ROLES, apiModule: '采集业务与班次交接' },
      { label: '班次交接', path: '/console/collection/handovers', roles: OPS_ROLES, apiModule: '采集业务与班次交接' },
    ],
  },
  {
    label: '组织',
    items: [{ label: '人员', path: '/console/people', roles: MANAGE_ROLES, apiModule: '人员与组织资产' }],
  },
  {
    label: '系统',
    items: [
      { label: '通知', path: '/console/notifications', roles: OPS_ROLES, apiModule: '通知与审计' },
      { label: '审计日志', path: '/console/audit', roles: ['admin'], apiModule: '通知与审计' },
    ],
  },
]

export const ROLE_LABELS: Record<Role, string> = {
  collector: '采集员',
  operator: '运维',
  team_lead: '采集组长',
  admin: '管理员',
}
