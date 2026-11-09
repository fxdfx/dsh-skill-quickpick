// 隔离测试：验证权限边界与保留期计时，**全程在系统临时目录里跑**
//
// 用法：node test-isolated.mjs
//
// 安全说明：这个脚本只操作 os.tmpdir() 下自己建的临时目录，
// 不读不写真实的 dsh-home，也不碰任何真实技能。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, linkSync, readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先把 DSH_HOME 指到临时目录 —— 插件里的技能根 allowlist 只认 `<DSH_HOME>/skills`，
// 不设这个变量的话，下面的临时技能目录会被新的权限边界拒绝（这是预期的收紧）。
const root = mkdtempSync(join(tmpdir(), 'sqp-isolated-'))
process.env.DSH_HOME = root

const mod = await import('./index.js')
const {
  apply,
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
  TRASH_MS_PER_DAY,
  TRASH_MAX_RETENTION_DAYS,
  TRASH_MIN_RETENTION_DAYS,
} = mod

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log('PASS  ' + name)
  } catch (error) {
    failed++
    console.log('FAIL  ' + name)
    console.log('      ' + (error && error.message ? error.message : error))
  }
}

/** 异步版 check：HTTP 路由 handler 是 async 的，异常必须 await 才接得住。 */
async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log('PASS  ' + name)
  } catch (error) {
    failed++
    console.log('FAIL  ' + name)
    console.log('      ' + (error && error.message ? error.message : error))
  }
}

function expectOk(fn) {
  const result = fn()
  if (!result) throw new Error('期望成功，但没有返回值')
  return result
}

function expectThrow(fn, keyword) {
  try {
    fn()
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    if (keyword && message.indexOf(keyword) < 0) {
      throw new Error('抛错但信息不符：期望含「' + keyword + '」，实际是「' + message + '」')
    }
    return
  }
  throw new Error('期望抛错，但没有抛')
}

// ── 搭一个临时技能世界 ──────────────────────────────────────────────
const skillsDir = join(root, 'skills')
const victimDir = join(root, 'victim')

mkdirSync(join(skillsDir, 'test-a'), { recursive: true })
writeFileSync(join(skillsDir, 'test-a', 'SKILL.md'), '---\nname: test-a\ndescription: a\n---\nbody\n')
writeFileSync(join(skillsDir, 'test-a', 'notes.md'), 'not a skill file\n')
mkdirSync(join(skillsDir, 'TestB'), { recursive: true })
writeFileSync(join(skillsDir, 'TestB', 'skill.md'), '---\nname: TestB\n---\n')
mkdirSync(victimDir, { recursive: true })
writeFileSync(join(victimDir, 'SKILL.md'), '---\nname: victim\n---\n')
mkdirSync(join(root, 'notskills', 'x'), { recursive: true })
writeFileSync(join(root, 'notskills', 'x', 'SKILL.md'), '---\nname: x\n---\n')

const okPath = join(skillsDir, 'test-a', 'SKILL.md')
const lowerPath = join(skillsDir, 'TestB', 'skill.md')
const notesPath = join(skillsDir, 'test-a', 'notes.md')
// 必须用**字符串拼接**保留 `..`：join() 会把 '..' 先归一化掉，
// 那样得到的只是「一个不在 skills 下的普通路径」，根本没测到穿越（安全复审指出过）。
const traversalPath = skillsDir + '\\..\\victim\\SKILL.md'
const outsidePath = join(root, 'notskills', 'x', 'SKILL.md')
const missingPath = join(skillsDir, 'nope', 'SKILL.md')

console.log('临时环境: ' + root)
console.log('')

// ── A. 权限边界 ────────────────────────────────────────────────────
console.log('── 权限边界 ──')

check('正常技能 SKILL.md 能解析，返回真实路径', () => {
  const result = expectOk(() => resolveSkillFile(okPath))
  if (result.file !== okPath) throw new Error('返回路径不一致: ' + result.file)
  if (result.dir !== join(skillsDir, 'test-a')) throw new Error('目录不一致: ' + result.dir)
})

