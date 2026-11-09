/**
 * dsh-skill-quickpick — host 半边：技能中文名的自动翻译与缓存。
 *
 * 为什么需要 host 半边：浏览器半边读不到文件、也调不了模型。技能描述是作者写死的
 * 英文（在 SKILL.md 的 frontmatter 里），要变成中文只能翻译一次然后缓存。
 *
 * 流程：
 *   1. 客户端把「没有中文对照的技能」POST 到 /skill-quickpick/translate
 *   2. 这里先查缓存 dsh-home/skill-quickpick-zh.json
 *   3. 缓存里没有的，批量交给已配置的模型翻译（一次请求翻一批，省钱）
 *   4. 结果写回缓存并返回给客户端
 *
 * 翻译只发生在「第一次见到某个技能」时，之后永远读缓存。模型调用失败不影响插件
 * 主功能 —— 客户端会退回显示英文原文。
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, rmSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import zlib from 'node:zlib'
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path'

/** 依赖宿主提供的 webServer（注册路由）与 llm（调用模型）。 */
export const inject = ['webServer', 'llm']

/** 翻译结果缓存文件名（放在 DSH_HOME 下）。 */
const CACHE_FILE_NAME = 'skill-quickpick-zh.json'
/** 客户端调用的路由。 */
const ROUTE = '/skill-quickpick/translate'
/** 用户手写覆盖（中文名 / 描述 / 备注）的读写路由。 */
const OVERRIDE_ROUTE = '/skill-quickpick/override'
/** 用户覆盖单独存一个文件：删机翻缓存不会连带丢掉用户写的东西。 */
const USER_FILE_NAME = 'skill-quickpick-user.json'
/** 技能启用/禁用开关的路由。 */
const TOGGLE_ROUTE = '/skill-quickpick/toggle'
/** 一次性恢复所有被禁用技能的路由（停用 / 卸载插件前用）。 */
const RESTORE_ALL_ROUTE = '/skill-quickpick/restore-all'
/** 技能使用统计的路由（扫描会话日志，统计模型加载次数）。 */
const STATS_ROUTE = '/skill-quickpick/stats'
/** 统计结果与扫描起点的存储。 */
const STATS_FILE_NAME = 'skill-quickpick-stats.json'
/** 技能卸载回收站：目录 + 索引。卸载 = 把整个技能目录移进回收站，可以随时移回。 */
const TRASH_DIR_NAME = 'skill-quickpick-trash'
const TRASH_INDEX_NAME = 'skill-quickpick-trash.json'
const TRASH_ROUTE = '/skill-quickpick/trash'
/** 我们自己禁用过的技能记录 —— 用来区分「我们禁的」和「作者本来就写成仅用户调用」。 */
const DISABLED_FILE_NAME = 'skill-quickpick-disabled.json'
/** 改 SKILL.md 之前的备份目录。 */
const BACKUP_DIR_NAME = 'skill-quickpick-backups'
/** 一次请求最多翻多少个技能，防止 prompt 过长。 */
const BATCH_LIMIT = 12
/** 功能开关的设置路由与存储。高风险功能默认关闭，由用户显式开启。 */
const SETTINGS_ROUTE = '/skill-quickpick/settings'
const SETTINGS_FILE_NAME = 'skill-quickpick-settings.json'
/** 拖拽排序的自定义顺序。{ [技能名]: 序号 }，内置技能现在也参与组内排序。 */
const ORDER_ROUTE = '/skill-quickpick/order'
const ORDER_FILE_NAME = 'skill-quickpick-order.json'

/** 功能开关的默认值。高风险能力一律默认关，由用户显式开启。 */
const DEFAULT_SETTINGS = {
  /** 卸载 / 回收站 / 保留期 / 自动清理。默认关：它会移动用户目录，风险最高。 */
  trashEnabled: false,
  /**
   * 禁用 / 启用（改写 SKILL.md 的 disable-model-invocation）。默认关。
   *
   * 这是全插件**最危险**的写操作：它直接改技能文件，而且插件一旦被停用或卸载，
   * 就没有界面能把这些锁解开了（只能手动改文件或跑独立脚本）。比可恢复的回收站危险得多。
   */
  disableEnabled: false,
  /** 自动机翻：会把技能名和描述发给第三方模型。默认关：数据外发需要显式同意。 */
  autoTranslate: false,
  /** 使用统计：扫描会话日志。默认关：读全部历史会话，开销大且收益低。 */
  statsEnabled: false,
}

function dshHome() {
  return process.env.DSH_HOME || process.env.DSH_PROFILE_DIR || '.'
}

function disabledPath() {
  return join(dshHome(), DISABLED_FILE_NAME)
}

function cachePath() {
  return join(dshHome(), CACHE_FILE_NAME)
}

function userPath() {
  return join(dshHome(), USER_FILE_NAME)
}

/** 读禁用记录：{ [技能名]: { path, backup, at } }。 */
function readDisabled() {
  try {
    const p = disabledPath()
    if (!existsSync(p)) return {}
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    console.warn('[skill-quickpick] 读取禁用记录失败：' + (error && error.message ? error.message : error))
    return {}
  }
}

function writeDisabled(next) {
  try {
    const p = disabledPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileAtomic(p, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch (error) {
    console.warn('[skill-quickpick] 写禁用记录失败：' + (error && error.message ? error.message : error))
    return false
  }
}

/** 设置文件路径。 */
function settingsPath() {
  return join(dshHome(), SETTINGS_FILE_NAME)
}

/**
 * 读功能开关。缺字段一律回落到**默认关闭**——
 * 宁可让用户多点一次开关，也不能让高风险功能在不知情的情况下跑起来。
 */
function readSettings() {
  const settings = { ...DEFAULT_SETTINGS }
  try {
    const p = settingsPath()
    if (!existsSync(p)) return settings
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (typeof parsed[key] === 'boolean') settings[key] = parsed[key]
      }
    }
  } catch (error) {
    console.warn('[skill-quickpick] 读设置失败（按默认关闭处理）：' + (error && error.message ? error.message : error))
  }
  return settings
}

function writeSettings(next) {
  // 缺失的字段回落到**当前已保存值**，而不是回落到默认值 false。
  // 回落默认值的后果：旧客户端/脚本少传一个字段，就会把用户已经开启的其他开关静默关掉。
  const current = readSettings()
  const settings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (next && typeof next[key] === 'boolean') settings[key] = next[key]
    else settings[key] = current[key]
  }
  try {
    const p = settingsPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileAtomic(p, JSON.stringify(settings, null, 2) + '\n')
    return settings
  } catch (error) {
    console.warn('[skill-quickpick] 写设置失败：' + (error && error.message ? error.message : error))
    return null
  }
}

/** 自定义排序文件路径。 */
function orderPath() {
  return join(dshHome(), ORDER_FILE_NAME)
}

/**
 * 读自定义排序：{ [技能名]: 序号 }。
 * 只接受「技能名 → 有限数字」的条目，其余忽略（防止文件被写坏时炸掉整个列表）。
 */
function readOrder() {
  try {
    const p = orderPath()
    if (!existsSync(p)) return {}
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const order = {}
    for (const key of Object.keys(parsed)) {
      const value = parsed[key]
      if (typeof key === 'string' && key !== '' && Number.isFinite(value)) order[key] = value
    }
    return order
  } catch (error) {
    console.warn('[skill-quickpick] 读排序失败：' + (error && error.message ? error.message : error))
    return {}
  }
}

function writeOrder(next) {
  try {
    const order = {}
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      for (const key of Object.keys(next)) {
        if (typeof key === 'string' && key !== '' && Number.isFinite(next[key])) order[key] = next[key]
      }
    }
    const p = orderPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileAtomic(p, JSON.stringify(order, null, 2) + '\n')
    return order
  } catch (error) {
    console.warn('[skill-quickpick] 写排序失败：' + (error && error.message ? error.message : error))
    return null
  }
}

/**
 * 原子写：先写同目录临时文件再 rename 覆盖。
 *
 * 直接 writeFileSync 到目标文件，一旦写到一半崩溃/断电，原文件就被截断了。
 * rename 在同一分区上是原子的，所以要么旧内容完整、要么新内容完整。
 */
function writeFileAtomic(target, content) {
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, target)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch (cleanupError) { /* 忽略 */ }
    throw error
  }
}

/** UTF-8 BOM。Windows 记事本、PowerShell 5.1 的 `-Encoding UTF8` 都会写它。 */
const BOM_CHAR = '\uFEFF'

/**
 * 拆分 SKILL.md 的 frontmatter，**容忍 BOM**。
 *
 * 早期直接拿 `/^---/` 匹配，于是「用记事本另存过的 SKILL.md」一律报
 * 「没有 frontmatter，拒绝改写」—— 但 DSH 自己的 frontmatter 解析器容忍 BOM，
 * 模型照样加载得动它，结果就是「模型看得到、插件不让禁」。
 * （2026-11 重启验证时踩到的真实 bug：PowerShell 写测试文件带 BOM 触发了它。）
 *
 * 返回里 `bom` 单独标记，写回时由调用方决定是否保留 —— 不改写用户文件的编码特征。
 */
