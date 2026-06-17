/**
 * 渲染：背景模板（Canvas 重绘）+ 动态文字叠加
 *
 * 设计思路：
 * - 背景（绸带/印章框/福字暗纹/边框）由代码绘制，按 主题+尺寸 缓存复用，
 *   支持 customBackground 配置项替换为外部图片。
 * - 动态文字（签等级/签诗/解签/运势/日期/昵称/签号）每次叠加在背景之上。
 * - 配色用剑灵水墨风（墨黑 / 朱砂红 / 赤金 / 米色），装饰加入剑气、符文元素。
 *
 * 直接使用 node-canvas 包，不依赖 Koishi 的 canvas 服务（避免服务名冲突）。
 */
import { Fortune } from './fortunes'
import { createCanvas, loadImage, Canvas, Image } from '@napi-rs/canvas'

/** @napi-rs/canvas 渲染上下文，与 DOM Ctx2D 运行时兼容 */
type Ctx2D = any

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

export interface Theme {
  /** 主题名 */
  name: string
  /** 米色底（中心） */
  bg: string
  /** 边缘渐变深色 */
  bgDark: string
  /** 主文字色（水墨黑） */
  ink: string
  /** 朱砂红（绸带、印章、解签） */
  red: string
  /** 赤金（描边、标题、装饰） */
  gold: string
  /** 暗金（福字暗纹） */
  goldDim: string
  /** 卷轴内衬底色（半透明） */
  scroll: string
}

export const THEMES: Record<string, Theme> = {
  /** 剑灵·水墨：墨黑朱砂赤金 */
  ink: {
    name: '剑灵·水墨',
    bg: '#f3e9d2',
    bgDark: '#d9c79a',
    ink: '#1c1a17',
    red: '#8e1a1a',
    gold: '#c9a24b',
    goldDim: '#b89a5c',
    scroll: 'rgba(253,247,232,0.55)',
  },
  /** 传统·朱金：朱红描金 */
  'gold-red': {
    name: '传统·朱金',
    bg: '#fdf3df',
    bgDark: '#e8c98c',
    ink: '#3a1d1d',
    red: '#c0392b',
    gold: '#d4af37',
    goldDim: '#caa84a',
    scroll: 'rgba(255,250,235,0.6)',
  },
}

/* ------------------------------------------------------------------ */
/* 画布尺寸                                                            */
/* ------------------------------------------------------------------ */

export const W = 600
export const H = 860

/* ------------------------------------------------------------------ */
/* 渲染器                                                              */
/* ------------------------------------------------------------------ */

export interface RenderInput {
  fortune: Fortune
  /** YYYY-MM-DD */
  date: string
  /** 用户昵称 */
  nickname?: string
  /** 字体族（需已注册或为系统字体） */
  fontFamily: string
  /** 主题 */
  theme: Theme
  /** 自定义背景图路径/URL；为空则用代码绘制 */
  customBackground?: string
}

export class FortuneRenderer {
  /** 背景缓存：key = `${themeName}|${customBg ?? 'builtin'}` */
  private bgCache = new Map<string, Canvas>()
  /** 自定义背景图缓存：key = url */
  private imageCache = new Map<string, Image>()
  /** 缓存条数上限 */
  private static MAX_CACHE = 12

  private evict(map: Map<string, unknown>) {
    while (map.size > FortuneRenderer.MAX_CACHE) {
      const first = map.keys().next().value as string
      map.delete(first)
    }
  }

  /** 字体声明字符串，含中文回退 */
  private fontStack(family: string): string {
    const f = family && family.trim()
    const main = f ? `"${f}",` : ''
    return `${main}"LXGW WenKai","KaiTi","STKaiti","楷体","Microsoft YaHei","微软雅黑","SimSun","宋体",serif`
  }