check('小写 skill.md 也能识别', () => {
  expectOk(() => resolveSkillFile(lowerPath))
})

check('路径穿越 skills/../victim 必须被拒', () => {
  expectThrow(() => resolveSkillFile(traversalPath), '不在允许的技能目录')
})

check('非 SKILL.md 文件必须被拒', () => {
  expectThrow(() => resolveSkillFile(notesPath), '不是 SKILL.md')
})

check('不在 skills 目录下的 SKILL.md 必须被拒', () => {
  expectThrow(() => resolveSkillFile(outsidePath), '不在允许的技能目录')
})

check('不存在的文件必须被拒', () => {
  expectThrow(() => resolveSkillFile(missingPath), '不存在')
})

check('空路径必须被拒', () => {
  expectThrow(() => resolveSkillFile(''), '缺少')
})

check('app.asar 路径必须被拒', () => {
  expectThrow(() => resolveSkillFile('C:\\x\\app.asar\\skills\\a\\SKILL.md'), '只读')
})

check('node_modules/@deepseek-ai 路径必须被拒', () => {
  expectThrow(() => resolveSkillFile('C:\\x\\node_modules\\@deepseek-ai\\y\\SKILL.md'), '只读')
})

check('UNC 网络路径必须被拒', () => {
  expectThrow(() => resolveSkillFile('\\\\attacker\\share\\skills\\x\\SKILL.md'), '本地绝对路径')
})

check('相对路径必须被拒', () => {
  expectThrow(() => resolveSkillFile('skills/test-a/SKILL.md'), '本地绝对路径')
})

// ── B. 保留期计时 ──────────────────────────────────────────────────
console.log('')
console.log('── 保留期计时 ──')

const NOW = 1_800_000_000_000

check('没有 retentionFrom 时，用删除时间当起点', () => {
  const start = trashEntryStart({ deletedAt: NOW - 1000 }, 0)
  if (start !== NOW - 1000) throw new Error('起点算错: ' + start)
})

check('retentionFrom 更晚时，用它当起点（改保留期会重置计时）', () => {
  const start = trashEntryStart({ deletedAt: NOW - 10 * TRASH_MS_PER_DAY }, NOW - 1000)
  if (start !== NOW - 1000) throw new Error('起点应该取较晚的 retentionFrom，实际: ' + start)
})

check('retentionFrom 更早时，仍用删除时间', () => {
  const start = trashEntryStart({ deletedAt: NOW - 1000 }, NOW - 10 * TRASH_MS_PER_DAY)
  if (start !== NOW - 1000) throw new Error('起点应该是较晚的删除时间，实际: ' + start)
})

check('7 天保留期，刚删的不算过期', () => {
  if (isTrashExpired({ deletedAt: Date.now() - 1000 }, 7, 0)) throw new Error('刚删的判成过期了')
})

check('7 天保留期，8 天前删的算过期', () => {
  if (!isTrashExpired({ deletedAt: Date.now() - 8 * TRASH_MS_PER_DAY }, 7, 0)) {
    throw new Error('8 天前的应该判过期')
  }
})

check('把保留期从 7 天改成 1 天，已有项不会立即过期（计时重置）', () => {
  const deletedAt = Date.now() - 5 * TRASH_MS_PER_DAY
  const retentionFrom = Date.now()
  if (isTrashExpired({ deletedAt }, 1, retentionFrom)) {
    throw new Error('后门还在：改小保留期让旧项立即过期了')
  }
})

check('1 天保留期下，2 天前删的会过期', () => {
  const deletedAt = Date.now() - 2 * TRASH_MS_PER_DAY
  if (!isTrashExpired({ deletedAt }, 1, 0)) throw new Error('2 天前删的，1 天保留期下应该过期')
})

check('保留期范围常量正确（1 ~ 360）', () => {
  if (TRASH_MIN_RETENTION_DAYS !== 1) throw new Error('最小值应为 1，实际 ' + TRASH_MIN_RETENTION_DAYS)
  if (TRASH_MAX_RETENTION_DAYS !== 360) throw new Error('最大值应为 360，实际 ' + TRASH_MAX_RETENTION_DAYS)
})

