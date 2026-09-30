/**
 * 把一个已有的毛玻璃元素接到折射滤镜上。
 *
 * 元素保留自己的背景与自己的模糊值，本模块只在其后追加 `url(#…)`，引用一张按元素几何
 * 生成的圆角矩形 SDF 位移图，让边缘附近的背景发生弯折。不含投影、高光、按压、形变。
 */

import type { GlassFilterHandle, RefractionSpec } from './glassFilter'
import { createGlassFilter, isRefractionSupported } from './glassFilter'

export interface LiquidGlassTuning {
  /** 从边缘向内多深开始弯折（px）。 */
  refractionHeight: number
  /** 边缘最大位移（px）。 */
  refractionAmount: number
  /** 把向心方向混进弯折梯度。 */
  depthEffect: boolean
  /** 三分支色散，代价是 3 张位移图 + 11 段滤镜图。 */
  chromaticAberration: boolean
  /** 超过这个像素面积就跳过：位移图按像素逐分支生成。 */
  maxArea: number
}

export const DEFAULT_LIQUID_GLASS_TUNING: LiquidGlassTuning = {
  refractionHeight: 18,
  refractionAmount: 22,
  depthEffect: true,
  chromaticAberration: false,
  maxArea: 700 * 700,
}

export interface LiquidGlassSurface {
  readonly el: HTMLElement
  /** 按当前几何重绘。 */
  paint: () => void
  /** 重新读取元素自身的毛玻璃值后再重绘；模糊强度变化后调用。 */
  refresh: () => void
  /** 还原为纯毛玻璃。 */
  detach: () => void
}

/** 1×1 透明 PNG（68 字节）：探测页面 CSP 是否放行 `data:` 位移图。 */
const PROBE_PNG
  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 本模块写上去的滤镜引用，重新读取元素自身模糊值时要先摘掉。 */
const FILTER_REFERENCE = /\s*url\(["']?#lg-refract-[^)]*\)/

/** 元素自身的 backdrop-filter 过渡收尾时触发的事件。 */
const BACKDROP_TRANSITION_EVENTS = ['transitioncancel', 'transitionend'] as const

const surfaces = new Map<HTMLElement, LiquidGlassSurface>()

/**
 * `null` = 尚未探测。位移图被 CSP 拒绝是静默失败——模糊照常、只有透镜消失，没有报错也没有
 * 事件，所以只能主动探一次。
 */
let mapSupport: boolean | null = null
let warnedFallback = false
/** 补扫会反复碰到同一个接不上的表面，告警只留第一条。 */
let warnedSkip = false

function warnFallbackOnce(message: string): void {
  if (warnedFallback)
    return
  warnedFallback = true
  console.warn(`[liquid-glass] ${message}`)
}

function warnOnce(message: string): void {
  if (warnedSkip)
    return
  warnedSkip = true
  console.warn(message)
}

function probeMapSupport(): Promise<boolean> {
  if (mapSupport !== null)
    return Promise.resolve(mapSupport)

  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve((mapSupport = true))
    image.onerror = () => resolve((mapSupport = false))
    image.src = PROBE_PNG
  })
}

/** 页面拒绝 `data:` 位移图时，已接上的表面全部退回纯毛玻璃。 */
function degradeAll(): void {
  for (const surface of [...surfaces.values()])
    surface.detach()
}

/**
 * 四角圆角半径（px）。百分比按对应轴向换算，取水平/垂直的均值。
 *
 * 上限是短边的一半：胶囊写法（`--bew-radius-full`）会解析成 `9999px`，直接交给 SDF 会让
 * 整个形状算到框外、中心点判成外侧。
 */
function readCornerRadii(el: HTMLElement, width: number, height: number): number[] {
  const style = getComputedStyle(el)
  const limit = Math.min(width, height) / 2
  const corners = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ]

  return corners.map((corner) => {
    const [horizontal = '0', vertical = horizontal] = corner.split(/\s+/)
    const h = horizontal.endsWith('%') ? (Number.parseFloat(horizontal) / 100) * width : Number.parseFloat(horizontal)
    const v = vertical.endsWith('%') ? (Number.parseFloat(vertical) / 100) * height : Number.parseFloat(vertical)
    const radius = (h + v) / 2
    return Number.isFinite(radius) ? Math.max(0, Math.min(radius, limit)) : 0
  })
}

/**
 * 元素自身的模糊值。
 *
 * 直接读 computed 拿到的可能是本模块写上去的 `… url(#…)`，所以先把内联样式换回接上前记录
 * 的原值（组件自己写过内联的，例如侧栏按钮，就是那句 `var()` 引用），读完再写回当前值。
 */
function readGlassBase(
  el: HTMLElement,
  restore: { backdropFilter: string, webkitBackdropFilter: string },
  current: string,
): string {
  if (restore.backdropFilter)
    el.style.setProperty('backdrop-filter', restore.backdropFilter)
  else
    el.style.removeProperty('backdrop-filter')

  if (restore.webkitBackdropFilter)
    el.style.setProperty('-webkit-backdrop-filter', restore.webkitBackdropFilter)
  else
    el.style.removeProperty('-webkit-backdrop-filter')

  const computed = getComputedStyle(el).backdropFilter
  const base = computed && computed !== 'none' ? computed.replace(FILTER_REFERENCE, '').trim() : ''

  if (current)
    el.style.setProperty('backdrop-filter', current)
  else
    el.style.removeProperty('backdrop-filter')

  return base
}

function writeBackdrop(el: HTMLElement, value: string): void {
  if (value) {
    el.style.setProperty('backdrop-filter', value)
    el.style.setProperty('-webkit-backdrop-filter', value)
  }
  else {
    el.style.removeProperty('backdrop-filter')
    el.style.removeProperty('-webkit-backdrop-filter')
  }
}