  /** 获取（或绘制并缓存）背景画布 */
  private async getBackground(theme: Theme, customBg?: string): Promise<Canvas> {
    const key = `${theme.name}|${customBg ?? 'builtin'}`
    const cached = this.bgCache.get(key)
    if (cached) return cached

    let bg: Canvas
    if (customBg) {
      // 自定义背景：加载图片并缩放绘制到画布
      let img = this.imageCache.get(customBg)
      if (!img) {
        img = await loadImage(customBg)
        this.imageCache.set(customBg, img)
        this.evict(this.imageCache)
      }
      bg = createCanvas(W, H)
      const ctx = bg.getContext('2d')
      // 先填底色，避免透明
      ctx.fillStyle = theme.bg
      ctx.fillRect(0, 0, W, H)
      // 等比铺满（cover）
      const scale = Math.max(W / img.width, H / img.height)
      const dw = img.width * scale
      const dh = img.height * scale
      ctx.drawImage(img as any, (W - dw) / 2, (H - dh) / 2, dw, dh)
      // 仍叠加边框与暗角，保持风格统一
      drawVignette(ctx, W, H, theme)
      drawBorder(ctx, W, H, theme)
    } else {
      bg = createCanvas(W, H)
      const ctx = bg.getContext('2d')
      drawBackground(ctx, W, H, theme)
    }

    this.bgCache.set(key, bg)
    this.evict(this.bgCache)
    return bg
  }

  /** 渲染整张签图，返回 PNG Buffer */
  async render(input: RenderInput): Promise<Buffer> {
    const { fortune, date, nickname, fontFamily, theme, customBackground } = input

    const bg = await this.getBackground(theme, customBackground)
    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')

    // 1. 复制缓存背景
    ctx.drawImage(bg as any, 0, 0)

    // 2. 顶部绸带 + 签等级标题（动态）
    drawRibbon(ctx, W / 2, 78, theme)
    drawLevelTitle(ctx, W / 2, 86, fortune.level, this.fontStack(fontFamily), theme)

    // 3. 圆形印章装饰（固定文字「灵签」，剑灵符文感）
    drawSeal(ctx, W / 2, 178, 52, theme)

    // 4. 签诗竖排（主体）
    drawPoemVertical(ctx, W / 2, 286, fortune.poem, this.fontStack(fontFamily), theme)

    // 5. 解签（横排）
    drawInterpretation(ctx, W / 2, 566, fortune.interpretation, this.fontStack(fontFamily), theme)

    // 6. 运势小标签
    drawLuckTags(ctx, W / 2, 638, fortune.luck, this.fontStack(fontFamily), theme)

    // 7. 底部：日期 / 昵称 / 签号
    drawFooter(ctx, W, H, date, nickname, fortune.number, this.fontStack(fontFamily), theme)

    // @napi-rs/canvas 需要传 mime type
    return canvas.toBuffer('image/png')
  }
}

/* ================================================================== */
/* 背景绘制                                                            */
/* ================================================================== */

function drawBackground(ctx: Ctx2D, w: number, h: number, theme: Theme): void {
  // 1. 米色径向渐变底
  const grad = ctx.createRadialGradient(w / 2, h * 0.42, 60, w / 2, h * 0.5, h * 0.75)
  grad.addColorStop(0, theme.bg)
  grad.addColorStop(1, theme.bgDark)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  // 2. 福字暗纹（平铺）
  drawFuPattern(ctx, w, h, theme)

  // 3. 暗角
  drawVignette(ctx, w, h, theme)

  // 4. 双层金边框 + 四角符文
  drawBorder(ctx, w, h, theme)
}

/** 福字暗纹：稀疏平铺的半透明「福」字 */
function drawFuPattern(ctx: Ctx2D, w: number, h: number, theme: Theme): void {
  ctx.save()
  ctx.fillStyle = theme.goldDim
  ctx.globalAlpha = 0.08
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `64px ${fontBase()}`
  const step = 150
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      // 错位排列
      const offset = (Math.floor(y / step) % 2) * (step / 2)
      ctx.fillText('福', x + offset, y)
    }
  }
  ctx.restore()
}

/** 暗角：四角加深 */
function drawVignette(ctx: Ctx2D, w: number, h: number, theme: Theme): void {
  ctx.save()
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.75)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(60,40,20,0.28)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

/** 双层金边框 + 四角剑形符文 */
function drawBorder(ctx: Ctx2D, w: number, h: number, theme: Theme): void {
  ctx.save()
  // 外粗金线
  ctx.strokeStyle = theme.gold
  ctx.lineWidth = 3
  ctx.strokeRect(22, 22, w - 44, h - 44)
  // 内细朱线
  ctx.strokeStyle = theme.red
  ctx.lineWidth = 1
  ctx.strokeRect(30, 30, w - 60, h - 60)
  // 四角剑形符文装饰
  const corners = [
    [30, 30], [w - 30, 30], [30, h - 30], [w - 30, h - 30],
  ]
  ctx.fillStyle = theme.gold
  ctx.globalAlpha = 0.85
  for (const [cx, cy] of corners) drawCornerSigil(ctx, cx, cy, theme)
  ctx.restore()
}

