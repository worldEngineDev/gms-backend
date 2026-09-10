// 对接 docs/api-design.md 的统一响应信封 {code, message, request_id, data}。
export interface Envelope<T> {
  code: number
  message: string
  request_id: string
  data: T
}

export interface Paginated<T> {
  items: T[]
  page: number
  page_size: number
  total: number
}

const BASE_URL = '/api'

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  const body = (await response.json()) as Envelope<T>
  if (body.code !== 0) {
    throw new Error(`${body.code}: ${body.message}`)
  }
  return body.data
}
