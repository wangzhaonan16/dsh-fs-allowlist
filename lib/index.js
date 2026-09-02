// dsh-fs-allowlist —— DSH 插件：白名单目录写入免审批
//
// write/edit 工具层：包装 dsh-fs-sandbox 挂载的 ctx.fs.checkedTarget 栅栏方法，
//   目标路径落在白名单内时提前放行（返回与栅栏同款的 canonical 解析结果），
//   其余情况原样委托原栅栏（拒绝→升权→审批链路分毫不变）。
// bash 层：注册 approval/request 瀑布监听器，对 bash 的沙箱升权请求做「路径代答」——
//   升权理由中命中白名单路径时自动 allowed-once（文本启发式，未命中即转人工，失败安全）。
// 配置：$DSH_HOME/fs-allowlist.json，支持热更新（文件变更 3 秒内自动生效 / GUI 修改即时生效）。
// GUI：设置 → 插件 → 目录白名单（客户端半 lib/client.js，经 /api/fs-allowlist/* 管理配置）。
//
// 文件语义（原子写/版本守卫/先读后写/diff 事件）全部位于父类 dsh-fs-local，本插件不触碰。

import { existsSync, readFileSync, realpathSync, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

export const name = 'fs-allowlist'

// fs=沙箱文件服务；webServer=注册管理路由；approval=审批瀑布（bash 代答）
export const inject = ['fs', 'webServer', 'approval']

const STATE_PATH = '/api/fs-allowlist/state'
const UPDATE_PATH = '/api/fs-allowlist/update'

/**
 * 跨平台解析 DSH 主目录（与官方 dsh-home-paths 语义对齐）：
 * $DSH_HOME（非空）优先；否则按平台取桌面版 userData（macOS=~/Library/Application Support、
 * Windows=%APPDATA%、Linux=$XDG_CONFIG_HOME|~/.config 下的 dsh-desktop/harness），
 * 再回退开源版 ~/.dsh/harness 与 ~/.dsh；都不存在时取首个候选（桌面版路径）。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  const home = homedir()
  const candidates = []
  if (process.platform === 'darwin') {
    candidates.push(join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness'))
  } else if (process.platform === 'win32') {
    candidates.push(join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'dsh-desktop', 'harness'))
  } else {
    candidates.push(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'dsh-desktop', 'harness'))
  }
  candidates.push(join(home, '.dsh', 'harness'), join(home, '.dsh'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

function configFile() {
  return join(dshHome(), 'fs-allowlist.json')
}

/**
 * 运行态配置。热更新唯一入口：文件监视与 GUI 写入都落到这里，
 * write/edit 包装器与 bash 代答器每次调用都读最新值，改动即时生效、无需重启。
 */
const runtime = { roots: [], bashAutoApprove: true, file: configFile() }

/** 读配置文件；缺失/非法/字段缺失 → 空白名单 + bash 代答开（等效透明，一键回退） */
function readConfig() {
  try {
    const file = configFile()
    if (!existsSync(file)) return { roots: [], bashAutoApprove: true }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const roots = Array.isArray(raw?.extraWritableRoots)
      ? raw.extraWritableRoots.filter((p) => typeof p === 'string' && (isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)))
      : []
    return { roots, bashAutoApprove: raw?.bashAutoApprove !== false }
  } catch {
    return { roots: [], bashAutoApprove: true }
  }
}

/** 重新加载配置到运行态（canonical 化，与栅栏同语义） */
function reloadRuntime(logger) {
  const cfg = readConfig()
  runtime.roots = cfg.roots.map((p) => canonicalDeep(p))
  runtime.bashAutoApprove = cfg.bashAutoApprove
  logger?.info?.(`[fs-allowlist] 配置加载：白名单 ${runtime.roots.length} 项，bash 代答 ${runtime.bashAutoApprove ? '开' : '关'}`)
}

