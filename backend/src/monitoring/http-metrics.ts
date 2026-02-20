import { httpRequestDuration, httpRequestsTotal } from './metrics'
import type { MiddlewareHandler } from 'hono'

function normalizeRoute(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id')
}

export function httpMetricsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path

    if (path === '/health' || path === '/metrics') {
      return next()
    }

    const start = performance.now()
    const method = c.req.method
    const normalizedRoute = normalizeRoute(path)

    try {
      await next()
    } catch (err) {
      const duration = (performance.now() - start) / 1000
      httpRequestDuration.observe(
        { method, route: normalizedRoute, status_code: '500' },
        duration
      )
      httpRequestsTotal.inc({
        method,
        route: normalizedRoute,
        status_code: '500'
      })
      throw err
    }

    const duration = (performance.now() - start) / 1000
    const statusCode = c.res.status.toString()

    httpRequestDuration.observe(
      { method, route: normalizedRoute, status_code: statusCode },
      duration
    )
    httpRequestsTotal.inc({
      method,
      route: normalizedRoute,
      status_code: statusCode
    })
  }
}