check('deletedAt 缺失或为 0 时不判过期（保守）', () => {
  if (isTrashExpired({}, 1, 0)) throw new Error('没有删除时间不该判过期')
  if (isTrashExpired({ deletedAt: 0 }, 1, 0)) throw new Error('deletedAt=0 不该判过期')
})

// ── isInsideTrash：网络路径预检（安全终审 P1）────────────────────
// 这组用例必须在 realpathSync 之前就被拒绝，否则测试本身会去连 SMB。
const trashRoot = join(root, 'trash')
const trashItem = join(trashRoot, 'item-1')
mkdirSync(trashItem, { recursive: true })

check('isInsideTrash：回收站内的真实路径 → true', () => {
  if (!isInsideTrash(trashItem, trashRoot)) throw new Error('回收站内的路径应该通过')
})

check('isInsideTrash：回收站外的路径 → false', () => {
  if (isInsideTrash(join(root, 'elsewhere'), trashRoot)) throw new Error('站外路径应该被拒')
})

check('isInsideTrash：UNC 路径直接拒绝（不碰 SMB）', () => {
  for (const bad of ['\\\\attacker\\share\\x', '//attacker/share/x']) {
    if (isInsideTrash(bad, trashRoot)) throw new Error('UNC 应该被拒: ' + bad)
  }
})

check('isInsideTrash：\\\\?\\ 与 \\\\.\\ 设备前缀直接拒绝', () => {
  for (const bad of ['\\\\?\\C:\\x', '\\\\.\\C:\\x']) {
    if (isInsideTrash(bad, trashRoot)) throw new Error('设备前缀应该被拒: ' + bad)
  }
})

check('isInsideTrash：相对路径直接拒绝', () => {
  for (const bad of ['trash/item-1', '..\\trash', '.']) {
    if (isInsideTrash(bad, trashRoot)) throw new Error('相对路径应该被拒: ' + bad)
  }
})

check('isInsideTrash：空值/非字符串直接拒绝', () => {
  for (const bad of ['', '   ', null, undefined, 123]) {
    if (isInsideTrash(bad, trashRoot)) throw new Error('非法输入应该被拒: ' + String(bad))
  }
})

// ── C. 项目技能根（P2 修复）────────────────────────────────────────
// 背景：旧版 allowlist 只认 <DSH_HOME>/skills，面板里列出的「项目技能」能点
// 禁用/卸载，服务端却一律 400。修法是把 DSH 官方 provider 会扫的四级根都认上：
//   <projectRoot>/.dsh/skills、<projectRoot>/.agents/skills、
//   <DSH_HOME>/skills、<agentsHome>/skills
// 项目根本身**不来自请求体**，而是从磁盘上 DSH 自己写的会话 header 里的 cwd 推出来。
console.log('')
console.log('── 项目技能根（P2）──')

if (typeof zlib.zstdCompressSync !== 'function') {
  throw new Error('当前 Node 不支持 zstdCompressSync，无法构造会话文件（需要 Node 22+）')
}

const sessionsRoot = join(root, 'sessions')
/** 造一个最小的 v4 会话文件：第一帧就是 header 那一行。 */
function writeSessionHeader(sessionId, cwd, workspace) {
  const dir = join(sessionsRoot, workspace, sessionId)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id: sessionId, cwd }) + '\n'
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(header, 'utf8')))
}