/** 四角小符文：六芒剑纹 */
function drawCornerSigil(ctx: Ctx2D, cx: number, cy: number, theme: Theme): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.strokeStyle = theme.gold
  ctx.lineWidth = 1.2
  ctx.beginPath()
  // 一个小菱形 + 中心点，象征剑锋符文
  const r = 7
  ctx.moveTo(0, -r)
  ctx.lineTo(r, 0)
  ctx.lineTo(0, r)
  ctx.lineTo(-r, 0)
  ctx.closePath()
  ctx.stroke()
  ctx.fillStyle = theme.red
  ctx.beginPath()
  ctx.arc(0, 0, 1.6, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/* ================================================================== */
/* 动态元素绘制                                                        */
/* ================================================================== */

/** 顶部红色绸带（含两端剑形流苏） */
function drawRibbon(ctx: Ctx2D, cx: number, cy: number, theme: Theme): void {
  const w = 380
  const hh = 64
  const x0 = cx - w / 2
  ctx.save()
  // 绸带主体（带下凹弧线）
  ctx.fillStyle = theme.red
  ctx.beginPath()
  ctx.moveTo(x0 - 18, cy - hh / 2)
  ctx.lineTo(x0 + w + 18, cy - hh / 2)
  ctx.quadraticCurveTo(x0 + w + 30, cy, x0 + w + 18, cy + hh / 2)
  ctx.lineTo(x0 - 18, cy + hh / 2)
  ctx.quadraticCurveTo(x0 - 30, cy, x0 - 18, cy - hh / 2)
  ctx.closePath()
  ctx.fill()
  // 金色描边
  ctx.strokeStyle = theme.gold
  ctx.lineWidth = 2
  ctx.stroke()
  // 两端剑形流苏
  drawSwordTassel(ctx, x0 - 18, cy, -1, theme)
  drawSwordTassel(ctx, x0 + w + 18, cy, 1, theme)
  // 绸带高光
  ctx.fillStyle = 'rgba(255,255,255,0.12)'
  ctx.fillRect(x0 - 6, cy - hh / 2 + 4, w + 12, 8)
  ctx.restore()
}

/** 剑形流苏：绸带末端的小剑形装饰 */
function drawSwordTassel(ctx: Ctx2D, x: number, y: number, dir: number, theme: Theme): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(dir, 1)
  ctx.fillStyle = theme.gold
  // 剑身
  ctx.beginPath()
  ctx.moveTo(0, -3)
  ctx.lineTo(22, -3)
  ctx.lineTo(28, 0)
  ctx.lineTo(22, 3)
  ctx.lineTo(0, 3)
  ctx.closePath()
  ctx.fill()
  // 流苏穗
  ctx.strokeStyle = theme.gold
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(28, 0)
  ctx.lineTo(40, 0)
  ctx.stroke()
  ctx.restore()
}

/** 绸带上的签等级标题 */
function drawLevelTitle(
  ctx: Ctx2D,
  cx: number, cy: number,
  level: string,
  font: string,
  theme: Theme,
): void {
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold 34px ${font}`
  // 金色描边 + 米黄填充，呈现烫金感
  ctx.lineWidth = 5
  ctx.strokeStyle = theme.red
  ctx.strokeText(level, cx, cy)
  ctx.lineWidth = 2
  ctx.strokeStyle = theme.gold
  ctx.strokeText(level, cx, cy)
  ctx.fillStyle = '#fff4cf'
  ctx.fillText(level, cx, cy)
  ctx.restore()
}

/** 圆形印章：固定篆书感「灵签」+ 剑气光线 */
function drawSeal(ctx: Ctx2D, cx: number, cy: number, r: number, theme: Theme): void {
  ctx.save()
  // 外圈剑气光线
  ctx.strokeStyle = theme.gold
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 1
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * (r + 6), cy + Math.sin(a) * (r + 6))
    ctx.lineTo(cx + Math.cos(a) * (r + 12), cy + Math.sin(a) * (r + 12))
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  // 外圆（朱红）
  ctx.strokeStyle = theme.red
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  // 内圆（金）
  ctx.strokeStyle = theme.gold
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(cx, cy, r - 6, 0, Math.PI * 2)
  ctx.stroke()
  // 中心文字「灵签」竖排
  ctx.fillStyle = theme.red
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold 22px ${fontBase()}`
  ctx.fillText('灵', cx, cy - 13)
  ctx.fillText('签', cx, cy + 13)
  ctx.restore()
}

