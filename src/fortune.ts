/**
 * 定签算法：确定性随机
 *
 * 同一 (日期 + 用户ID + masterKey) 永远得到同一支签，
 * 杜绝同一用户当天刷屏改命。
 */
import { Fortune, FortuneLevel, FORTUNES, LEVEL_WEIGHTS } from './fortunes'

/** 简单字符串哈希（FNV-1a 变体），返回 32 位无符号整数 */
function hashString(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  // 转无符号
  return hash >>> 0
}

/** mulberry32：种子 → 确定性 PRNG，返回 [0,1) 的函数 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 格式化日期为 YYYY-MM-DD（基于本地时区） */
export function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface DrawResult {
  fortune: Fortune
  /** 签文在该等级内的序号（用于展示"今日第 X 签"） */
  index: number
  /** 用于展示的种子 */
  seed: number
}

/**
 * 抽签
 * @param dateStr  YYYY-MM-DD
 * @param userId   用户 ID
 * @param masterKey 随机密钥（可由配置提供）
 * @param library  签文库（默认内置）
 */
export function drawFortune(
  dateStr: string,
  userId: string,
  masterKey: string,
  library: Fortune[] = FORTUNES,
): DrawResult {
  if (library.length === 0) {
    throw new Error('签文库为空，无法抽签')
  }

  const seed = hashString(`${dateStr}|${userId}|${masterKey}`)
  const rand = mulberry32(seed)

  // 1. 按等级权重先定等级
  const levelList = Object.keys(LEVEL_WEIGHTS) as FortuneLevel[]
  const totalWeight = levelList.reduce((s, lv) => s + LEVEL_WEIGHTS[lv], 0)
  let r = rand() * totalWeight
  let chosenLevel: FortuneLevel = levelList[0]
  for (const lv of levelList) {
    if (r < LEVEL_WEIGHTS[lv]) {
      chosenLevel = lv
      break
    }
    r -= LEVEL_WEIGHTS[lv]
  }

  // 2. 在该等级的签中再随机一条；若该等级无签则回退到整库随机
  const candidates = library.filter((f) => f.level === chosenLevel)
  const pool = candidates.length > 0 ? candidates : library
  const index = Math.floor(rand() * pool.length)
  const fortune = pool[index]

  return { fortune, index, seed }
}
