/**
 * 液态玻璃的开关与表面扫描。
 *
 * 打开时按 {@link LIQUID_GLASS_SELECTORS} 在文档与应用的 shadow root 里找毛玻璃表面，
 * 逐个接上折射滤镜；设置面板内的表面不参与。DOM 变动与路由切换后自动补扫。
 */

import type { GlassTreeScope } from './glassFilter'
import type { LiquidGlassTuning } from './surface'
import {
  attachLiquidGlassSurface,
  DEFAULT_LIQUID_GLASS_TUNING,
  detachAllLiquidGlassSurfaces,
  isLiquidGlassSupported,
  pruneLiquidGlassSurfaces,
  refreshAllLiquidGlassSurfaces,
  repaintAllLiquidGlassSurfaces,
} from './surface'

export type { LiquidGlassSurface, LiquidGlassTuning } from './surface'
export { DEFAULT_LIQUID_GLASS_TUNING, isLiquidGlassSupported, liquidGlassSurfaceCount } from './surface'

/** 应用 UI 的 shadow host id。 */
const BEWLY_HOST_ID = 'bewly'

/** 设置面板容器，其内部的表面不应用液态玻璃。 */
const SETTINGS_SELECTOR = '#settings-window'

/**
 * 毛玻璃表面的选择器。
 *
 * 前半段是应用自身组件（跑在 `#bewly` 的 shadow root 里），后半段是 B 站原站页面的适配
 * 规则（跑在文档里）。新增毛玻璃表面时把选择器补进来即可。
 */
export const LIQUID_GLASS_SELECTORS = [
  // 应用内
  '.search-bar input',
  '.bew-popover',
  '.bew-popover-surface',
  '.bew-segment-control--surface',
  '.dock-content-inner',
  '.back-to-top-or-refresh-btn',
  '.ctrl-btn',
  '.context-menu-container',
  '.Vue-Toastification__toast',
  '.dialog__panel',
  '.dialog__close',
  // B 站原站页面适配
  '.bili-header .slide-down',
  '.bili-header .mini-header',
  '.header-channel',
  '.search-input-container .search-fixed-header',
  '.watchlater-list-nav.fixed',
  '.history-record.fixed .main-breadcrums',
  '.fixed-top-header',
  '.fixed-author-header',
  '.nav-bar',
  '.space-left',
  '.space-right',
]

const SURFACE_SELECTOR = LIQUID_GLASS_SELECTORS.join(',')

let observer: MutationObserver | null = null
let pendingScan = 0
/**
 * 已经在用的表面按引用读取这个对象，所以调参是就地改而不是换对象——换对象只有新接上的
 * 表面能读到。
 */
const tuning: LiquidGlassTuning = { ...DEFAULT_LIQUID_GLASS_TUNING }
let enabled = false

/**
 * 扫描范围：文档 + `#bewly` 的 shadow root。
 *
 * 应用只在这两棵树里渲染表面。刷新提示（`refreshPrompt`）跑在自己的 shadow root 里，
 * 不在范围内。
 */
function collectScopes(): GlassTreeScope[] {
  const scopes: GlassTreeScope[] = [document]
  document.querySelectorAll<HTMLElement>(`#${BEWLY_HOST_ID}`).forEach((host) => {
    if (host.shadowRoot)
      scopes.push(host.shadowRoot)
  })
  return scopes
}

function scanScope(scope: GlassTreeScope): void {
  scope.querySelectorAll<HTMLElement>(SURFACE_SELECTOR).forEach((el) => {
    if (el.closest(SETTINGS_SELECTOR))
      return
    attachLiquidGlassSurface(el, tuning)
  })
}

function scan(): void {
  if (!enabled)
    return
  observeScopes()
  pruneLiquidGlassSurfaces()
  for (const scope of collectScopes())
    scanScope(scope)
}

/** DOM 变动与路由切换都走这里，一帧内只扫一次。 */
function scheduleScan(): void {
  if (!enabled || pendingScan)
    return
  pendingScan = requestAnimationFrame(() => {
    pendingScan = 0
    scan()
  })
}

/** 已被当前 observer 挂过的节点。重新启用时会整体重建，否则新 observer 会一个都挂不上。 */
let observed = new WeakSet<Node>()

/**
 * `#bewly` 可能晚于设置加载才出现，所以每次扫描都补挂一遍。同一个节点重复 observe 是幂等
 * 的，只是在替换观察参数。
 */
function observeScopes(): void {
  if (!observer)
    return
  for (const scope of collectScopes()) {
    const node = scope as Node
    if (observed.has(node))
      continue
    observed.add(node)
    observer.observe(node, { childList: true, subtree: true })
  }
}

function startObservers(): void {
  observer = new MutationObserver(scheduleScan)
  observeScopes()

  window.addEventListener('pushstate', scheduleScan)
  window.addEventListener('popstate', scheduleScan)
  window.addEventListener('hashchange', scheduleScan)
}

function stopObservers(): void {
  observer?.disconnect()
  observer = null
  observed = new WeakSet<Node>()
  window.removeEventListener('pushstate', scheduleScan)
  window.removeEventListener('popstate', scheduleScan)
  window.removeEventListener('hashchange', scheduleScan)

  if (pendingScan) {
    cancelAnimationFrame(pendingScan)
    pendingScan = 0
  }
}

/**
 * 打开或关闭液态玻璃。
 *
 * 非 Chromium 引擎不支持 `backdrop-filter: url()`，此时直接不接，元素保持原有毛玻璃。
 */
export function setLiquidGlassEnabled(next: boolean, nextTuning?: Partial<LiquidGlassTuning>): void {
  if (nextTuning)
    Object.assign(tuning, nextTuning)

  if (!next) {
    enabled = false
    stopObservers()
    detachAllLiquidGlassSurfaces()
    return
  }

  if (enabled)
    return

  if (!isLiquidGlassSupported()) {
    console.warn('[liquid-glass] 当前引擎不支持 `backdrop-filter: url()`，跳过液态玻璃')
    return
  }

  enabled = true
  startObservers()
  scan()
}

/**
 * 重新读取模糊值、重绘并补扫。模糊强度调节后调用。
 *
 * 内联的 `backdrop-filter` 会盖住样式表里的 `--bew-filter-glass-*`，所以强度变化不会自动
 * 流到这些表面，必须显式重读。
 */
export function refreshLiquidGlass(nextTuning?: Partial<LiquidGlassTuning>): void {
  if (!enabled)
    return

  if (nextTuning)
    Object.assign(tuning, nextTuning)

  refreshAllLiquidGlassSurfaces()
  scan()
}

/**
 * 只改折射强度并重绘。
 *
 * 位移图要按新的强度重算，但元素的模糊值没变，所以不重读也不补扫。
 */
export function setLiquidGlassRefraction(amount: number): void {
  if (!enabled)
    return

  tuning.refractionAmount = amount
  repaintAllLiquidGlassSurfaces()
}

export function isLiquidGlassEnabled(): boolean {
  return enabled
}
