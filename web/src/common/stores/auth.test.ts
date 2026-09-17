// 权限判断单测（运维/运营端菜单显隐依赖）
import { describe, expect, it } from 'vitest';
import { isAdmin, isOperationsAdmin, isSuperAdmin } from './auth';

const mk = (role: string, system = 'maintenance') => ({ id: 1, username: 't', role, system }) as any;

describe('isAdmin / isSuperAdmin', () => {
  it('admin 与 superadmin 均为管理员', () => {
    expect(isAdmin(mk('admin'))).toBe(true);
    expect(isAdmin(mk('superadmin'))).toBe(true);
    expect(isAdmin(mk('user'))).toBe(false);
  });
  it('仅 superadmin 命中 isSuperAdmin', () => {
    expect(isSuperAdmin(mk('superadmin'))).toBe(true);
    expect(isSuperAdmin(mk('admin'))).toBe(false);
  });
  it('空用户返回 false', () => {
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
    expect(isSuperAdmin(null)).toBe(false);
  });
  it('运营系统管理员同样是 admin', () => {
    expect(isAdmin(mk('admin', 'operations'))).toBe(true);
  });
  it('机器状态中心只允许运营管理员或超级管理员', () => {
    expect(isOperationsAdmin(mk('admin', 'operations'))).toBe(true);
    expect(isOperationsAdmin(mk('user', 'operations'))).toBe(false);
    expect(isOperationsAdmin(mk('admin', 'maintenance'))).toBe(false);
    expect(isOperationsAdmin(mk('superadmin', 'maintenance'))).toBe(true);
  });
});