// 项目 A：有 .git 标记，DSH 会把它当项目技能根
const projA = join(root, 'proj-a')
mkdirSync(join(projA, '.git'), { recursive: true })
mkdirSync(join(projA, '.dsh', 'skills', 'proj-skill'), { recursive: true })
writeFileSync(join(projA, '.dsh', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: proj-skill\ndescription: p\n---\n')
// 项目 B：**没有** .git —— DSH 的 findProjectRoot 回退到 cwd 本身，插件必须一致
const projB = join(root, 'proj-b')
mkdirSync(join(projB, '.dsh', 'skills', 'nogit-skill'), { recursive: true })
writeFileSync(join(projB, '.dsh', 'skills', 'nogit-skill', 'SKILL.md'), '---\nname: nogit-skill\n---\n')
// 项目 C：有 .git，但**没有任何会话指向它** —— 必须不被认，否则就是「任意 .dsh/skills 都能动」
const projC = join(root, 'proj-c')
mkdirSync(join(projC, '.git'), { recursive: true })
mkdirSync(join(projC, '.dsh', 'skills', 'evil-skill'), { recursive: true })
writeFileSync(join(projC, '.dsh', 'skills', 'evil-skill', 'SKILL.md'), '---\nname: evil-skill\n---\n')
// 用户级 agents 根（DSH_AGENTS_HOME 可覆盖，默认 ~/.agents）
const agentsHomeDir = join(root, 'agents-home')
process.env.DSH_AGENTS_HOME = agentsHomeDir
mkdirSync(join(agentsHomeDir, 'skills', 'agents-skill'), { recursive: true })
writeFileSync(join(agentsHomeDir, 'skills', 'agents-skill', 'SKILL.md'), '---\nname: agents-skill\n---\n')

// 会话：项目 A 两条（测去重，其中一条 cwd 在子目录）、项目 B 一条
writeSessionHeader('session-a1', projA, 'ws-a')
writeSessionHeader('session-a2', join(projA, 'sub', 'deep'), 'ws-a')
writeSessionHeader('session-b1', projB, 'ws-b')
writeSessionHeader('session-c-none', projC, 'ws-c') // 占位：稍后删掉，模拟「会话已被清理」
rmSync(join(sessionsRoot, 'ws-c'), { recursive: true, force: true })

clearProjectRootsCache()

check('会话 header 能解出 cwd', () => {
  const cwd = readSessionHeaderCwd(join(sessionsRoot, 'ws-a', 'session-a1', 'session.v4.jsonl.zstd'))
  if (cwd !== projA) throw new Error('cwd 不对: ' + cwd)
})

check('坏文件 / 非会话文件返回空 cwd（不抛错）', () => {
  const bad = join(root, 'not-a-session.bin')
  writeFileSync(bad, 'hello world')
  if (readSessionHeaderCwd(bad) !== '') throw new Error('坏文件不该解出 cwd')
})

check('findProjectRootOf：有 .git 时向上找到项目根', () => {
  const got = findProjectRootOf(join(projA, 'sub', 'deep'))
  if (got !== projA) throw new Error('项目根不对: ' + got)
})

check('findProjectRootOf：没有 .git 时回退 cwd', () => {
  const got = findProjectRootOf(projB)
  if (got !== projB) throw new Error('应回退到 cwd: ' + got)
})

check('projectSkillRoots：只含会话里出现过的项目（且去重）', () => {
  const roots = projectSkillRoots().map((p) => p.toLowerCase())
  if (!roots.includes(projA.toLowerCase())) throw new Error('缺项目 A')
  if (!roots.includes(projB.toLowerCase())) throw new Error('缺项目 B')
  if (roots.includes(projC.toLowerCase())) throw new Error('项目 C 没有会话却被认了')
  if (roots.filter((p) => p === projA.toLowerCase()).length !== 1) throw new Error('项目 A 没去重')
})

check('allowedSkillRoots：用户 / agents / 项目三级根都在', () => {
  const roots = allowedSkillRoots().map((p) => p.toLowerCase())
  const wanted = [
    join(skillsDir).toLowerCase(),
    join(agentsHomeDir, 'skills').toLowerCase(),
    join(projA, '.dsh', 'skills').toLowerCase(),
    join(projB, '.dsh', 'skills').toLowerCase(),
  ]
  for (const want of wanted) {
    if (!roots.includes(want)) throw new Error('缺根: ' + want)
  }
})

check('项目技能（<项目>/.dsh/skills）能通过权限校验', () => {
  const file = join(projA, '.dsh', 'skills', 'proj-skill', 'SKILL.md')
  const result = expectOk(() => resolveSkillFile(file))
  if (result.file !== file) throw new Error('路径不一致: ' + result.file)
  if (result.dir !== join(projA, '.dsh', 'skills', 'proj-skill')) throw new Error('目录不一致: ' + result.dir)
})

check('用户级 agents 技能（<agentsHome>/skills）能通过', () => {
  expectOk(() => resolveSkillFile(join(agentsHomeDir, 'skills', 'agents-skill', 'SKILL.md')))
})

check('没有会话指向的项目不能操作（不是「任意 .dsh/skills」都放行）', () => {
  expectThrow(
    () => resolveSkillFile(join(projC, '.dsh', 'skills', 'evil-skill', 'SKILL.md')),
    '不在允许的技能目录',
  )
})

check('旧式 <任意>/skills 目录仍被拒（P1 边界没有松）', () => {
  const legacy = join(root, 'legacy-proj', 'skills', 'x')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'SKILL.md'), '---\nname: x\n---\n')
  expectThrow(() => resolveSkillFile(join(legacy, 'SKILL.md')), '不在允许的技能目录')
})