/** 运行态落盘（GUI 修改后写回文件；watcher 会再触发一次幂等 reload） */
function persistConfig() {
  writeFileSync(configFile(), JSON.stringify({
    extraWritableRoots: runtime.roots,
    bashAutoApprove: runtime.bashAutoApprove
  }, null, 2) + '\n')
}

/**
 * canonical 解析：与栅栏的 fs.resolve 同语义 —— 对「最深已存在祖先」做 realpath，
 * 未存在部分保持词法拼接，防止经 symlink 的路径逃逸。
 */
export function canonicalDeep(p) {
  const abs = resolvePath(p)
  let prefix = abs
  let suffix = ''
  while (!existsSync(prefix)) {
    const parent = dirname(prefix)
    if (parent === prefix) return abs // 已到根仍不存在，退回词法路径
    suffix = '/' + basename(prefix) + suffix
    prefix = parent
  }
  try {
    return realpathSync.native(prefix) + suffix
  } catch {
    return abs
  }
}

/** 路径包含判定：前缀 + 分量边界（/a/bc 不得命中 /a/b） */
export function isUnder(child, root) {
  const c = canonicalDeep(child)
  const r = canonicalDeep(root)
  if (c === r) return true
  const bordered = r.endsWith(sep) ? r : r + sep
  return c.startsWith(bordered)
}

/**
 * 核心包装（纯函数，可脱离 cordis 单测）。
 * @param fs  dsh-fs-sandbox 挂载的 ctx.fs 服务实例
 * @param getRoots 返回当前白名单的函数（每次栅栏调用实时取，支持热更新）
 * @returns true=已包装；false=找不到栅栏方法（透明降级，行为同未安装）
 */
export function wrapCheckedTarget(fs, getRoots) {
  if (typeof fs?.checkedTarget !== 'function') return false
  if (fs.__fsAllowlistWrapped) return true // 幂等：避免重复包装
  const original = fs.checkedTarget.bind(fs)
  fs.checkedTarget = async function (target, sandboxPolicy) {
    // read-only 是更严旋钮，白名单也不放行，交回原检查
    if (sandboxPolicy?.mode === 'read-only') return original(target, sandboxPolicy)
    const roots = getRoots()
    if (roots.length > 0) {
      try {
        // 与栅栏一致：写前重新 canonical 解析，检查用解析后的身份（无 check-here-write-there TOCTOU）
        const fresh = await fs.resolve(target.displayPath)
        for (const root of roots) {
          if (isUnder(fresh.targetKey, root)) return fresh // 白名单命中：等价栅栏的 contained 分支
        }
      } catch {
        // resolve 失败 → 交回原检查给出标准拒绝/错误
      }
    }
    return original(target, sandboxPolicy)
  }
  fs.__fsAllowlistWrapped = true
  return true
}

/**
 * bash 代答判定：升权理由文本中出现任一白名单根（绝对路径或 ~ 缩写形式）。
 * 这是文本启发式：未命中一律转人工审批（失败安全）；命中即信任该条理由。
 */
function reasonHitsWhitelist(reason, roots) {
  if (typeof reason !== 'string' || reason === '') return false
  const home = homedir()
  return roots.some((root) => {
    if (reason.includes(root)) return true
    if (root === home || root.startsWith(home + sep)) {
      if (reason.includes('~' + root.slice(home.length))) return true
    }
    return false
  })
}

// ---------------------------------------------------------------------------
// HTTP 管理路由（供设置页 GUI 调用；仅回环可达）
// ---------------------------------------------------------------------------

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(body)
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 回环围栏（与 dsh-uak 同策略）：peer socket 地址为主、Host 头为辅 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const a = address.toLowerCase()
  if (a === '::1') return true
  const ipv4 = a.startsWith('::ffff:') ? a.slice(7) : a
  const octets = ipv4.split('.')
  return octets.length === 4 && octets[0] === '127' && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function fence(req, res) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    json(res, 403, { ok: false, message: 'forbidden' })
    return false
  }
  const host = typeof req.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : ''
  if (host !== '' && host !== 'localhost' && !isLoopbackAddress(host.split(':')[0])) {
    json(res, 403, { ok: false, message: 'forbidden' })
    return false
  }
  return true
}