/** 签诗竖排（右起，每列 7 字） */
function drawPoemVertical(
  ctx: Ctx2D,
  cx: number, startY: number,
  poem: string[],
  font: string,
  theme: Theme,
): void {
  ctx.save()
  ctx.fillStyle = theme.ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const fontSize = 31
  const lineGap = 40 // 字间距
  const colGap = 60 // 列间距
  ctx.font = `${fontSize}px ${font}`
  // 右起：第 0 句最右
  const cols = poem.length
  const firstColX = cx + ((cols - 1) / 2) * colGap
  poem.forEach((line, i) => {
    const x = firstColX - i * colGap
    for (let j = 0; j < line.length; j++) {
      ctx.fillText(line[j], x, startY + j * lineGap)
    }
  })
  ctx.restore()
}

/** 解签（横排，居中，自动换行） */
function drawInterpretation(
  ctx: Ctx2D,
  cx: number, cy: number,
  text: string,
  font: string,
  theme: Theme,
): void {
  ctx.save()
  ctx.fillStyle = theme.red
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `20px ${font}`
  const maxWidth = 460
  const lines = wrapText(ctx, `解曰：${text}`, maxWidth)
  const lineHeight = 28
  const startY = cy - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((ln, i) => ctx.fillText(ln, cx, startY + i * lineHeight))
  ctx.restore()
}

/** 运势小标签（横排） */
function drawLuckTags(
  ctx: Ctx2D,
  cx: number, cy: number,
  luck: Fortune['luck'],
  font: string,
  theme: Theme,
): void {
  const entries = Object.entries(luck)
  if (entries.length === 0) return
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `16px ${font}`
  const tagW = 150
  const tagH = 44
  const gap = 14
  const totalW = entries.length * tagW + (entries.length - 1) * gap
  const startX = cx - totalW / 2
  entries.forEach(([key, val], i) => {
    const x = startX + i * (tagW + gap)
    // 标签底
    roundRect(ctx, x, cy - tagH / 2, tagW, tagH, 8)
    ctx.fillStyle = theme.scroll
    ctx.fill()
    ctx.strokeStyle = theme.gold
    ctx.lineWidth = 1.2
    ctx.stroke()
    // 分类名（金）
    ctx.fillStyle = theme.gold
    ctx.font = `bold 15px ${font}`
    ctx.fillText(key, x + tagW * 0.24, cy)
    // 内容（墨）
    ctx.fillStyle = theme.ink
    ctx.font = `15px ${font}`
    // 内容可能较长，截断
    const maxLen = 5
    const shown = val.length > maxLen ? val.slice(0, maxLen) + '…' : val
    ctx.fillText(shown, x + tagW * 0.66, cy)
  })
  ctx.restore()
}

/** 底部：日期 / 昵称 / 签号 */
function drawFooter(
  ctx: Ctx2D,
  w: number, h: number,
  date: string, nickname: string | undefined,
  number: number,
  font: string,
  theme: Theme,
): void {
  ctx.save()
  ctx.fillStyle = theme.gold
  ctx.textBaseline = 'middle'
  ctx.font = `18px ${font}`
  // 左：日期
  ctx.textAlign = 'left'
  ctx.fillText(date, 56, h - 50)
  // 右：昵称
  ctx.textAlign = 'right'
  ctx.fillText(nickname ? `${nickname} 求得` : '', w - 56, h - 50)
  // 中：签号
  ctx.textAlign = 'center'
  ctx.fillStyle = theme.red
  ctx.font = `bold 20px ${font}`
  ctx.fillText(`第 ${number} 签`, w / 2, h - 50)
  ctx.restore()
}

/* ================================================================== */
/* 工具函数                                                            */
/* ================================================================== */

/** 基础中文字体栈（用于装饰固定文字） */
function fontBase(): string {
  return `"LXGW WenKai","KaiTi","STKaiti","楷体","SimSun","宋体",serif`
}

/** 中文/英文混排自动换行 */
function wrapText(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const ch of text) {
    const test = current + ch
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current)
      current = ch
    } else {
      current = test
    }
  }
  if (current) lines.push(current)
  return lines
}

/** 圆角矩形路径 */
function roundRect(
  ctx: Ctx2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