check('会话 cwd 是 UNC 时被忽略（不触发 SMB）', () => {
  writeSessionHeader('session-unc', '\\\\attacker\\share\\x', 'ws-unc')
  clearProjectRootsCache()
  const roots = projectSkillRoots()
  if (roots.some((p) => p.startsWith('\\\\'))) throw new Error('UNC 被当成项目根了')
})

// ── D. 解锁例外（allowUnlock）──────────────────────────────────────
// 「启用」是解锁动作，必须永远可用 —— 即使项目被删 / 会话被清理（项目根推不出来）。
// 但放宽只能发生在**启用方向**，且基础防护（本地绝对路径 / 真 SKILL.md / 无硬链接）不变。
console.log('')
console.log('── 解锁例外 ──')

const evilSkill = join(projC, '.dsh', 'skills', 'evil-skill', 'SKILL.md')

check('不在允许根下的 SKILL.md：常规调用仍然拒绝', () => {
  expectThrow(() => resolveSkillFile(evilSkill), '不在允许的技能目录')
})

check('不在允许根下的 SKILL.md：allowUnlock 放行（启用方向）', () => {
  expectOk(() => resolveSkillFile(evilSkill, { allowUnlock: true }))
})

check('allowUnlock 仍然拒绝 UNC 和非 SKILL.md', () => {
  expectThrow(() => resolveSkillFile('\\\\attacker\\share\\SKILL.md', { allowUnlock: true }), '本地绝对路径')
  expectThrow(
    () => resolveSkillFile(join(projC, '.dsh', 'skills', 'evil-skill', 'notes.md'), { allowUnlock: true }),
    '不是 SKILL.md',
  )
})

check('allowUnlock 仍然拒绝硬链接（防护不因解锁而松）', () => {
  const outside = join(root, 'outside-hardlink-target.md')
  writeFileSync(outside, '---\nname: hard\n---\n')
  const hardDir = join(projA, '.dsh', 'skills', 'hard')
  mkdirSync(hardDir, { recursive: true })
  linkSync(outside, join(hardDir, 'SKILL.md'))
  expectThrow(
    () => resolveSkillFile(join(hardDir, 'SKILL.md'), { allowUnlock: true }),
    '硬链接',
  )
})

// ── E. 回收站清理与时钟跳跃阈值 ─────────────────────────────────────
// cleanupExpiredTrash 是「二次回收站」唯一真正永久删除的地方。它靠 lastCheckAt
// 做时钟连续性校验：时间倒退、或单次跳跃超过保留期，就整轮跳过（宁可晚删不误删）。
console.log('')
console.log('── 回收站清理与时钟跳跃 ──')

const ONE_DAY = TRASH_MS_PER_DAY
const trashRootDir = join(root, 'skill-quickpick-trash')