function frontmatterOf(text) {
  const raw = typeof text === 'string' ? text : ''
  const bom = raw.charCodeAt(0) === 0xFEFF
  const source = bom ? raw.slice(1) : raw
  const match = source.match(/^---(\r?\n)([\s\S]*?)\r?\n---/)
  if (!match) return { matched: false, bom, eol: '\n', body: '', rest: source }
  return {
    matched: true,
    bom,
    eol: match[1] === '\r\n' ? '\r\n' : '\n',
    body: match[2],
    rest: source.slice(match[0].length),
  }
}

/**
 * 在 SKILL.md 的 frontmatter 里加 / 删 `disable-model-invocation: true`。
 *
 * 只动 frontmatter 区域，正文一个字节都不碰；换行风格跟随原文件（CRLF / LF）。
 * 不能用 YAML 库 re-dump —— 那会丢注释、改缩进、动正文。
 */
function applyDisableFlag(text, disable) {
  const fm = frontmatterOf(text)
  if (!fm.matched) throw new Error('SKILL.md 没有 frontmatter，拒绝改写')
  const keyRe = /^\s*disable-model-invocation\s*:/
  const lines = fm.body.split(/\r?\n/).filter((line) => !keyRe.test(line))
  if (disable) lines.push('disable-model-invocation: true')
  const result = '---' + fm.eol + lines.join(fm.eol) + fm.eol + '---' + fm.rest
  // 保留原文件 BOM：不因为插件改过一行就把用户的文件编码特征改掉
  return (fm.bom ? BOM_CHAR : '') + result
}

