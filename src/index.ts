/**
 * koishi-plugin-bns-fortune
 * 剑灵风格每日好运签 —— Canvas 绘制，每日一签，文字可变
 */
import { Context, Schema, Logger, h } from 'koishi'
import { resolve } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { FORTUNES, Fortune } from './fortunes'
import { drawFortune, formatDate } from './fortune'
import { FortuneRenderer, THEMES, Theme } from './render'

const logger = new Logger('bns-fortune')

export interface Config {
  /** 随机密钥：改它会重洗全局结果 */
  masterKey: string
  /** 自定义背景图路径/URL（为空则用代码绘制模板） */
  customBackground: string
  /** 字体族名（需已注册或系统自带） */
  fontFamily: string
  /** 配色主题 */
  theme: 'ink' | 'gold-red'
  /** 字体目录（插件会尝试自动注册其中的 ttf/otf） */
  fontsDir: string
  /** 自定义签文库（覆盖内置） */
  results: Fortune[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    masterKey: Schema.string()
      .description('随机密钥。修改后所有用户的签会被重新打乱。')
      .default('bns-fortune-2024'),
    theme: Schema.union([
      Schema.const('ink').description('剑灵·水墨（墨黑朱砂赤金）'),
      Schema.const('gold-red').description('传统·朱金'),
    ]).description('配色主题。').default('ink'),
    fontFamily: Schema.string()
      .description('签图正文字体族名。需为系统字体或已注册字体，否则回退楷体。')
      .default(''),
    fontsDir: Schema.path({
      filters: ['directory'],
      allowCreate: true,
    }).description('字体目录。插件启动时会把其中的 ttf/otf 自动注册，便于中文字体渲染。留空则不注册。')
      .default(''),
    customBackground: Schema.string()
      .description('自定义背景图。可填本地图片绝对路径或 http(s) URL。留空则使用代码绘制的剑灵水墨模板。')
      .default(''),
    results: Schema.array(
      Schema.object({
        level: Schema.union([
          Schema.const('上上签'), Schema.const('上签'), Schema.const('中吉签'),
          Schema.const('中签'), Schema.const('中平签'), Schema.const('下签'),
        ]).description('签等级。'),
        number: Schema.number().description('签号。'),
        poem: Schema.array(Schema.string()).description('四句签诗。'),
        interpretation: Schema.string().description('白话解签。'),
        luck: Schema.object({
          财运: Schema.string(),
          姻缘: Schema.string(),
          修炼: Schema.string(),
          健康: Schema.string(),
          出行: Schema.string(),
        }).description('分类运势。'),
      }).description('签文对象'),
    ).description('自定义签文库（高级）。全覆盖内置 40 签，留空则用内置库。')
      .default([]),
  }),
])

export const name = 'bns-fortune'
export const reusable = true
export { Config as config }

/**
 * 获取 canvas 服务。
 * koishi-plugin-canvas（基于 skia-canvas）会注入 ctx.canvas。
 */
function getCanvas(ctx: Context) {
  // koishi-plugin-canvas 注入的服务挂载在 ctx.canvas
  const canvas = (ctx as unknown as { canvas?: import('./render').CanvasService }).canvas
  if (!canvas) {
    throw new Error(
      '未检测到 canvas 服务。请在 Koishi 中安装并启用 "koishi-plugin-canvas" 插件，本插件依赖它来绘制签图。',
    )
  }
  return canvas
}

/** 注册字体目录下的 ttf/otf（若提供） */
function tryRegisterFonts(dir: string): void {
  if (!dir) return
  const abs = resolve(dir)
  if (!existsSync(abs)) {
    logger.warn('字体目录不存在，跳过注册：%s', abs)
    return
  }
  let files: string[] = []
  try {
    files = readdirSync(abs)
  } catch (e) {
    logger.warn('读取字体目录失败：%o', e)
    return
  }
  // skia-canvas 提供 Fontlibrary.use；node-canvas 提供 registerFont。
  // 两者都尝试，命中其一即可。
  for (const f of files) {
    const lower = f.toLowerCase()
    if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) continue
    const full = resolve(abs, f)
    const family = f.replace(/\.(ttf|otf)$/i, '')
    try {
      // skia-canvas
      const skia = (globalThis as any).FontLibrary
      if (skia?.use) {
        skia.use(family, [full])
        continue
      }
    } catch { /* ignore */ }
    try {
      // node-canvas
      const nodeCanvas = require('canvas')
      if (typeof nodeCanvas.registerFont === 'function') {
        nodeCanvas.registerFont(full, { family })
      }
    } catch { /* ignore */ }
  }
}

export function apply(ctx: Context, config: Config) {
  // 启动时注册字体（失败不阻断）
  try {
    tryRegisterFonts(config.fontsDir)
  } catch (e) {
    logger.warn('字体注册异常：%o', e)
  }

  const library: Fortune[] =
    Array.isArray(config.results) && config.results.length > 0
      ? config.results
      : FORTUNES

  const theme: Theme = THEMES[config.theme] ?? THEMES.ink
  let renderer: FortuneRenderer | undefined
  function getRenderer(): FortuneRenderer {
    if (!renderer) renderer = new FortuneRenderer(getCanvas(ctx))
    return renderer
  }

  // 每日每用户渲染缓存：key = `${date}|${userId}`
  const renderCache = new Map<string, Buffer>()
  // 每天换日时清理
  ctx.setInterval(() => renderCache.clear(), 60 * 60 * 1000)

  const cmd = ctx
    .command('fortune', '剑灵每日好运签')
    .alias('求签')
    .alias('jrrp')
    .action(async ({ session }) => {
      if (!session?.userId) return '无法识别用户。'

      const date = formatDate(new Date())
      const cacheKey = `${date}|${session.userId}`

      // 命中缓存
      const cached = renderCache.get(cacheKey)
      if (cached) return h.image(cached, 'image/png')

      try {
        const { fortune } = drawFortune(date, session.userId, config.masterKey, library)
        const png = await getRenderer().render({
          fortune,
          date,
          nickname: session.username || session.author?.nickname,
          fontFamily: config.fontFamily,
          theme,
          customBackground: config.customBackground || undefined,
        })
        renderCache.set(cacheKey, png)
        return h.image(png, 'image/png')
      } catch (e) {
        logger.warn('抽签/渲染失败：%o', e)
        return '抽签失败：' + (e instanceof Error ? e.message : String(e))
      }
    })

  ctx.on('dispose', () => cmd.dispose())
}

export default { name, apply, Config }