function stateView() {
  return { roots: [...runtime.roots], bashAutoApprove: runtime.bashAutoApprove, file: configFile() }
}

function registerRoutes(ctx) {
  ctx.webServer.register({ kind: 'exact', path: STATE_PATH, handler: (req, res) => {
    if (!fence(req, res)) return
    json(res, 200, { ok: true, state: stateView() })
  } })
  ctx.webServer.register({ kind: 'exact', path: UPDATE_PATH, handler: async (req, res) => {
    if (!fence(req, res)) return
    let body
    try { body = JSON.parse(await readBody(req)) } catch { body = {} }
    const action = body?.action
    if (action === 'add') {
      const root = typeof body.root === 'string' ? body.root.trim() : ''
      // 跨平台绝对路径：POSIX（/ 开头）或 Windows 盘符（C:\ / C:/）
      if (root === '' || (!isAbsolute(root) && !/^[a-zA-Z]:[\\/]/.test(root))) {
        json(res, 400, { ok: false, message: '需要绝对路径：macOS/Linux 如 /Users/xxx/目录，Windows 如 D:\\projects\\目录' })
        return
      }
      const canonical = canonicalDeep(root)
      if (!runtime.roots.includes(canonical)) runtime.roots.push(canonical)
    } else if (action === 'remove') {
      const canonical = canonicalDeep(String(body.root ?? ''))
      runtime.roots = runtime.roots.filter((r) => r !== canonical)
    } else if (action === 'setBashAutoApprove') {
      runtime.bashAutoApprove = body.value === true
    } else {
      json(res, 400, { ok: false, message: `未知 action：${String(action)}` })
      return
    }
    try {
      persistConfig()
    } catch (error) {
      json(res, 500, { ok: false, message: `写入配置失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    json(res, 200, { ok: true, state: stateView() })
  } })
}

/** cordis 插件入口（inject 保证 fs/webServer/approval 就绪后才应用） */
export function apply(ctx) {
  reloadRuntime(ctx.logger)

  // 配置文件热更新：手动编辑 fs-allowlist.json 后 3 秒内自动生效，无需重启
  try {
    watchFile(configFile(), { interval: 3000 }, () => reloadRuntime(ctx.logger))
  } catch {
    ctx.logger.warn('[fs-allowlist] 配置文件监视不可用，热更新降级为重启生效')
  }

  // write/edit 层：包装栅栏（getRoots 实时取运行态，支持热更新）
  if (wrapCheckedTarget(ctx.fs, () => runtime.roots)) {
    ctx.logger.info(`[fs-allowlist] write/edit 白名单已生效（${runtime.roots.length} 项）`)
  } else {
    ctx.logger.warn('[fs-allowlist] ctx.fs.checkedTarget 不可用，write/edit 层透明降级（行为同未安装）')
  }

  // bash 层：审批瀑布代答（仅 bash 的沙箱升权；理由命中白名单 → allowed-once，否则转人工）
  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    if (request?.toolName !== 'bash') return next()
    if (!runtime.bashAutoApprove) return next()
    const reason = typeof request.reason === 'string' ? request.reason : ''
    if (!reason.startsWith('escalate sandbox to')) return next()
    if (!reasonHitsWhitelist(reason, runtime.roots)) return next()
    ctx.logger.info(`[fs-allowlist] bash 升权代答：${reason.slice(0, 140)}`)
    return 'allowed-once'
  }), 'fs-allowlist: bash approval answerer')

  // GUI 管理路由
  ctx.effect(() => registerRoutes(ctx), 'fs-allowlist: http routes')
}