/** 造一条真实的回收站条目（目录里放一个 SKILL.md，模拟被卸载的技能）。 */
function makeTrashItem(id, ageDays) {
  const dir = join(trashRootDir, id)
  mkdirSync(join(dir, 'SKILL.md'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md', 'SKILL.md'), '---\nname: ' + id + '\n---\n')
  return {
    id,
    name: id,
    originalPath: join(skillsDir, id),
    trashPath: dir,
    deletedAt: Date.now() - ageDays * ONE_DAY,
  }
}

check('时钟前跳超过保留期：整轮跳过，条目保留且 lastCheckAt 前进', () => {
  const item = makeTrashItem('clock-jump', 30)
  const before = { retentionDays: 7, retentionFrom: 0, lastCheckAt: Date.now() - 8 * ONE_DAY, items: [item] }
  writeTrashIndex(before)
  const purged = cleanupExpiredTrash(readTrashIndex())
  if (purged.length !== 0) throw new Error('时钟跳 8 天（保留期 7 天）时不该清理，实际清了 ' + purged.length)
  if (!existsSync(item.trashPath)) throw new Error('条目被误删了')
  const after = readTrashIndex()
  if (after.items.length !== 1) throw new Error('索引被改，条目数 ' + after.items.length)
  // 跳过时必须推进 lastCheckAt，否则条件永远成立、清理永久停摆（回收站只增不减）
  if (!(after.lastCheckAt > before.lastCheckAt)) throw new Error('跳过时没有推进 lastCheckAt')
})

check('系统时间倒退：整轮跳过', () => {
  const item = makeTrashItem('clock-back', 30)
  writeTrashIndex({ retentionDays: 7, retentionFrom: 0, lastCheckAt: Date.now() + 5 * ONE_DAY, items: [item] })
  const purged = cleanupExpiredTrash(readTrashIndex())
  if (purged.length !== 0) throw new Error('时间倒退时不该清理')
  if (!existsSync(item.trashPath)) throw new Error('条目被误删了')
})

check('时钟正常前进：过期项被永久删除', () => {
  const item = makeTrashItem('clock-normal', 8)
  writeTrashIndex({ retentionDays: 7, retentionFrom: 0, lastCheckAt: Date.now() - 1 * ONE_DAY, items: [item] })
  const purged = cleanupExpiredTrash(readTrashIndex())
  if (purged.length !== 1) throw new Error('应该清理 1 项，实际 ' + purged.length)
  if (existsSync(item.trashPath)) throw new Error('过期项目录没删掉')
  if (readTrashIndex().items.length !== 0) throw new Error('索引里还留着已清理项')
})

check('跳跃刚好等于保留期：不跳过，但也没有条目会过期', () => {
  const item = makeTrashItem('clock-edge', 5)
  writeTrashIndex({ retentionDays: 7, retentionFrom: 0, lastCheckAt: Date.now() - 7 * ONE_DAY, items: [item] })
  const purged = cleanupExpiredTrash(readTrashIndex())
  if (purged.length !== 0) throw new Error('边界上不该清理')
  if (!existsSync(item.trashPath)) throw new Error('边界条目被误删了')
})

// ── F. HTTP 层与四个开关的拒绝路径 ──────────────────────────────────
// 前面几组测的是纯函数；这里真的把 apply(ctx) 跑起来，注册路由、发假请求，
// 验证「开关关着时服务端真的拒绝」而不是只在界面上藏按钮。
console.log('')
console.log('── HTTP 层与开关拒绝 ──')

function makeMockCtx() {
  const routes = new Map()
  const cleanups = []
  const server = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    webServer: server,
    get(name) { return name === 'webServer' ? server : undefined },
    llm: { stream() { throw new Error('测试里不该调用模型') } },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  return { ctx, routes, cleanups }
}

function makeReq(method, body, options) {
  const opts = options || {}
  const contentType = opts.contentType === undefined ? 'application/json' : opts.contentType
  const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const chunks = payload === '' ? [] : [Buffer.from(payload, 'utf8')]
  return {
    method,
    headers: contentType === null ? {} : { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** 调一条已注册的路由，返回 { status, json }。 */
async function callRoute(routes, path, req) {
  const route = routes.get(path)
  if (!route) throw new Error('路由未注册: ' + path)
  const res = makeRes()
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch (error) { json = null }
  return { status: res.statusCode, json, text: res.body }
}

const mock = makeMockCtx()
apply(mock.ctx)

await checkAsync('apply() 注册了全部 8 条路由', async () => {
  const wanted = [
    '/skill-quickpick/translate',
    '/skill-quickpick/override',
    '/skill-quickpick/toggle',
    '/skill-quickpick/restore-all',
    '/skill-quickpick/stats',
    '/skill-quickpick/trash',
    '/skill-quickpick/settings',
    '/skill-quickpick/order',
  ]
  for (const path of wanted) {
    if (!mock.routes.has(path)) throw new Error('缺路由: ' + path)
  }
})

await checkAsync('toggle：GET → 405', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/toggle', makeReq('GET'))
  if (res.status !== 405) throw new Error('期望 405，实际 ' + res.status)
})

await checkAsync('toggle：非 JSON Content-Type → 400（挡 CSRF 简单请求）', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/toggle', makeReq('POST', 'name=x', { contentType: 'text/plain' }))
  if (res.status !== 400) throw new Error('期望 400，实际 ' + res.status)
})

await checkAsync('toggle：空 body → 400', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/toggle', makeReq('POST'))
  if (res.status !== 400) throw new Error('期望 400，实际 ' + res.status)
})

const projSkillPath = join(projA, '.dsh', 'skills', 'proj-skill', 'SKILL.md')

await checkAsync('toggle：禁用开关关着时 disable=true → 403（服务端拒绝，不只藏按钮）', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/toggle', makeReq('POST', {
    name: 'proj-skill',
    path: projSkillPath,
    disable: true,
  }))
  if (res.status !== 403) throw new Error('期望 403，实际 ' + res.status + ' ' + res.text)
})

