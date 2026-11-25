/**
 * `dsh-dshai-budget` 插件入口。
 *
 * 只提供一个内部服务 `budget`，不注册任何工具：
 * Step 3 不扩展现有 22 个业务工具契约，用户配置入口留给 Step 4 的 UI。
 *
 * 启动时把超过 TTL 仍未结算的预留标记为 uncertain（继续占用额度），
 * 不因进程重启把未知消耗归零。
 */

import { createStorage } from './storage.js'
import { PUBLIC_METHODS, createBudgetService } from './service.js'
import { registerBudgetDashboard } from './dashboard.js'

export const name = 'dsh-dshai-budget'

/** 不注册工具，也不强依赖其他插件。 */
export const inject = []

export function apply(ctx, config) {
  // 宿主 LoggerService 的方法依赖 this，不能解构后裸调用。
  const hostLogger = ctx.logger
  const call = (level, method) => {
    if (hostLogger && typeof hostLogger[method] === 'function') {
      hostLogger[method](...level)
      return
    }
    console[method](...level)
  }
  const logger = {
    debug: (...args) => call(args, 'debug'),
    info: (...args) => call(args, 'info'),
    warn: (...args) => call(args, 'warn'),
    error: (...args) => call(args, 'error'),
  }
  const storage = createStorage({
    home: typeof config?.home === 'string' ? config.home : undefined,
    log: logger,
  })
  const trust = Symbol('dsh-dshai-budget:trusted-user')
  const budget = createBudgetService({ storage, log: logger, trust })

  const allowed = new Set(['name', 'version', ...PUBLIC_METHODS])
  for (const key of Object.keys(budget)) {
    if (!allowed.has(key)) {
      throw new Error(`预算服务成员未登记：${key}；请同步更新 PUBLIC_METHODS 与形状守卫`)
    }
  }

  ctx.provide('budget', budget)
  ctx.effect(() => {
    void budget.recover().catch((error) => logger.warn('[budget] 启动恢复失败', error))
    return () => {}
  }, 'dsh-dshai-budget: startup recovery')

  logger.info?.('[budget] ready (只提供内部服务 budget，不注册工具)')

  // 独立预算面板：只依赖本插件服务；没有 webServer 时静默跳过。
  ctx.effect(() => {
    let dispose = null
    let timer = null
    let stopped = false
    const tryRegister = () => {
      if (stopped || dispose) return
      const web = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (!web) return
      dispose = registerBudgetDashboard(ctx, { getBudget: () => budget, getStorage: () => storage, trust, log: logger })
    }
    tryRegister()
    if (!dispose) {
      let attempts = 0
      timer = setInterval(() => {
        attempts += 1
        tryRegister()
        if (dispose || attempts >= 40) { clearInterval(timer); timer = null }
      }, 250)
      timer.unref?.()
    }
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      dispose?.()
    }
  }, 'dsh-dshai-budget: dashboard')
}