/**
 * 把 `el` 变成折射透镜。重复调用返回原句柄。
 *
 * @returns 引擎不支持、没有毛玻璃、太小、面积超限或位移图被 CSP 拒绝时为 `null`
 */
export function attachLiquidGlassSurface(
  el: HTMLElement,
  tuning: LiquidGlassTuning = DEFAULT_LIQUID_GLASS_TUNING,
): LiquidGlassSurface | null {
  const attached = surfaces.get(el)
  if (attached)
    return attached

  if (!isRefractionSupported())
    return null

  // 位移图被拒时元素已经是纯毛玻璃，提前退出，省掉下面几次样式重算。
  if (mapSupport === false) {
    warnFallbackOnce('页面 CSP 拒绝 `data:` 位移图，退回纯毛玻璃')
    return null
  }

  // 用 layout 尺寸而不是 getBoundingClientRect()：入场动画的 `transform: scale()` 会让后者
  // 返回缩放后的值，而位移图按元素自身坐标系生成，动画结束后 transform 变化又不触发
  // ResizeObserver，位移图会一直停在错误的尺寸上。
  const width = el.offsetWidth
  const height = el.offsetHeight
  if (width < 2 || height < 2)
    return null

  if (width * height > tuning.maxArea) {
    warnOnce(`[liquid-glass] ${width}x${height} 超过 maxArea=${tuning.maxArea}，跳过该表面`)
    return null
  }

  const restore = {
    backdropFilter: el.style.getPropertyValue('backdrop-filter'),
    webkitBackdropFilter: el.style.getPropertyValue('-webkit-backdrop-filter'),
  }

  let base = readGlassBase(el, restore, '')
  // 没有毛玻璃的表面（computed 为 `none`）不接折射。
  if (!base)
    return null

  if (mapSupport === null)
    probeMapSupport().then(ok => !ok && degradeAll())

  const filter: GlassFilterHandle = createGlassFilter(el.getRootNode() as Document | ShadowRoot)

  function spec(): RefractionSpec {
    // 与上面同理：位移图必须按 layout 尺寸生成，不能用被 transform 缩放过的 rect。
    const boxWidth = el.offsetWidth
    const boxHeight = el.offsetHeight
    return {
      width: boxWidth,
      height: boxHeight,
      cornerRadii: readCornerRadii(el, boxWidth, boxHeight),
      refractionHeight: tuning.refractionHeight,
      depthEffect: tuning.depthEffect,
      chromaticAberration: tuning.chromaticAberration,
    }
  }

  function paint(): void {
    const current = spec()
    if (current.width < 2 || current.height < 2)
      return

    filter.update(current, tuning.refractionAmount)
    // 裸 `url(#…)` 会被 Chromium 静默忽略，引用之前必须有一个固定的滤镜函数。
    writeBackdrop(el, `${base || 'blur(0px)'} url(#${filter.id})`)
    el.setAttribute('data-liquid-glass', 'on')
  }

  const observer = new ResizeObserver(() => paint())
  observer.observe(el)

  // 顶栏搜索框滑出/滑入时，外层样式会临时改写元素的 backdrop-filter，过渡进行中读到的是
  // 插值后的值，等过渡类名摘掉后再重读一次。
  const handleBackdropTransition = (event: TransitionEvent): void => {
    if (event.target !== el || event.propertyName !== 'backdrop-filter')
      return
    requestAnimationFrame(() => {
      if (surfaces.has(el))
        refresh()
    })
  }

  function refresh(): void {
    base = readGlassBase(el, restore, el.style.getPropertyValue('backdrop-filter'))
    if (!base)
      detach()
    else
      paint()
  }

  function detach(): void {
    observer.disconnect()
    for (const type of BACKDROP_TRANSITION_EVENTS)
      el.removeEventListener(type, handleBackdropTransition)
    filter.dispose()
    surfaces.delete(el)
    if (restore.backdropFilter)
      el.style.setProperty('backdrop-filter', restore.backdropFilter)
    else
      el.style.removeProperty('backdrop-filter')
    if (restore.webkitBackdropFilter)
      el.style.setProperty('-webkit-backdrop-filter', restore.webkitBackdropFilter)
    else
      el.style.removeProperty('-webkit-backdrop-filter')
    el.removeAttribute('data-liquid-glass')
  }

  for (const type of BACKDROP_TRANSITION_EVENTS)
    el.addEventListener(type, handleBackdropTransition)

  const surface: LiquidGlassSurface = { el, paint, refresh, detach }

  surfaces.set(el, surface)
  paint()
  return surface
}

export function isLiquidGlassSupported(): boolean {
  return isRefractionSupported()
}

/** 重新读取每个表面的模糊值并重绘。模糊强度变化后调用。 */
export function refreshAllLiquidGlassSurfaces(): void {
  for (const surface of [...surfaces.values()])
    surface.refresh()
}

/** 只重绘，不重读模糊值。折射强度变化后调用。 */
export function repaintAllLiquidGlassSurfaces(): void {
  for (const surface of [...surfaces.values()])
    surface.paint()
}

export function detachAllLiquidGlassSurfaces(): void {
  for (const surface of [...surfaces.values()])
    surface.detach()
}

/** 清掉已经从文档里移除的表面，避免长会话里越积越多。 */
export function pruneLiquidGlassSurfaces(): void {
  for (const [el, surface] of [...surfaces]) {
    if (!el.isConnected)
      surface.detach()
  }
}

export function liquidGlassSurfaceCount(): number {
  return surfaces.size
}