await checkAsync('toggle：开关关着时「启用」方向仍然放行（解锁永远可用）', async () => {
  // 手工把技能写成已禁用状态，模拟「上次禁用后插件被停用」
  writeFileSync(projSkillPath, '---\nname: proj-skill\ndescription: p\ndisable-model-invocation: true\n---\n')
  const res = await callRoute(mock.routes, '/skill-quickpick/toggle', makeReq('POST', {
    name: 'proj-skill',
    path: projSkillPath,
    disable: false,
  }))
  if (res.status !== 200 || !res.json || res.json.ok !== true) {
    throw new Error('期望 200 ok，实际 ' + res.status + ' ' + res.text)
  }
  if (/disable-model-invocation/.test(readFileSync(projSkillPath, 'utf8'))) {
    throw new Error('解锁后文件里仍有禁用标记')
  }
})

await checkAsync('settings：{} 被 400 拒绝（空 POST 不能静默关掉全部开关）', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/settings', makeReq('POST', {}))
  if (res.status !== 400) throw new Error('期望 400，实际 ' + res.status)
})

await checkAsync('settings：[] 被 400 拒绝', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/settings', makeReq('POST', []))
  if (res.status !== 400) throw new Error('期望 400，实际 ' + res.status)
})

await checkAsync('settings：可以开启 disableEnabled', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/settings', makeReq('POST', { disableEnabled: true }))
  if (res.status !== 200 || !res.json || res.json.settings.disableEnabled !== true) {
    throw new Error('开启失败：' + res.status + ' ' + res.text)
  }
})

await checkAsync('toggle：项目技能禁用成功（P2 端到端）', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/toggle', makeReq('POST', {
    name: 'proj-skill',
    path: projSkillPath,
    disable: true,
  }))
  if (res.status !== 200 || !res.json || res.json.ok !== true) {
    throw new Error('期望 200 ok，实际 ' + res.status + ' ' + res.text)
  }
  if (!/disable-model-invocation\s*:\s*true/.test(readFileSync(projSkillPath, 'utf8'))) {
    throw new Error('文件里没有写进禁用标记')
  }
})

await checkAsync('restore-all：能把项目技能解锁，且不残留记录', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/restore-all', makeReq('POST', {}))
  if (res.status !== 200 || !res.json) throw new Error('期望 200，实际 ' + res.status)
  if (!Array.isArray(res.json.restored) || res.json.restored.indexOf('proj-skill') < 0) {
    throw new Error('没有恢复 proj-skill：' + JSON.stringify(res.json))
  }
  if (/disable-model-invocation/.test(readFileSync(projSkillPath, 'utf8'))) {
    throw new Error('恢复后文件里仍有禁用标记')
  }
})