/** 改文件前先备份，返回备份路径。同一天同一技能只留一份，避免反复点开关刷出一堆文件。 */
function backupSkillFile(skillPath, name) {
  const dir = join(dshHome(), BACKUP_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  const target = join(dir, safeName + '-' + day + '.md')
  copyFileSync(skillPath, target)
  return target
}

function readCache() {
  try {
    const p = cachePath()
    if (!existsSync(p)) return {}
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    console.warn('[skill-quickpick] 读取缓存失败：' + (error && error.message ? error.message : error))
    return {}
  }
}

/** 读用户覆盖：{ [技能名]: { zh?, desc?, note? } }。 */
function readUserOverride() {
  try {
    const p = userPath()
    if (!existsSync(p)) return {}
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean = {}
    for (const name of Object.keys(parsed)) {
      const entry = parsed[name]
      if (!entry || typeof entry !== 'object') continue
      const next = {}
      if (typeof entry.zh === 'string' && entry.zh.trim() !== '') next.zh = entry.zh.trim()
      if (typeof entry.desc === 'string' && entry.desc.trim() !== '') next.desc = entry.desc.trim()
      if (typeof entry.note === 'string' && entry.note.trim() !== '') next.note = entry.note.trim()
      if (Object.keys(next).length > 0) clean[name] = next
    }
    return clean
  } catch (error) {
    console.warn('[skill-quickpick] 读取用户覆盖失败：' + (error && error.message ? error.message : error))
    return {}
  }
}

function writeUserOverride(next) {
  try {
    const p = userPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileAtomic(p, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch (error) {
    console.warn('[skill-quickpick] 写用户覆盖失败：' + (error && error.message ? error.message : error))
    return false
  }
}

function writeCache(next) {
  try {
    const p = cachePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileAtomic(p, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch (error) {
    console.warn('[skill-quickpick] 写缓存失败：' + (error && error.message ? error.message : error))
    return false
  }
}

/**
 * 翻译用的模型降级链。
 *
 * 前三条在同一个平台（bailian），平台整体挂了会一起失效，所以最后一条必须换成另一个
 * 平台（deepseek-account 是主 agent 的默认路由，额度最稳）。依次尝试，某一条抛错或
 * 返回不合格就换下一条。正常情况只用第一条。
 */
const TRANSLATION_ROUTES = [
  { provider: 'bailian', model: 'glm-5.3-prime' },
  { provider: 'bailian', model: 'kimi/kimi-k2.8-preview' },
  { provider: 'bailian', model: 'stepfun/step-5-preview' },
  { provider: 'deepseek-account', model: 'deepseek-flash' },
]

/** 中文短名与描述的长度上限（超出视为模型跑偏）。 */
const MAX_ZH_LEN = 20
const MAX_DESC_LEN = 100
/** 一个汉字都算中文字符，用来判断「到底翻了没有」。 */
const CJK_RE = /[\u4e00-\u9fff]/
/** 原文里出现、译文里必须保留的技术名词。 */
const PROTECTED_TERMS = ['Word', 'Excel', 'PowerPoint', 'PPT', 'PDF', 'SKILL.md', 'DOCX', 'XLSX', 'PPTX']

function hasCjk(text) {
  return typeof text === 'string' && CJK_RE.test(text)
}

/**
 * 校验一条翻译。
 *
 * 这里刻意不做「第二个模型复核」——那会把每次翻译的成本翻倍，而绝大多数错误是下面
 * 这几类规则错，规则能抓住。规则抓不到的语义偏差只能靠人扫一眼或删缓存重翻，不值得
 * 为它常态化多跑一次模型。
 *
 * @param row 模型返回的一条 {name, zh, desc}
 * @param source 对应的源技能 {name, description}
 */
function validateTranslation(row, source) {
  const zh = typeof row.zh === 'string' ? row.zh.trim() : ''
  const desc = typeof row.desc === 'string' ? row.desc.trim() : ''
  if (zh === '' && desc === '') return { ok: false, reason: '空结果' }
  if (!hasCjk(zh) && !hasCjk(desc)) return { ok: false, reason: '没有任何中文，疑似未翻译' }
  if (zh.length > MAX_ZH_LEN) return { ok: false, reason: '中文名过长(' + zh.length + ')' }
  if (desc.length > MAX_DESC_LEN) return { ok: false, reason: '描述过长(' + desc.length + ')' }
  const origin = typeof source.description === 'string' ? source.description : ''
  if (desc !== '' && origin !== '' && desc.toLowerCase() === origin.toLowerCase()) {
    return { ok: false, reason: '描述与原文相同，未翻译' }
  }
  const originTerms = PROTECTED_TERMS.filter((term) => origin.indexOf(term) >= 0)
  if (originTerms.length > 0) {
    const kept = originTerms.some((term) => desc.indexOf(term) >= 0 || zh.indexOf(term) >= 0)
    if (!kept) return { ok: false, reason: '受保护名词丢失' }
  }
  return { ok: true, zh: zh || source.name, desc }
}

/** 把一次模型流式调用的文本收齐。 */
async function streamText(ctx, route, prompt) {
  let text = ''
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    // 终止分片：{ kind: 'error' | 'aborted', failure }
    if (chunk.kind === 'error' || chunk.kind === 'aborted') {
      const failure = chunk.failure
      const code = failure && failure.code ? failure.code : chunk.kind
      throw new Error('模型调用终止：' + code)
    }
  }
  return text
}

/** 从模型输出里抠出 JSON 数组（容忍代码围栏与前后废话）。 */
function parseJsonArray(text) {
  if (typeof text !== 'string' || text === '') return null
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch (error) {
    return null
  }
}

function buildPrompt(batch) {
  const payload = batch.map((s) => ({ name: s.name, description: s.description }))
  return [
    '你是技术文档翻译。把下面每个 AI 技能（skill）的名称和英文描述翻译成简体中文。',
    '要求：',
    '1. zh 是中文短名，不超过 10 个字，用于按钮标题，例如 "Word 文档"、"项目全流程"。',
    '2. desc 是中文描述，不超过 40 个字，说清这个技能能干什么。',
    '3. 保留专有名词（Word、Excel、PPT、PDF、SKILL.md 等）不翻译。',
    '4. 只输出 JSON 数组，不要代码围栏、不要任何解释文字。',
    '输出格式：[{"name":"原技能名","zh":"中文短名","desc":"中文描述"}]',
    '',
    '待翻译：',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

/**
 * 批量翻译一批技能，返回 { 名称: {zh, desc} }。
 *
 * 降级逻辑：按 TRANSLATION_ROUTES 顺序尝试，每轮只处理「还没拿到合格译文」的技能；
 * 某个模型抛错、整批解析失败、或个别项没通过校验，就换下一个模型补。全部失败返回空
 * 对象 —— 调用方据此不写缓存，下次打开面板会重新尝试。
 */
async function translateBatch(ctx, batch) {
  const result = {}
  let pending = batch.slice()
  for (const route of TRANSLATION_ROUTES) {
    if (pending.length === 0) break
    const label = route.provider + '/' + route.model
    try {
      const text = await streamText(ctx, route, buildPrompt(pending))
      const rows = parseJsonArray(text)
      if (rows === null) {
        console.warn('[skill-quickpick] ' + label + ' 返回的不是合法 JSON 数组，换下一个模型')
        continue
      }
      const byName = new Map()
      for (const row of rows) {
        if (row && typeof row.name === 'string' && row.name !== '') byName.set(row.name, row)
      }
      const stillPending = []
      for (const skill of pending) {
        const row = byName.get(skill.name)
        if (row === undefined) {
          stillPending.push(skill)
          continue
        }
        const verdict = validateTranslation(row, skill)
        if (verdict.ok) {
          result[skill.name] = { zh: verdict.zh, desc: verdict.desc }
        } else {
          console.warn('[skill-quickpick] ' + skill.name + ' 译文不合格（' + verdict.reason + '），换模型重试')
          stillPending.push(skill)
        }
      }
      pending = stillPending
    } catch (error) {
      console.warn('[skill-quickpick] ' + label + ' 调用失败：' + (error && error.message ? error.message : error) + '，换下一个模型')
    }
  }
  if (pending.length > 0) {
    console.warn('[skill-quickpick] 仍有 ' + pending.length + ' 个技能没拿到合格译文，下次再试：'
      + pending.map((s) => s.name).join(', '))
  }
  return result
}

/**
 * 读请求体（有上限，避免异常请求撑爆内存）。
 *
 * 同时做一道来源校验：写操作**媒体类型必须严格等于 application/json**。
 *
 * 注意不能用 `includes('application/json')` —— 那是子串检查，可以这样绕过：
 *   Content-Type: text/plain; x="application/json"
 * 浏览器的「简单请求」判定只看 MIME 的 essence（分号前那段），所以上面这个头
 * 仍然属于 CORS-safelisted、**不触发预检**，同时又能通过子串检查 ——
 * 于是任意网页都能对本机端口做 CSRF 写操作。必须按 `;` 切开比对。
 */
async function readJsonBody(req) {
  const contentType = String((req.headers && req.headers['content-type']) || '')
  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new Error('只接受 Content-Type: application/json 的请求')
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return null
  return JSON.parse(text)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

// ── 技能使用统计：扫描会话日志，统计「模型通过 skill 工具加载」的次数 ──────────
//
// 会话日志是「每个事件一个 zstd 帧」的 jsonl.zstd。Node 的 zstd 解压只处理第一帧，
// 所以要自己按帧格式切分后逐帧解压（帧边界靠解析帧头和 block 头算出来）。
// 实测约 55ms / 7MB 会话，可以接受。
//
// 只统计 since 之后的调用 —— since 是「本统计功能第一次运行」的时间点，这样不会把
// 装插件之前的历史算进来。

const ZSTD_MAGIC = 0xFD2FB528
const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function'

/** 统计结果缓存（进程内），避免每次请求都重扫。 */
let statsCache = null
let statsScanning = false

function statsPath() {
  return join(dshHome(), STATS_FILE_NAME)
}

function readStatsFile() {
  try {
    const p = statsPath()
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      since: typeof parsed.since === 'number' ? parsed.since : 0,
      lastScanAt: typeof parsed.lastScanAt === 'number' ? parsed.lastScanAt : 0,
      calls: parsed.calls && typeof parsed.calls === 'object' ? parsed.calls : {},
    }
  } catch (error) {
    console.warn('[skill-quickpick] 读统计失败：' + (error && error.message ? error.message : error))
    return null
  }
}

function writeStatsFile(next) {
  try {
    const p = statsPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileAtomic(p, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch (error) {
    console.warn('[skill-quickpick] 写统计失败：' + (error && error.message ? error.message : error))
    return false
  }
}

/** 列出所有会话日志文件。 */
function listSessionFiles() {
  const root = join(dshHome(), 'sessions')
  const out = []
  if (!existsSync(root)) return out
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return out
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    let sessions
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = join(workspaceDir, session.name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) out.push(file)
    }
  }
  return out
}

/** 算一个 zstd 帧的总字节长度；解析失败返回 -1。 */
function frameLength(buf, offset) {
  let p = offset
  if (p + 4 > buf.length) return -1
  if (buf.readUInt32LE(p) !== ZSTD_MAGIC) return -1
  p += 4

  const fhd = buf[p]
  p += 1
  const fcsFlag = (fhd >> 6) & 0x03
  const singleSegment = (fhd >> 5) & 0x01
  const checksumFlag = (fhd >> 2) & 0x01
  const dictIdFlag = fhd & 0x03

  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][dictIdFlag]
  if (fcsFlag === 0) {
    if (singleSegment) p += 1
  } else {
    p += [0, 2, 4, 8][fcsFlag]
  }

  for (let guard = 0; guard < 200000; guard++) {
    if (p + 3 > buf.length) return -1
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const lastBlock = header & 0x01
    const blockType = (header >> 1) & 0x03
    const blockSize = header >> 3
    if (blockType === 3) return -1
    p += blockSize
    if (lastBlock === 1) break
  }
  if (checksumFlag) p += 4
  return p - offset
}

/** 把一个多帧 zstd 会话文件解成文本；不支持 zstd 或文件坏了返回 null。 */
function decompressSessionFile(filePath) {
  if (!HAS_ZSTD) return null
  let buf
  try {
    buf = readFileSync(filePath)
  } catch (error) {
    return null
  }
  const parts = []
  let offset = 0
  for (let guard = 0; guard < 500000 && offset < buf.length; guard++) {
    const length = frameLength(buf, offset)
    if (length <= 0) break
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offset, offset + length)))
    } catch (error) {
      /* 单帧坏了跳过，不影响其它帧 */
    }
    offset += length
  }
  if (parts.length === 0) return null
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 扫描所有会话，统计 since 之后的技能使用：
 *   model  —— 模型通过 skill 工具自主加载（tool/call 事件）
 *   manual —— 用户显式调用（用户消息里的 `/技能名`）
 *
 * 用户显式调用只从「真实用户输入」里数，跳过系统注入的消息
 * （技能目录的 system-reminder、以及 /name 触发的 skill_content 注入），
 * 否则一次调用会被数两遍。
 */
function scanSkillUsage(since) {
  const calls = {}
  let files = 0
  let failed = 0

  const bump = (name, field, time) => {
    if (typeof name !== 'string' || name === '') return
    const entry = calls[name] || { model: 0, manual: 0, last: 0 }
    entry[field] += 1
    if (typeof time === 'number' && time > entry.last) entry.last = time
    calls[name] = entry
  }

  for (const file of listSessionFiles()) {
    const text = decompressSessionFile(file)
    if (text === null) {
      failed++
      continue
    }
    files++
    for (const line of text.split('\n')) {
      if (line === '') continue
      // 快速跳过不可能相关的事件行
      if (line.indexOf('"skill"') < 0 && line.indexOf('"user/message"') < 0) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch (error) {
        continue
      }
      if (!obj) continue
      if (typeof obj.time === 'number' && obj.time < since) continue

      // ① 模型自主加载
      if (obj.type === 'tool/call') {
        const data = obj.data
        if (!data || data.name !== 'skill') continue
        let args
        try {
          args = JSON.parse(data.arguments || '{}')
        } catch (error) {
          continue
        }
        bump(args && args.name, 'model', obj.time)
        continue
      }

      // ② 用户显式调用 /技能名
      if (obj.type === 'user/message') {
        const content = obj.data && obj.data.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
          const body = block.text
          // 系统注入的技能目录 / 技能正文，不算用户调用
          if (body.indexOf('<system-reminder>') >= 0) continue
          if (body.indexOf('<skill_content') >= 0) continue
          // 按 DSH 自己的规则：「以空白为界、指名技能的 /name token」。
          // 前面必须是行首或空白（这样 http://127.0.0.1 里的 // 不会被误判），
          // 后面必须是空白或句读（这样 /etc/passwd 这种路径也不会被当成技能）。
          const pattern = /(^|\s)\/([a-z0-9][a-z0-9._-]*)(?=[\s,，。.!！?？;；:：)）"']|$)/g
          let match = pattern.exec(body)
          while (match !== null) {
            bump(match[2], 'manual', obj.time)
            match = pattern.exec(body)
          }
        }
      }
    }
  }
  return { calls, files, failed }
}

/** 重扫会话日志并刷新缓存（后台调用，失败不影响主功能）。 */
async function refreshSkillUsage() {
  if (statsScanning) return
  statsScanning = true
  try {
    if (!HAS_ZSTD) {
      console.warn('[skill-quickpick] 当前 Node 没有 zstd 解压能力（node '
        + process.versions.node + '），技能使用统计不可用')
      statsCache = { available: false, calls: {}, reason: 'node ' + process.versions.node + ' 缺少 zstd' }
      return
    }
    const stored = readStatsFile() || { since: 0, lastScanAt: 0, calls: {} }
    if (!stored.since) {
      // 统计起点 = 安装插件那天的 0 点。这样刚装完就能看到当天的调用记录，
      // 而不是等「从现在起」才有数据；装上之前的历史不算。
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      stored.since = now.getTime()
    }
    const started = Date.now()
    const result = scanSkillUsage(stored.since)
    stored.calls = result.calls
    stored.lastScanAt = Date.now()
    writeStatsFile(stored)
    statsCache = {
      available: true,
      since: stored.since,
      calls: result.calls,
      files: result.files,
      failed: result.failed,
      tookMs: Date.now() - started,
      at: Date.now(),
    }
    console.log('[skill-quickpick] 使用统计：扫描 ' + result.files + ' 个会话（失败 '
      + result.failed + '），' + Object.keys(result.calls).length + ' 个技能有调用记录，耗时 '
      + (Date.now() - started) + 'ms')
  } catch (error) {
    console.warn('[skill-quickpick] 统计刷新失败：' + (error && error.message ? error.message : error))
  } finally {
    statsScanning = false
  }
}

// ── 技能卸载 + 回收站 ─────────────────────────────────────────────────
//
// 卸载不是真删：把整个技能目录 rename 进 dsh-home/skill-quickpick-trash/<id>/，
// 索引记在 skill-quickpick-trash.json。恢复 = rename 回去；永久删除才 rmSync。

function trashDir() {
  return join(dshHome(), TRASH_DIR_NAME)
}

function trashIndexPath() {
  return join(dshHome(), TRASH_INDEX_NAME)
}

/** 回收站保留期：默认 7 天，可调范围 1 ~ 360 天。 */
const TRASH_DEFAULT_RETENTION_DAYS = 7
const TRASH_MIN_RETENTION_DAYS = 1
const TRASH_MAX_RETENTION_DAYS = 360
const TRASH_MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * 一条回收站记录的「计时起点」。
 *
 * 取 max(删除时间, retentionFrom)。每次**改保留期都会把 retentionFrom 设成当前时间**，
 * 于是所有条目重新开始计时 —— 这样把 7 天改成 1 天永远不会立刻删掉任何东西，
 * 「静默永久删除」的后门从根上就不存在了。要真想删，只能等够自己设的天数。
 */
function trashEntryStart(item, retentionFrom) {
  const deletedAt = item && typeof item.deletedAt === 'number' ? item.deletedAt : 0
  const resetAt = typeof retentionFrom === 'number' ? retentionFrom : 0
  return Math.max(deletedAt, resetAt)
}

/** 某一项是否已经超过保留期。 */
function isTrashExpired(item, retentionDays, retentionFrom) {
  const start = trashEntryStart(item, retentionFrom)
  if (start <= 0) return false
  return start < Date.now() - retentionDays * TRASH_MS_PER_DAY
}

function readTrashIndex() {
  try {
    const p = trashIndexPath()
    if (!existsSync(p)) {
      return { retentionDays: TRASH_DEFAULT_RETENTION_DAYS, retentionFrom: 0, lastCheckAt: 0, items: [] }
    }
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : []
    const raw = parsed && Number.isFinite(parsed.retentionDays) ? parsed.retentionDays : TRASH_DEFAULT_RETENTION_DAYS
    const retentionDays = Math.min(TRASH_MAX_RETENTION_DAYS, Math.max(TRASH_MIN_RETENTION_DAYS, Math.floor(raw)))
    const retentionFrom = parsed && Number.isFinite(parsed.retentionFrom) ? parsed.retentionFrom : 0
    // lastCheckAt 必须原样读回来：cleanupExpiredTrash 靠它做时钟连续性校验。
    // 早期这里漏了这个字段，读回来永远是 undefined/0 → 校验条件 `lastCheckAt > 0`
    // 永不成立 → 时钟前跳/倒退的防护完全失效（测试抓到的真实 bug，2026-11 修）。
    const lastCheckAt = parsed && Number.isFinite(parsed.lastCheckAt) ? parsed.lastCheckAt : 0
    return { retentionDays, retentionFrom, lastCheckAt, items }
  } catch (error) {
    console.warn('[skill-quickpick] 读回收站索引失败：' + (error && error.message ? error.message : error))
    return { retentionDays: TRASH_DEFAULT_RETENTION_DAYS, retentionFrom: 0, lastCheckAt: 0, items: [] }
  }
}

function writeTrashIndex(next) {
  try {
    const p = trashIndexPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileAtomic(p, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch (error) {
    console.warn('[skill-quickpick] 写回收站索引失败：' + (error && error.message ? error.message : error))
    return false
  }
}

/**
 * 按保留期清理过期项。
 *
 * 这是「二次回收站」的核心：**不给用户手动永久删除的入口**，只能等时间到期。
 * 防的是冲动删除——上头删了，过两天想起来还能恢复；真不要了，等它自己过期。
 *
 * 由后台定时器调用（不再由 GET 触发 —— GET 必须只读）。
 *
 * **时钟防护**：计时用的是系统时间（`Date.now()`），用户把系统时间调到未来会让
 * 所有项瞬间过期、调到过去则永远不过期。所以这里拿「上次检查时间」做连续性校验：
 * 时间倒退、或单次跳跃超过 30 天，都说明时钟被动过，**本轮直接跳过清理**，
 * 宁可晚删一天，也不能因为时钟异常误删用户的技能。
 */
function cleanupExpiredTrash(index) {
  const now = Date.now()
  const lastCheckAt = typeof index.lastCheckAt === 'number' ? index.lastCheckAt : 0
  const days = Math.min(
    TRASH_MAX_RETENTION_DAYS,
    Math.max(TRASH_MIN_RETENTION_DAYS, Math.floor(index.retentionDays || TRASH_DEFAULT_RETENTION_DAYS)),
  )

  // 时钟连续性校验：允许的跳跃上限应该**等于**保留期，不能再小。
  //
  // 这里踩过两个坑：
  //   ① 第一版写成 1.5 × days（比保留期大）—— 时间前跳「超过保留期但没到 1.5 倍」时，
  //      既通过检查又让条目全过期被删。
  //   ② 第二版改成 0.5 × days —— 又太小：保留期 1 天时阈值只有 12 小时，
  //      笔记本睡眠一晚、或每天只开一次 DSH 的用户，每次启动都算「跳跃过大」→ 永远跳过
  //      → 回收站只增不减（正是下面那段注释想避免的反效果）。
  //
  // 正确值是 `= days`：条目过期需要 now > start + days ≥ lastCheckAt + days，
  // 所以「跳跃 ≤ days」时不可能有任何条目过期，这个边界既安全又不误拦。
  const maxJumpMs = Math.max(1, days) * TRASH_MS_PER_DAY
  let skipReason = ''
  if (lastCheckAt > 0) {
    if (now < lastCheckAt) skipReason = '检测到系统时间倒退'
    else if (now - lastCheckAt > maxJumpMs) skipReason = '系统时间跳跃超过 ' + (maxJumpMs / TRASH_MS_PER_DAY).toFixed(1) + ' 天'
  }
  if (skipReason !== '') {
    console.warn('[skill-quickpick] ' + skipReason + '，本轮跳过回收站清理')
    // **关键**：跳过时也要推进 lastCheckAt，否则这个条件永远成立 → 清理永久停摆，
    // 回收站只增不减（安全评审指出过这个反效果）。
    index.lastCheckAt = now
    writeTrashIndex(index)
    return []
  }
  index.lastCheckAt = now

  const retentionFrom = typeof index.retentionFrom === 'number' ? index.retentionFrom : 0
  const trashRoot = resolve(trashDir())
  const kept = []
  const purged = []
  for (const item of index.items) {
    // **路径边界**：trashPath 来自普通 JSON 文件，可能被改坏或篡改。
    // 直接把它交给 rmSync(recursive) 等于把索引文件变成"删除任意目录"的原语，
    // 而且触发点是插件自己的定时器（重启 15 秒后就会跑，不需要用户操作）。
    if (!isInsideTrash(item && item.trashPath, trashRoot)) {
      console.warn('[skill-quickpick] 回收站索引里有越界路径，已跳过该项：'
        + (item && item.name ? item.name : '(无名)'))
      kept.push(item)
      continue
    }
    if (isTrashExpired(item, days, retentionFrom)) {
      try {
        rmSync(item.trashPath, { recursive: true, force: true })
      } catch (error) {
        /* 文件已经不在了也无所谓 */
      }
      purged.push(item)
    } else {
      kept.push(item)
    }
  }
  index.items = kept
  // 每次都写回：即使没删东西也要记住 lastCheckAt，下次才能做连续性校验
  writeTrashIndex(index)
  if (purged.length > 0) {
    console.log('[skill-quickpick] 回收站自动清理 ' + purged.length + ' 项（超过 ' + days + ' 天）：'
      + purged.map((x) => x && x.name).join(', '))
  }
  return purged
}

/**
 * 判断某个路径是否**严格位于回收站目录之内**（用于清理前的最后一道防线）。
 *
 * 用 **realpath** 而不是 resolve：resolve 只做字符串归一化，回收站里放一个
 * junction 指向 `D:\important-files`，索引里的 trashPath 指向它时 resolve 后仍显示在
 * 回收站内、检查会通过。realpath 会把链接解析到真实目标，从而拒绝。
 *
 * 任何异常（路径不存在、链接断裂、根目录不可访问）一律视为不安全。
 */
function isInsideTrash(candidate, realTrashRoot) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return false
  // **碰文件系统之前**先挡住网络路径。realpathSync 对 `\\attacker\share\x` 会真的发起
  // SMB 连接（强制 NTLM 认证泄露，还可能卡住事件循环），等它失败再判 false 就已经晚了。
  // 这个函数被后台定时清理每 6 小时调用一次，所以泄漏是周期性的。
  // 拒绝：UNC（`\\`、`//`）、设备/扩展前缀（`\\?\`、`\\.\`）、相对路径。
  if (/^[\\/]{2}/.test(candidate) || candidate.startsWith('\\\\')) return false
  if (!/^[A-Za-z]:[\\/]/.test(candidate)) return false
  try {
    const realRoot = realpathSync(resolve(realTrashRoot))
    const realTarget = realpathSync(resolve(candidate))
    const rel = relative(realRoot, realTarget)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch (error) {
    return false
  }
}

/**
 * 允许操作的技能根目录（**真实路径**）。
 *
 * 早期只校验「路径形状是 `<任意>/skills/<x>/SKILL.md`」，于是磁盘上任何
 * `D:\work\proj\skills\deploy\SKILL.md` 都被当成合法技能，能改能搬 ——
 * 安全评审把它列为 P1（任意 `**\/skills/*`）。
 *
 * 现在的白名单 = DSH 官方文件系统 skill provider（`@deepseek-ai/dsh-skill-filesystem`）
 * 会扫描的根：
 *
 *   | rank | 来源           | 路径                                    |
 *   |------|----------------|-----------------------------------------|
 *   | 100  | project-dsh    | `<projectRoot>/.dsh/skills`             |
 *   | 200  | project-agents | `<projectRoot>/.agents/skills`          |
 *   | 400  | user-dsh       | `<DSH_HOME>/skills`                     |
 *   | 500  | user-agents    | `<agentsHome>/skills`（默认 ~/.agents） |
 *
 * rank 300 的 `custom`（DSH 配置里的 `customSkillDirs`）这里**故意不认**：
 * 插件读不到 DSH 的配置对象，只能靠猜路径 —— 而「猜出来的可信根」正是
 * 安全评审反对的东西。代价是自定义目录里的技能只能看、不能禁用/卸载。
 *
 * P2 修复（2026-11）：以前只认 `<DSH_HOME>/skills`，所以面板里列出来的项目技能
 * 点得动、服务端却一律 400。项目根不能问客户端要（那等于把权限边界交给请求体），
 * 改成从**磁盘上的会话记录**推：每个 `session.v4.jsonl.zstd` 的第一行 header
 * 是 DSH 自己写的，带 `cwd`；再从 cwd 向上找最近的 `.git` 祖先 —— 和 DSH 的
 * `findProjectRoot` 是同一套规则。
 *
 * 安全要点：这个集合完全由磁盘事实决定，不受 HTTP 请求体影响。能把恶意路径塞进来的人
 * 必须已经能改 dsh-home 的会话文件或项目里的 `.git`，那已经是本地写权限。
 *
 * 解析失败或目录不存在时返回空数组，调用方一律拒绝。
 */

/** 项目根标记。DSH 的 skill provider 默认也只看 `.git`（没有标记就回退到 cwd 本身）。 */
const PROJECT_ROOT_MARKERS = ['.git']
/** 会话扫描上限：只解压最近这么多个会话的 header，老项目多半已经删了。 */
const PROJECT_ROOT_SCAN_LIMIT = 200
/** 项目根缓存的存活时间。新开一个项目 → 最迟 60 秒后能识别，不用重启插件。 */
const PROJECT_ROOT_TTL_MS = 60 * 1000
/** 读会话 header 时最多读这么多字节：第一帧只装 header，远小于这个数。 */
const SESSION_HEADER_PROBE_BYTES = 64 * 1024

/** 项目根缓存：`{ at, value }`。测试用 `clearProjectRootsCache()` 手动失效。 */
let projectRootsCache = { at: 0, value: [] }

/** 用户级 agents 根。DSH 用 `DSH_AGENTS_HOME` 覆盖，默认 `~/.agents`。 */
function agentsHome() {
  const fromEnv = process.env.DSH_AGENTS_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.agents')
}

/**
 * 只解压会话文件的**第一帧**，从 header 里取 `cwd`。
 *
 * 会话文件是多帧 zstd 的 JSONL，第一行是 `{"type":"session",...,"cwd":"..."}`。
 * 读整个文件没必要（有的几十 MB），只读开头一小段就够定位第一帧。
 * 任何一步失败都返回 ''，调用方跳过 —— 会话文件坏了不该影响插件主流程。
 */
function readSessionHeaderCwd(filePath) {
  if (!HAS_ZSTD) return ''
  let fd
  let got = 0
  const probe = Buffer.alloc(SESSION_HEADER_PROBE_BYTES)
  try {
    fd = openSync(filePath, 'r')
    got = readSync(fd, probe, 0, SESSION_HEADER_PROBE_BYTES, 0)
  } catch (error) {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch (error) { /* 关闭失败无所谓 */ }
    }
  }
  if (got <= 0) return ''
  const buf = probe.subarray(0, got)
  const length = frameLength(buf, 0)
  // -1：不是 zstd 帧；> got：第一帧比探测窗口还大（不该发生），跳过
  if (length <= 0 || length > got) return ''
  let text
  try {
    text = zlib.zstdDecompressSync(buf.subarray(0, length)).toString('utf8')
  } catch (error) {
    return ''
  }
  const firstLine = text.split('\n', 1)[0]
  if (firstLine === '') return ''
  let header
  try {
    header = JSON.parse(firstLine)
  } catch (error) {
    return ''
  }
  if (!header || header.type !== 'session') return ''
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  // 只接受本地盘符绝对路径：UNC 会话 cwd 会让下面的 existsSync 去连 SMB（泄露 NTLM）
  if (!/^[A-Za-z]:[\\/]/.test(cwd)) return ''
  return cwd
}

/**
 * 从 cwd 向上找项目根：最近的、含 `.git` 的祖先；一路到盘符根都没有就回退 cwd。
 *
 * 回退 cwd 是 DSH 自己的行为（`findProjectRoot` 没有标记时返回传入的 cwd），
 * 这里保持一致 —— 否则没有 `.git` 的工作区（比如刚建的目录）里的项目技能会
 * 出现「DSH 能看到、夸克面板却不让动」的割裂。
 */
function findProjectRootOf(cwd) {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        if (existsSync(join(current, marker))) return current
      } catch (error) { /* 单个标记探测失败当没有 */ }
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** 扫一遍最近的会话，收集 DSH 打开过的所有项目根（真实路径）。 */
function collectProjectRoots() {
  const roots = new Set()
  let files
  try {
    files = listSessionFiles()
  } catch (error) {
    return []
  }
  const recent = []
  for (const file of files) {
    try {
      recent.push({ file, mtime: statSync(file).mtimeMs })
    } catch (error) { /* 读不到 mtime 的跳过 */ }
  }
  recent.sort((left, right) => right.mtime - left.mtime)
  for (const entry of recent.slice(0, PROJECT_ROOT_SCAN_LIMIT)) {
    const cwd = readSessionHeaderCwd(entry.file)
    if (cwd === '') continue
    const projectRoot = findProjectRootOf(cwd)
    if (projectRoot !== '') roots.add(projectRoot)
  }
  return Array.from(roots)
}

/**
 * 缓存版的项目根列表。
 *
 * 每次禁用/卸载都扫一遍几百个会话文件太浪费；而「用户新开了一个项目」这种事
 * 也不值得做文件监视。60 秒的 TTL 是折衷：新项目最迟一分钟内可用，不用重启 DSH。
 */
function projectSkillRoots() {
  const now = Date.now()
  if (now - projectRootsCache.at < PROJECT_ROOT_TTL_MS && projectRootsCache.at > 0) {
    return projectRootsCache.value
  }
  const value = collectProjectRoots()
  projectRootsCache = { at: now, value }
  return value
}

/** 让项目根缓存立即失效（测试用；生产里靠 TTL 过期）。 */
function clearProjectRootsCache() {
  projectRootsCache = { at: 0, value: [] }
}

function allowedSkillRoots() {
  const roots = []
  // fail-safe：DSH_HOME 没设置时**一个根都不认**。
  // 以前 `dshHome()` 会回落到 '.', 于是从仓库根目录启动时，<cwd>/skills 就成了可信根 ——
  // 克隆一个带 skills/ 的仓库在那里跑，里面的技能就能被改写/搬走/到期永久删。
  const home = process.env.DSH_HOME || process.env.DSH_PROFILE_DIR
  if (!home) {
    console.warn('[skill-quickpick] 未设置 DSH_HOME / DSH_PROFILE_DIR，拒绝一切技能文件操作')
    return roots
  }
  const candidates = [
    // 用户级（rank 400）
    join(home, 'skills'),
  ]
  try {
    // 用户级 agents（rank 500）：默认 ~/.agents/skills
    candidates.push(join(agentsHome(), 'skills'))
  } catch (error) {
    /* 拿不到 home 就当没有这一级 */
  }
  // 项目级（rank 100 / 200）：每个 DSH 打开过的项目各两个根
  let projectRoots = []
  try {
    projectRoots = projectSkillRoots()
  } catch (error) {
    console.warn('[skill-quickpick] 扫描项目根失败：' + (error && error.message ? error.message : error))
  }
  for (const projectRoot of projectRoots) {
    candidates.push(join(projectRoot, '.dsh', 'skills'))
    candidates.push(join(projectRoot, '.agents', 'skills'))
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      roots.push(realpathSync(candidate))
    } catch (error) {
      /* 单个根坏掉不影响其它根 */
    }
  }
  return roots
}

/**
 * 校验客户端传来的技能文件路径，返回真实路径 `{ file, dir }`。
 *
 * 这是整个插件唯一的文件权限边界，必须防住两类攻击（都已被安全评审实测复现）：
 *
 *   1. **任意文件改写**：早期只检查「路径存在、不含 app.asar」，于是传一个随便的
 *      `notes.md` 也能被 toggle 路由改写掉。
 *   2. **路径穿越**：`skills\..\victim\SKILL.md` 这种字符串里含 `/skills/`，
 *      朴素的子串检查会放行，随后整个 victim 目录被移进回收站。
 *
 * 现在的规则是「先解析成真实路径，再逐级核对」：
 *   - basename 必须是 SKILL.md（大小写不敏感）
 *   - realpath 解析符号链接 / junction
 *   - 硬链接数必须为 1（防止把一个外部文件硬链成 SKILL.md 再借道改写）
 *   - 它所在目录的父目录必须在 `allowedSkillRoots()` 里
 *
 * @param {string} skillPath 客户端传来的路径（**不可信**）
 * @param {{ allowUnlock?: boolean }} [options]
 *   `allowUnlock: true` 只给「启用 / 一键恢复」用：允许跳过最后一个「必须在
 *   允许根下」的检查，让项目被删、会话被清理之后仍然解得开锁。方向是**减少**
 *   权限（只删 frontmatter 一行），详见下方例外分支的注释。
 *
 * 违规一律抛错，调用方转成 400。
 */
function resolveSkillFile(skillPath, options) {
  const allowUnlock = !!(options && options.allowUnlock === true)
  if (typeof skillPath !== 'string' || skillPath.trim() === '') {
    throw new Error('缺少技能文件路径')
  }
  const normalized = skillPath.replace(/\\/g, '/').toLowerCase()
  if (normalized.indexOf('app.asar') >= 0 || normalized.indexOf('node_modules/@deepseek-ai/') >= 0) {
    throw new Error('内置技能（打包在 app.asar 里）是只读的')
  }
  // 只接受本地盘符绝对路径：拒绝 UNC（\\server\share）和 \\?\ 前缀 ——
  // 否则可以让宿主去访问攻击者控制的 SMB 共享（强制 NTLM 认证、远端写/改名）。
  if (!/^[A-Za-z]:[\\/]/.test(skillPath) || skillPath.startsWith('\\\\')) {
    throw new Error('拒绝：只接受本地绝对路径')
  }
  if (basename(skillPath).toLowerCase() !== 'skill.md') {
    throw new Error('拒绝：目标不是 SKILL.md')
  }
  let realFile
  try {
    realFile = realpathSync(skillPath)
  } catch (error) {
    throw new Error('技能文件不存在或无法访问')
  }
  // 校验真实目标而不是输入名：输入名可以是 SKILL.md，实际却是指向 agent.yaml 的链接
  if (basename(realFile).toLowerCase() !== 'skill.md') {
    throw new Error('拒绝：真实目标不是 SKILL.md')
  }
  // **硬链接防护**：realpath 对硬链接返回的就是链接自身的路径，basename 永远是
  // SKILL.md，上面的复检挡不住。`fs.linkSync('外部带 frontmatter 的 cfg.yaml',
  // 'skills/a/SKILL.md')` 就能让 toggle 去改写外部文件。正常技能文件 link count = 1。
  try {
    const stats = statSync(realFile)
    if (stats.nlink > 1) throw new Error('拒绝：技能文件有多个硬链接')
  } catch (error) {
    if (error && String(error.message).indexOf('硬链接') >= 0) throw error
    throw new Error('技能文件无法访问')
  }
  const realDir = dirname(realFile)
  const parent = dirname(realDir)
  // 必须直接挂在允许的技能根下面（只认 <DSH_HOME>/skills）
  const roots = allowedSkillRoots()
  const underAllowedRoot = roots.some((root) => {
    try {
      return resolve(parent) === resolve(root)
    } catch (error) {
      return false
    }
  })
  if (!underAllowedRoot) {
    // **解锁例外**：`allowUnlock` 只用于「启用 / 一键恢复」这种**降低权限**的方向。
    //
    // 为什么需要它：禁用一个项目技能后，如果那个项目被删、或者会话记录被 DSH
    // 清理掉，项目根就再也推不出来了 —— 没有这个例外，用户会永久解不开锁
    // （HANDOFF 定的原则：「启用是解锁，必须永远可用」）。
    //
    // 为什么不危险：enabled 方向只会**删掉** frontmatter 里的一行
    // `disable-model-invocation`，不会移动/新建任何文件；而它的输入只有两条来路 ——
    // 用户在面板上点 ↺（传当前技能的 path），或 disabled.json 里我们自己记下的路径。
    // 两者都不是任意 HTTP 请求体能凭空塞进来的。
    if (!allowUnlock) {
      throw new Error('拒绝：这个路径不在允许的技能目录下')
    }
  }
  return { file: realFile, dir: realDir }
}

export function apply(ctx) {
  // 启动自检：如果还有未恢复的禁用记录，说明上次停用 / 卸载插件时没解锁。
  // 插件停用后就没有界面能解这些锁了，所以这里至少要在日志里喊一声。
  try {
    const pending = Object.keys(readDisabled())
    if (pending.length > 0) {
      console.warn('[skill-quickpick] 注意：检测到 ' + pending.length
        + ' 个技能仍处于禁用状态（上次停用或卸载插件时未恢复）：' + pending.join(', '))
      console.warn('[skill-quickpick] 打开技能面板点「全部恢复」即可解开这些锁。')
    }
  } catch (error) {
    /* 自检失败不影响插件主流程 */
  }

  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    console.warn('[skill-quickpick] 宿主没有 webServer，中文翻译路由未注册')
    return
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'only POST' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
        return
      }
      const skills = body && Array.isArray(body.skills) ? body.skills : []
      const cache = readCache()
      const user = readUserOverride()
      const wanted = []
      const seen = new Set()
      for (const item of skills) {
        if (!item || typeof item.name !== 'string' || item.name === '') continue
        if (seen.has(item.name)) continue
        seen.add(item.name)
        // 用户手写过就不用机翻
        if (user[item.name]) continue
        const description = typeof item.description === 'string' ? item.description.trim() : ''
        if (description === '') continue
        // 缓存命中要求「翻译时的原文没变」。技能作者改了 description 之后，
        // 旧译文就过期了，必须重翻 —— 光看名字命中是不够的（A5）。
        const cached = cache[item.name]
        if (cached && cached.source === description) continue
        wanted.push({ name: item.name, description })
        if (wanted.length >= BATCH_LIMIT) break
      }

      // 自动翻译开关：关闭时**绝不调模型**（不把技能名和描述发给任何 provider），
      // 但本地已有的机翻缓存和用户覆盖照常返回 —— 那些是本地文件，不算外发。
      //
      // translated 必须是**真实成功的条数**，不能是 wanted.length：
      // 后者是「打算翻几个」，四条模型链全挂时也会返回 N，客户端就会误报「已补全 N 个」。
      let successCount = 0
      if (readSettings().autoTranslate && wanted.length > 0) {
        const translated = await translateBatch(ctx, wanted)
        const sources = new Map(wanted.map((entry) => [entry.name, entry.description]))
        let dirty = false
        for (const name of Object.keys(translated)) {
          cache[name] = {
            ...translated[name],
            // 记下这次翻译对应的原文，下次原文不变就直接命中
            source: sources.get(name) || '',
            at: Date.now(),
          }
          dirty = true
        }
        if (dirty) writeCache(cache)
        successCount = Object.keys(translated).length
      }

      // 合并：用户覆盖优先，其次机翻；note 只来自用户
      const map = {}
      for (const item of skills) {
        if (!item || typeof item.name !== 'string' || item.name === '') continue
        const name = item.name
        const u = user[name]
        const a = cache[name]
        const merged = {}
        if (u && u.zh) merged.zh = u.zh
        else if (a && a.zh) merged.zh = a.zh
        if (u && u.desc) merged.desc = u.desc
        else if (a && a.desc) merged.desc = a.desc
        if (u && u.note) merged.note = u.note
        if (Object.keys(merged).length === 0) continue
        merged.source = u ? 'user' : 'auto'
        map[name] = merged
      }
      sendJson(res, 200, {
        ok: true,
        map,
        translated: successCount,
        // 客户端用它区分「我们在面板里禁用的」和「作者本来就写成仅用户调用」的
        disabled: Object.keys(readDisabled()),
      })
    },
  }), 'skill-quickpick: translate route')

  // 用户覆盖：保存 / 恢复默认
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: OVERRIDE_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'only POST' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
        return
      }
      const name = body && typeof body.name === 'string' ? body.name : ''
      if (name === '') {
        sendJson(res, 400, { ok: false, error: '缺少技能名' })
        return
      }
      const user = readUserOverride()
      if (body.restore === true) {
        delete user[name]
      } else {
        const entry = {}
        if (typeof body.zh === 'string' && body.zh.trim() !== '') entry.zh = body.zh.trim()
        if (typeof body.desc === 'string' && body.desc.trim() !== '') entry.desc = body.desc.trim()
        if (typeof body.note === 'string' && body.note.trim() !== '') entry.note = body.note.trim()
        if (Object.keys(entry).length === 0) delete user[name]
        else user[name] = entry
      }
      const saved = writeUserOverride(user)
      sendJson(res, saved ? 200 : 500, { ok: saved, name, restore: body.restore === true })
    },
  }), 'skill-quickpick: override route')

  // 技能启用 / 禁用：改写 SKILL.md 的 frontmatter（改前先备份）
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: TOGGLE_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'only POST' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
        return
      }
      const name = body && typeof body.name === 'string' ? body.name : ''
      const skillPath = body && typeof body.path === 'string' ? body.path : ''
      const disable = body && body.disable === true
      // 禁用/启用开关：**只拦「禁用」方向**（disable=true）。
      //
      // 「启用」是解锁动作：降低风险而不是增加风险，而且插件一旦被停用/卸载，
      // 面板是唯一能解锁的地方。如果连解锁都要先开开关，用户关掉开关后就解不开
      // 已经锁上的技能了 —— 所以「全部恢复」和单行 ↺ 都必须永远可用。
      // （客户端也据此渲染 ↺，两边的授权必须对齐，否则就是「点得动但服务器拒绝」。）
      if (disable && !readSettings().disableEnabled) {
        sendJson(res, 403, { ok: false, error: '禁用功能已关闭，可在面板 ⚙ 设置里开启' })
        return
      }
      if (name === '' || skillPath === '') {
        sendJson(res, 400, { ok: false, error: '缺少技能名或文件路径' })
        return
      }
      // 权限边界：路径来自 HTTP 请求体，必须解析成真实路径并确认它确实是 skills/xxx/SKILL.md
      // 启用方向放宽（allowUnlock）：项目被删 / 会话被清理后，项目根推不出来，
      // 但「启用」只是删掉一行禁用标记 —— 不能让用户被永久锁死。
      let resolved
      try {
        resolved = resolveSkillFile(skillPath, { allowUnlock: !disable })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
        return
      }
      const realPath = resolved.file

      let backup = ''
      try {
        // 只在「禁用」时备份：启用只是删掉一行，而禁用时已经存过原始版本了。
        // 备份失败就绝不往下改。
        if (disable) backup = backupSkillFile(realPath, name)
        const original = readFileSync(realPath, 'utf8')
        const next = applyDisableFlag(original, disable)
        if (next !== original) writeFileAtomic(realPath, next)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
        return
      }

      const disabled = readDisabled()
      if (disable) {
        disabled[name] = { path: skillPath, backup, at: Date.now() }
      } else {
        delete disabled[name]
      }
      writeDisabled(disabled)
      sendJson(res, 200, { ok: true, name, disabled: disable, backup })
    },
  }), 'skill-quickpick: toggle route')

  // 一次性恢复所有被禁用的技能（停用 / 卸载插件前先点它）
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RESTORE_ALL_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'only POST' })
        return
      }
      // 这个接口虽然不读 body，但必须过同一道媒体类型校验：
      // 否则任意网页一个普通 <form method="POST"> 就能解掉所有禁用锁（CORS 简单请求不触发预检）
      try {
        await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
        return
      }
      const disabled = readDisabled()
      const names = Object.keys(disabled)
      if (names.length === 0) {
        sendJson(res, 200, { ok: true, restored: [], failed: [], total: 0 })
        return
      }
      const restored = []
      const failed = []
      for (const name of names) {
        const entry = disabled[name] || {}
        const skillPath = typeof entry.path === 'string' ? entry.path : ''
        // **先校验路径再碰文件系统**：反过来的话 existsSync 会先对 UNC 路径发起 SMB 请求
        // （`\\attacker\share\...`），把本机 NTLM 凭据送出去，而校验要等下一步才跑。
        // 恢复方向一律放宽（allowUnlock）：这是解锁动作，项目根读不到也必须能解锁。
        let realPath
        try {
          realPath = resolveSkillFile(skillPath, { allowUnlock: true }).file
        } catch (error) {
          failed.push({ name, error: String(error && error.message || error) })
          continue
        }
        try {
          const original = readFileSync(realPath, 'utf8')
          const next = applyDisableFlag(original, false)
          if (next !== original) writeFileAtomic(realPath, next)
          // 写回后再读一遍确认标记真的没了（frontmatter 解析容忍 BOM）
          const fm = frontmatterOf(readFileSync(realPath, 'utf8'))
          if (fm.matched && /^\s*disable-model-invocation\s*:/m.test(fm.body)) throw new Error('写回后仍检测到标记')
          restored.push(name)
          delete disabled[name]
        } catch (error) {
          failed.push({ name, error: String(error && error.message || error) })
        }
      }
      // 只把成功的从记录里删掉，失败的留着以便下次重试
      writeDisabled(disabled)
      sendJson(res, 200, {
        ok: failed.length === 0,
        restored,
        failed,
        remaining: Object.keys(disabled).length,
      })
    },
  }), 'skill-quickpick: restore-all route')

  // 技能使用统计：启动后异步扫一次，之后每 5 分钟刷新。
  // 定时器**总是创建**，开关状态每次运行时再读 —— 和回收站清理定时器同一个修法：
  // 创建时判断开关的话，「启动时关 → 中途开启」就再也不会扫了，必须重启。
  ctx.effect(() => {
    const run = () => {
      if (!readSettings().statsEnabled) return
      refreshSkillUsage().catch(() => {})
    }
    const boot = setTimeout(run, 5000)
    const timer = setInterval(run, 5 * 60 * 1000)
    return () => { clearTimeout(boot); clearInterval(timer) }
  }, 'skill-quickpick: usage stats timer')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: STATS_ROUTE,
    async handler(req, res) {
      // 开关关闭：直接回「不可用」，连扫描都不做
      if (!readSettings().statsEnabled) {
        sendJson(res, 200, { ok: true, available: false, calls: {}, reason: '统计已关闭' })
        return
      }
      // **GET 必须只读**：这里不再按需重扫。扫描会读几十 MB 会话日志并写盘，
      // 而跨站的 `<img src=".../stats">` 就能触发 —— 等于给任意网页一个免费 DoS 开关。
      // 数据由后台定时器（启动后 5 秒 + 每 5 分钟）刷新，GET 只回报缓存。
      const data = statsCache || {}
      sendJson(res, 200, {
        ok: true,
        available: data.available !== false && HAS_ZSTD,
        since: data.since || 0,
        calls: data.calls || {},
        files: data.files || 0,
        tookMs: data.tookMs || 0,
        reason: data.reason || '',
      })
    },
  }), 'skill-quickpick: stats route')

  // 技能卸载 + 回收站：GET 列清单，POST 做 remove / restore / purge
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: TRASH_ROUTE,
    async handler(req, res) {
      // 卸载/回收站开关关闭：所有操作一律拒绝（连读都不给，避免面板里露出回收站入口）
      if (!readSettings().trashEnabled) {
        sendJson(res, 403, { ok: false, error: '卸载 / 回收站功能已关闭，可在面板设置里开启' })
        return
      }
      if (req.method === 'GET') {
        // 只读：**GET 绝不能修改磁盘**（安全评审指出，一个普通 GET 就能触发永久删除，
        // 等于把删除能力暴露给任何能访问 webServer 的东西）。
        // 过期项由后台定时器清理，GET 只回报「有多少项已过期」。
        const index = readTrashIndex()
        const expired = index.items.filter(
          (item) => isTrashExpired(item, index.retentionDays, index.retentionFrom),
        ).length
        sendJson(res, 200, {
          ok: true,
          items: index.items,
          retentionDays: index.retentionDays,
          expired,
        })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
        return
      }
      const action = body && typeof body.action === 'string' ? body.action : ''
      const index = readTrashIndex()

      // 卸载：整个技能目录移进回收站
      if (action === 'remove') {
        let skillDir
        try {
          // 真实路径校验：必须是 skills/<dir>/SKILL.md，挡掉 `skills\..\victim` 这类穿越
          skillDir = resolveSkillFile(String(body.path || '')).dir
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
          return
        }
        const name = String(body.name || '')
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const id = stamp + '-' + safeName
        const target = join(trashDir(), id)
        try {
          mkdirSync(trashDir(), { recursive: true })
          renameSync(skillDir, target)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: '移动失败：' + (error && error.message || error) })
          return
        }
        index.items.unshift({
          id,
          name,
          originalPath: skillDir,
          trashPath: target,
          deletedAt: Date.now(),
        })
        // 索引写失败必须回滚目录移动，否则技能会变成回收站里的孤儿（UI 里看不到也恢复不了）
        if (!writeTrashIndex(index)) {
          try {
            renameSync(target, skillDir)
          } catch (rollbackError) {
            console.warn('[skill-quickpick] 回滚卸载失败：' + (rollbackError && rollbackError.message || rollbackError))
            sendJson(res, 500, { ok: false, error: '写索引失败且回滚失败，请手动把 ' + target + ' 移回 ' + skillDir })
            return
          }
          sendJson(res, 500, { ok: false, error: '写回收站索引失败，已回滚' })
          return
        }
        console.log('[skill-quickpick] 已卸载技能 ' + name + ' -> 回收站 ' + id)
        // 卸载后这条技能的禁用记录就没意义了：文件已经不在 skills 里，
        // 留着会让 ↺N 永久显示、restore-all 永久报「失败 1 个」（QA D4）。
        const disabledAfterRemove = readDisabled()
        if (Object.prototype.hasOwnProperty.call(disabledAfterRemove, name)) {
          delete disabledAfterRemove[name]
          writeDisabled(disabledAfterRemove)
        }
        sendJson(res, 200, { ok: true, id })
        return
      }

      // 恢复：移回原位置
      if (action === 'restore') {
        const id = String(body.id || '')
        const item = index.items.find((entry) => entry && entry.id === id)
        if (!item) {
          sendJson(res, 404, { ok: false, error: '回收站里没有这一项' })
          return
        }
        // 索引是普通 JSON，两个绝对路径都必须校验后才能动文件。
        //
        // originalPath 只查「父目录叫 skills」是不够的 —— `D:\evil\skills\x` 也能过，
        // 而且 UNC 路径（`\\attacker\share\skills\x`）还能让宿主去连外部 SMB。
        // 必须：本地盘符绝对路径 + 直接挂在**允许的技能根**下面。
        const rawOriginal = String(item.originalPath || '')
        if (!/^[A-Za-z]:[\\/]/.test(rawOriginal) || rawOriginal.startsWith('\\\\')) {
          sendJson(res, 400, { ok: false, error: '回收站记录里的原路径不是本地绝对路径，拒绝恢复' })
          return
        }
        const originalPath = resolve(rawOriginal)
        const allowedRoots = allowedSkillRoots()
        const originalParent = resolve(dirname(originalPath))
        const rootOk = allowedRoots.some((root) => resolve(root) === originalParent)
        if (!rootOk) {
          sendJson(res, 400, { ok: false, error: '回收站记录里的原路径不在允许的技能目录下，拒绝恢复' })
          return
        }
        if (!isInsideTrash(item.trashPath, resolve(trashDir()))) {
          sendJson(res, 400, { ok: false, error: '回收站记录里的存放路径越界，拒绝操作' })
          return
        }
        if (existsSync(originalPath)) {
          sendJson(res, 409, { ok: false, error: '原位置已经有同名目录了，无法恢复' })
          return
        }
        try {
          mkdirSync(dirname(originalPath), { recursive: true })
          renameSync(item.trashPath, originalPath)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: '恢复失败：' + (error && error.message || error) })
          return
        }
        index.items = index.items.filter((entry) => entry && entry.id !== id)
        writeTrashIndex(index)
        console.log('[skill-quickpick] 已从回收站恢复技能 ' + item.name)
        // 恢复后要补回禁用记录：卸载时会删掉 disabled 记录，但 SKILL.md 里的标记
        // 还留在被移走的文件里。不补的话会出现「UI 显示已启用、模型却看不到」的
        // 状态分裂（安全评审 6.3）。这里读一眼标记，还在就重建记录。
        try {
          const restoredFile = join(originalPath, 'SKILL.md')
          if (existsSync(restoredFile)) {
            const fm = frontmatterOf(readFileSync(restoredFile, 'utf8'))
            if (fm.matched && /^\s*disable-model-invocation\s*:/m.test(fm.body)) {
              const disabledNow = readDisabled()
              if (!Object.prototype.hasOwnProperty.call(disabledNow, item.name)) {
                disabledNow[item.name] = { path: restoredFile, backup: '', at: Date.now() }
                writeDisabled(disabledNow)
                console.log('[skill-quickpick] 恢复的技能仍带禁用标记，已补回记录：' + item.name)
              }
            }
          }
        } catch (error) {
          console.warn('[skill-quickpick] 恢复后检查禁用标记失败：' + (error && error.message ? error.message : error))
        }
        sendJson(res, 200, { ok: true })
        return
      }

      // 调整保留天数（最短 1 天）。
      //
      // 注意：**没有 purge（手动永久删除）操作**。这是刻意的设计——回收站是「冷静期」，
      // 只能等时间到期自动清理。否则「上头删掉 → 立刻清空回收站」两步就把安全网绕没了。
      if (action === 'set-retention') {
        const days = Math.floor(Number(body.days))
        if (!Number.isFinite(days) || days < TRASH_MIN_RETENTION_DAYS) {
          sendJson(res, 400, { ok: false, error: '保留天数最少 ' + TRASH_MIN_RETENTION_DAYS + ' 天' })
          return
        }
        index.retentionDays = Math.min(TRASH_MAX_RETENTION_DAYS, days)
        // 关键：改保留期 = 重置所有条目的计时起点。
        // 否则「7 天改 1 天」会让已有项立刻过期，等于一条静默永久删除后门。
        index.retentionFrom = Date.now()
        const saved = writeTrashIndex(index)
        console.log('[skill-quickpick] 回收站保留期设为 ' + index.retentionDays + ' 天，所有条目重新计时')
        sendJson(res, 200, {
          ok: saved,
          retentionDays: index.retentionDays,
          retentionFrom: index.retentionFrom,
          error: saved ? undefined : '保留期已改但写盘失败，重启后可能回退',
        })
        return
      }

      sendJson(res, 400, { ok: false, error: '未知操作：' + action })
    },
  }), 'skill-quickpick: trash route')

  // 回收站过期清理：只在后台定时跑，不由 GET 触发（GET 必须只读）。
  // 卸载/回收站开关关闭时**完全不启动**，连读索引都不做。
  ctx.effect(() => {
    // 定时器**总是创建**，开关状态每次运行时再读。
    // 以前在创建时就判断开关，导致「启动时关 → 中途开启」后台清理永远不跑（只增不减）。
    const run = () => {
      if (!readSettings().trashEnabled) return
      try {
        cleanupExpiredTrash(readTrashIndex())
      } catch (error) {
        console.warn('[skill-quickpick] 回收站定时清理失败：' + (error && error.message ? error.message : error))
      }
    }
    const boot = setTimeout(run, 15000)
    const timer = setInterval(run, 6 * 60 * 60 * 1000)
    return () => { clearTimeout(boot); clearInterval(timer) }
  }, 'skill-quickpick: trash cleanup timer')

  // 功能开关：读 / 写设置
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_ROUTE,
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, settings: readSettings() })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
        return
      }
      // 空 body 会解析成 null；`{}`、`[]` 这种「没有有效开关字段」的请求也要拒绝 ——
      // 它们会把四个开关全写成默认值（false），等于一个空 POST 就静默关掉所有功能。
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { ok: false, error: '缺少请求体（需要包含开关字段的对象）' })
        return
      }
      const knownKeys = Object.keys(DEFAULT_SETTINGS)
      const providedKeys = knownKeys.filter((key) => typeof body[key] === 'boolean')
      if (providedKeys.length === 0) {
        sendJson(res, 400, { ok: false, error: '请求里没有任何开关字段' })
        return
      }
      const beforeSettings = readSettings()
      const saved = writeSettings(body)
      if (saved === null) {
        sendJson(res, 500, { ok: false, error: '写设置文件失败' })
        return
      }
      // 回收站从关到开：重置所有条目的计时起点。
      // 否则「关着 30 天 → 重新打开」会在下一次定时清理（≤6 小时）时把积压的过期项全部删掉，
      // 用户刚打开一个功能就看到回收站被清空 —— 这是一条隐形的批量永久删除路径。
      if (!beforeSettings.trashEnabled && saved.trashEnabled) {
        try {
          const trashIndex = readTrashIndex()
          trashIndex.retentionFrom = Date.now()
          writeTrashIndex(trashIndex)
          console.log('[skill-quickpick] 回收站功能重新开启，已重置所有条目的计时起点')
        } catch (error) {
          console.warn('[skill-quickpick] 重置回收站计时失败：' + (error && error.message ? error.message : error))
        }
      }
      console.log('[skill-quickpick] 设置已更新：卸载/回收站=' + saved.trashEnabled
        + ' 自动翻译=' + saved.autoTranslate + ' 统计=' + saved.statsEnabled)
      sendJson(res, 200, { ok: true, settings: saved })
    },
  }), 'skill-quickpick: settings route')

  // 自定义排序：GET 读，POST 整体覆盖（客户端拖完一次性提交）
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ORDER_ROUTE,
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, order: readOrder() })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error && error.message || error) })
        return
      }
      // 空 body 会静默清空全部排序，必须显式拒绝
      if (body === null || typeof body !== 'object' || !body.order || typeof body.order !== 'object') {
        sendJson(res, 400, { ok: false, error: '缺少 order 字段' })
        return
      }
      const saved = writeOrder(body.order)
      if (saved === null) {
        sendJson(res, 500, { ok: false, error: '写排序文件失败' })
        return
      }
      sendJson(res, 200, { ok: true, order: saved })
    },
  }), 'skill-quickpick: order route')
}

// 仅供隔离测试使用（test-isolated.mjs）。这些是纯函数或只读逻辑，
// 导出它们不会改变生产行为，但能让测试直接验证权限边界和计时算法。
export {
  resolveSkillFile,
  allowedSkillRoots,
  clearProjectRootsCache,
  projectSkillRoots,
  findProjectRootOf,
  readSessionHeaderCwd,
  isInsideTrash,
  trashEntryStart,
  isTrashExpired,
  cleanupExpiredTrash,
  readTrashIndex,
  writeTrashIndex,
  TRASH_DEFAULT_RETENTION_DAYS,
  TRASH_MIN_RETENTION_DAYS,
  TRASH_MAX_RETENTION_DAYS,
  TRASH_MS_PER_DAY,
}
