// 对接 docs/api-design.md 「2. 检测引擎」。字段名跟后端 SQLModel 保持一致（snake_case）。
import { apiFetch, type Paginated } from './client'

export interface CheckItem {
  id: string
  name: string
  device_type: string
  probe: string
  access_method: 'ssh' | 'http'
  params: Record<string, unknown>
  pass_criteria: Record<string, unknown>
  fault_type_id: string | null
  status: 'active' | 'disabled'
  created_at: string
  created_by: string
}

export interface CheckSuite {
  id: string
  name: string
  scenario: string
  device_type: string | null
  status: string
  created_at: string
  created_by: string
}

export interface CheckSuiteDetail {
  suite: CheckSuite
  items: { seq: number; item: CheckItem }[]
}

export interface CheckRun {
  id: string
  check_suite_id: string
  station_id: string
  trigger_reason: string
  conclusion: 'pass' | 'fail' | 'partial' | null
  started_at: string
  finished_at: string | null
  created_by: string
}

export interface CheckRunResult {
  id: string
  check_run_id: string
  check_item_id: string
  result: 'pass' | 'fail' | 'unknown'
  evidence: Record<string, unknown> | null
  suggestion: string | null
}

export interface CheckRunDetail {
  run: CheckRun
  results: CheckRunResult[]
}

export function listCheckItems(deviceType?: string) {
  const qs = new URLSearchParams({ page_size: '100', ...(deviceType ? { device_type: deviceType } : {}) })
  return apiFetch<Paginated<CheckItem>>(`/check-items?${qs}`)
}

export function createCheckItem(body: Record<string, unknown>) {
  return apiFetch<CheckItem>('/check-items', { method: 'POST', body: JSON.stringify(body) })
}

export function updateCheckItem(id: string, body: Record<string, unknown>) {
  return apiFetch<CheckItem>(`/check-items/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function deleteCheckItem(id: string) {
  return apiFetch<null>(`/check-items/${id}`, { method: 'DELETE' })
}

export function listCheckSuites(scenario?: string) {
  const qs = new URLSearchParams({ page_size: '100', ...(scenario ? { scenario } : {}) })
  return apiFetch<Paginated<CheckSuite>>(`/check-suites?${qs}`)
}

export function getCheckSuite(id: string) {
  return apiFetch<CheckSuiteDetail>(`/check-suites/${id}`)
}

export function createCheckSuite(body: Record<string, unknown>) {
  return apiFetch<CheckSuite>('/check-suites', { method: 'POST', body: JSON.stringify(body) })
}

export function updateCheckSuite(id: string, body: Record<string, unknown>) {
  return apiFetch<CheckSuite>(`/check-suites/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function deleteCheckSuite(id: string) {
  return apiFetch<null>(`/check-suites/${id}`, { method: 'DELETE' })
}

export function setCheckSuiteItems(id: string, checkItemIds: string[]) {
  return apiFetch<CheckSuiteDetail>(`/check-suites/${id}/items`, {
    method: 'PUT',
    body: JSON.stringify({ check_item_ids: checkItemIds }),
  })
}

export function listCheckRuns() {
  return apiFetch<Paginated<CheckRun>>('/check-runs?page_size=100')
}

export function getCheckRun(id: string) {
  return apiFetch<CheckRunDetail>(`/check-runs/${id}`)
}

export function triggerCheckRun(body: Record<string, unknown>) {
  return apiFetch<CheckRun>('/check-runs', { method: 'POST', body: JSON.stringify(body) })
}