await checkAsync('trash：开关关着时 GET 也 403（连回收站入口都不暴露）', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/trash', makeReq('GET'))
  if (res.status !== 403) throw new Error('期望 403，实际 ' + res.status)
})

await checkAsync('stats：开关关着时返回 available:false（只读，不做扫描）', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/stats', makeReq('GET'))
  if (res.status !== 200 || !res.json || res.json.available !== false) {
    throw new Error('期望 200 available:false，实际 ' + res.status + ' ' + res.text)
  }
})

await checkAsync('translate：autoTranslate 关着时不调模型', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/translate', makeReq('POST', {
    skills: [{ name: 'some-skill', description: 'A skill used for testing' }],
  }))
  if (res.status !== 200 || !res.json || res.json.ok !== true) {
    throw new Error('期望 200 ok，实际 ' + res.status + ' ' + res.text)
  }
})

await checkAsync('order：{} 和 [] 都被 400 拒绝（空 POST 不能清空排序）', async () => {
  for (const body of [{}, []]) {
    const res = await callRoute(mock.routes, '/skill-quickpick/order', makeReq('POST', body))
    if (res.status !== 400) throw new Error('body=' + JSON.stringify(body) + ' 期望 400，实际 ' + res.status)
  }
})

// ── G. BOM 兼容 ───────────────────────────────────────────────────
// Windows 记事本、PowerShell 5.1 的 `-Encoding UTF8` 会给文件加 BOM。DSH 的
// frontmatter 解析器容忍它（这类技能照常加载），所以插件也必须容忍 ——
// 否则会出现「模型看得到、面板不让禁用」。（重启真实环境验证时踩到的 bug）
console.log('')
console.log('── BOM 兼容 ──')

const bomSkillDir = join(projB, '.dsh', 'skills', 'bom-skill')
mkdirSync(bomSkillDir, { recursive: true })
const bomSkillFile = join(bomSkillDir, 'SKILL.md')
writeFileSync(bomSkillFile, '\uFEFF---\nname: bom-skill\ndescription: saved with BOM\n---\nbody\n')

await checkAsync('带 BOM 的 SKILL.md 能禁用，且 BOM 保留', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/toggle', makeReq('POST', {
    name: 'bom-skill',
    path: bomSkillFile,
    disable: true,
  }))
  if (res.status !== 200 || !res.json || res.json.ok !== true) {
    throw new Error('期望 200，实际 ' + res.status + ' ' + res.text)
  }
  const after = readFileSync(bomSkillFile, 'utf8')
  if (after.charCodeAt(0) !== 0xFEFF) throw new Error('BOM 被弄丢了')
  if (!/disable-model-invocation\s*:\s*true/.test(after)) throw new Error('禁用标记没写进去')
})

await checkAsync('带 BOM 的 SKILL.md 能启用，BOM 保留且标记删干净', async () => {
  const res = await callRoute(mock.routes, '/skill-quickpick/toggle', makeReq('POST', {
    name: 'bom-skill',
    path: bomSkillFile,
    disable: false,
  }))
  if (res.status !== 200) throw new Error('期望 200，实际 ' + res.status + ' ' + res.text)
  const after = readFileSync(bomSkillFile, 'utf8')
  if (after.charCodeAt(0) !== 0xFEFF) throw new Error('BOM 被弄丢了')
  if (/disable-model-invocation/.test(after)) throw new Error('禁用标记没删干净')
})

// 收尾：把 apply 注册的定时器全部清掉，否则测试进程会挂到 15 秒后
for (const cleanup of mock.cleanups) {
  try { cleanup() } catch (error) { /* 单个清理失败不影响其它 */ }
}

// ── 收尾 ───────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true })
if (existsSync(root)) {
  console.log('\n警告：临时目录没删干净: ' + root)
}

console.log('')
console.log('结果: ' + passed + ' 通过 / ' + failed + ' 失败')
process.exit(failed === 0 ? 0 : 1)
