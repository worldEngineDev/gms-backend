import { useEffect, useState } from 'react'

import type { Role } from './menu'

// 真实认证方式还没定（见 docs/api-design.md 待定问题 A2），/auth/me 目前是后端占位的 501。
// 这里先用一个本地存储的"演示角色"驱动菜单的角色过滤，方便在没有登录态的情况下也能看到
// 不同角色的菜单长什么样；真正接入 /auth/me 之后，把这个 hook 换成读接口返回的角色即可，
// 菜单本身（menu.ts）不用改。
const STORAGE_KEY = 'galio_demo_role'
const DEFAULT_ROLE: Role = 'admin'

export function useRole(): [Role, (role: Role) => void] {
  const [role, setRole] = useState<Role>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as Role) || DEFAULT_ROLE
    } catch {
      return DEFAULT_ROLE
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, role)
    } catch {
      // 私密模式/禁用存储时静默忽略，不影响当前会话内的角色切换
    }
  }, [role])

  return [role, setRole]
}
