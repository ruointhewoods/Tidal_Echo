#!/usr/bin/env bun
/**
 * activity-tailer — surfaces the companion CC session's *thinking* and *tool
 * calls* to the phone PWA, as the small "thinking" blocks and "Claude 看了看
 * 笔记 / 查了下天气" action chips the frontend already knows how to render.
 *
 * WHY a separate sidecar (not part of the channel plugin):
 *   The channel plugin (server.ts) is loaded INSIDE the CC session and can only
 *   send what the AI explicitly calls reply/react/call with — its own thinking
 *   and tool use never leave the session. This process is an external OBSERVER:
 *   it tails the session's transcript JSONL on disk and forwards the interesting
 *   bits to the relay. It does NOT spawn claude, so the login-keychain rule
 *   (only GUI sessions can auth claude) does not apply here.
 *
 *   data flow:
 *     ~/.claude/projects/<proj>/<session>.jsonl   (CC writes as it works)
 *           │  tail new lines
 *           ▼
 *     this process  ──HTTPS POST {RELAY}/channel/out──▶  relay  ──SSE──▶  PWA
 *           · thinking block → {type:"thinking", text}
 *           · tool_use+result → {type:"act", text, glyph, steps:[{tool,cmd,result}]}
 *
 * PREREQUISITE for thinking text to be non-empty: the session must run with
 * thinking summaries on. On 4.7/4.8 the API default is display="omitted" (empty
 * thinking). Either set showThinkingSummaries:true in the session's
 * .claude/settings.json (works because the companion session is interactive) or
 * add `--thinking-display summarized` to its spawn args. Tool calls do not need
 * this; only the thinking text does.
 *
 * Config (env, or the same .env file the channel plugin reads):
 *   RELAY_URL          https://.../relay        (required)
 *   RELAY_SECRET       shared bearer secret      (required)
 *   RELAY_CHAT_ID      chat id echoed on posts   (default "me")
 *   RELAY_TRANSCRIPT_DIR  CC project transcript dir
 *                         (default ~/.claude/projects/-Users-<user>-code-companion-cc)
 *   RELAY_TAILER_POLL_MS  poll interval          (default 1500)
 *
 * Run:  bun run channel/activity-tailer.ts
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

// --- config / secrets -------------------------------------------------------
// Same trick as the channel plugin: a launchd-spawned process inherits no env
// block, so load secrets from the channel's .env file. Real env wins.
const STATE_DIR = process.env.RELAY_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'companion')
const ENV_FILE = join(STATE_DIR, '.env')
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const RELAY = (process.env.RELAY_URL ?? '').replace(/\/+$/, '')
const SECRET = process.env.RELAY_SECRET ?? ''
const CHAT_ID = process.env.RELAY_CHAT_ID ?? 'me'
const POLL_MS = Number(process.env.RELAY_TAILER_POLL_MS ?? 1500)
// thinking summaries come back from the API in English; translate them to Chinese
// via DeepSeek (cheap, strong zh) before forwarding. On by default when a key is
// present; falls back to the original English on any failure.
const DS_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const TRANSLATE_THINKING = (process.env.RELAY_THINKING_TRANSLATE ?? (DS_KEY ? '1' : '0')) !== '0'
const TRANSCRIPT_DIR =
  process.env.RELAY_TRANSCRIPT_DIR ??
  join(homedir(), '.claude', 'projects', `-Users-${basename(homedir())}-code-companion-cc`)
const OFFSET_FILE = join(STATE_DIR, 'tailer_offset.json')

const tlog = (tag: string, msg: string) =>
  process.stderr.write(`[${new Date().toISOString()}] [tailer:${tag}] ${msg}\n`)

if (!SECRET || !RELAY) {
  process.stderr.write(
    `activity-tailer: RELAY_SECRET and RELAY_URL are required (env or ${ENV_FILE})\n`,
  )
  process.exit(1)
}

process.on('unhandledRejection', err => tlog('err', `unhandled rejection: ${err}`))
process.on('uncaughtException', err => tlog('err', `uncaught exception: ${err}`))

// --- relay upstream (AI → relay) -------------------------------------------
async function relayPost(body: unknown): Promise<void> {
  try {
    const res = await fetch(`${RELAY}/channel/out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) tlog('post', `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`)
  } catch (err) {
    tlog('post', `failed: ${err}`)
  }
}

// --- tool → friendly chip (label + glyph) ----------------------------------
// label: a short human phrase; the PWA prefixes the AI's name ("灯灯" + label).
// glyph: one of the frontend's hints — memory|terminal|search|fetch|spark.
type Chip = { label: string; glyph: string; tool: string; cmd: string }

function trunc(s: unknown, n: number): string {
  const t = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function chipFor(name: string, input: Record<string, unknown>): Chip | null {
  // Hide the channel's own outbound tools (they ARE the visible reply/react) and
  // internal plumbing — surfacing them would just be noise.
  if (name.startsWith('mcp__companion__')) return null
  if (name === 'ToolSearch') return null

  const i = input || {}
  switch (name) {
    case 'Bash':
      return { label: '跑了个命令', glyph: 'terminal', tool: 'Bash', cmd: trunc(i.command, 200) }
    case 'Read':
      return { label: '看了看文件', glyph: 'memory', tool: 'Read', cmd: trunc(basename(String(i.file_path ?? '')), 80) }
    case 'Edit':
    case 'Write':
      return { label: '改了点东西', glyph: 'memory', tool: name, cmd: trunc(basename(String(i.file_path ?? '')), 80) }
    case 'Grep':
      return { label: '翻了翻代码', glyph: 'search', tool: 'Grep', cmd: trunc(i.pattern, 80) }
    case 'Glob':
      return { label: '找了找文件', glyph: 'search', tool: 'Glob', cmd: trunc(i.pattern, 80) }
    case 'WebFetch':
      return { label: '查了下网页', glyph: 'fetch', tool: 'WebFetch', cmd: trunc(i.url ?? i.prompt, 200) }
    case 'WebSearch':
      return { label: '搜了下', glyph: 'search', tool: 'WebSearch', cmd: trunc(i.query, 80) }
  }
  // ombre memory tools — keep them warm and legible.
  if (name.startsWith('mcp__') && name.includes('breath'))
    return { label: '翻了翻记忆', glyph: 'memory', tool: 'ombre breath', cmd: trunc(i.query || '(浮现)', 80) }
  if (name.startsWith('mcp__') && name.includes('hold'))
    return { label: '记了一笔', glyph: 'memory', tool: 'ombre hold', cmd: trunc(i.content, 80) }
  if (name.startsWith('mcp__') && name.includes('grow'))
    return { label: '整理了记忆', glyph: 'memory', tool: 'ombre grow', cmd: '' }
  if (name.startsWith('mcp__') && name.includes('dream'))
    return { label: '做了个梦', glyph: 'spark', tool: 'ombre dream', cmd: '' }
  if (name.startsWith('mcp__') && name.includes('trace'))
    return { label: '动了下记忆', glyph: 'memory', tool: 'ombre trace', cmd: '' }
  // any other mcp tool: strip the server prefix to a readable verb.
  if (name.startsWith('mcp__')) {
    const short = name.split('__').pop() || name
    return { label: `用了下 ${short}`, glyph: 'spark', tool: short, cmd: trunc(JSON.stringify(i), 80) }
  }
  return { label: `用了下 ${name}`, glyph: 'spark', tool: name, cmd: trunc(JSON.stringify(i), 80) }
}

// Pull readable text out of a tool_result content block (string | array of parts).
function resultText(block: any): string {
  const c = block?.content
  if (typeof c === 'string') return trunc(c, 1200)
  if (Array.isArray(c)) {
    const txt = c
      .map((p: any) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join(' ')
    return trunc(txt, 1200)
  }
  return ''
}

// Translate an English thinking summary to Chinese via DeepSeek. Skips when
// disabled, when no key, or when the text already contains Chinese. Always
// returns *something* — falls back to the original text on any error/timeout.
const HAS_CJK = /[一-鿿]/
async function translateToZh(text: string): Promise<string> {
  if (!TRANSLATE_THINKING || !DS_KEY || !text || HAS_CJK.test(text)) return text
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.3,
        stream: false,
        messages: [
          { role: 'system', content: '你是翻译器。把用户给的英文翻译成自然、口语化的简体中文，第一人称口吻，只输出译文，不要解释、不要加引号。' },
          { role: 'user', content: text },
        ],
      }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      tlog('tr', `deepseek HTTP ${res.status}`)
      return text
    }
    const data: any = await res.json()
    const out = data?.choices?.[0]?.message?.content
    return typeof out === 'string' && out.trim() ? out.trim() : text
  } catch (err) {
    tlog('tr', `translate failed: ${err}`)
    return text
  }
}

// --- transcript parsing -----------------------------------------------------
// tool_use and its tool_result live on different JSONL lines (assistant message,
// then a later user message). Buffer pending tool_use by id until the result
// arrives, then emit one act chip.
const pending = new Map<string, Chip>()

async function handleLine(line: string): Promise<void> {
  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    return
  }
  const msg = d?.message
  const content = msg?.content
  if (!Array.isArray(content)) return

  if (d.type === 'assistant') {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'thinking') {
        const tx = (b.thinking || '').trim()
        if (tx) await relayPost({ type: 'thinking', text: await translateToZh(tx), chat_id: CHAT_ID })
      } else if (b.type === 'tool_use' && b.id) {
        const chip = chipFor(String(b.name || ''), b.input || {})
        if (chip) pending.set(b.id, chip)
      }
    }
  } else if (d.type === 'user') {
    for (const b of content) {
      if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue
      const chip = pending.get(b.tool_use_id)
      if (!chip) continue
      pending.delete(b.tool_use_id)
      const result = b.is_error ? `(出错) ${resultText(b)}` : resultText(b)
      await relayPost({
        type: 'act',
        text: chip.label,
        glyph: chip.glyph,
        steps: [{ tool: chip.tool, cmd: chip.cmd, result }],
        chat_id: CHAT_ID,
      })
    }
  }
}

// --- file tailing -----------------------------------------------------------
function newestTranscript(): string | null {
  let best: string | null = null
  let bestM = -1
  try {
    for (const f of readdirSync(TRANSCRIPT_DIR)) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(TRANSCRIPT_DIR, f)
      const m = statSync(p).mtimeMs
      if (m > bestM) { bestM = m; best = p }
    }
  } catch (err) {
    tlog('scan', `cannot read ${TRANSCRIPT_DIR}: ${err}`)
  }
  return best
}

function loadOffset(): { file: string; offset: number } {
  try {
    return JSON.parse(readFileSync(OFFSET_FILE, 'utf8'))
  } catch {
    return { file: '', offset: 0 }
  }
}

function saveOffset(file: string, offset: number): void {
  try {
    writeFileSync(OFFSET_FILE, JSON.stringify({ file, offset }), 'utf8')
  } catch (err) {
    tlog('state', `cannot persist offset: ${err}`)
  }
}

// Read the file from `offset` to EOF; process whole lines; return new offset
// (left at the start of any trailing partial line).
async function drain(file: string, offset: number): Promise<number> {
  const size = statSync(file).size
  if (size <= offset) return offset
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    const text = buf.toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl === -1) return offset // no complete line yet
    const complete = text.slice(0, lastNl)
    for (const line of complete.split('\n')) {
      if (line.trim()) await handleLine(line)
    }
    return offset + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
  } finally {
    closeSync(fd)
  }
}

let shuttingDown = false
async function loop(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true })
  const saved = loadOffset()
  let curFile = newestTranscript()
  let offset = 0

  if (curFile) {
    if (saved.file === curFile) {
      offset = saved.offset // resume where we left off
      tlog('boot', `resume ${basename(curFile)} @${offset}`)
    } else {
      // Fresh start on this file. If it's the very first run, skip the backlog by
      // starting at EOF; otherwise (session rotated to a new file) read it whole.
      offset = saved.file ? 0 : statSync(curFile).size
      tlog('boot', `start ${basename(curFile)} @${offset} (${saved.file ? 'new session' : 'skip backlog'})`)
    }
  }

  while (!shuttingDown) {
    try {
      const newest = newestTranscript()
      if (newest && newest !== curFile) {
        // Session restarted → a new transcript. Read the new one from the top.
        tlog('rotate', `→ ${basename(newest)}`)
        curFile = newest
        offset = 0
        pending.clear()
      }
      if (curFile) {
        const next = await drain(curFile, offset)
        if (next !== offset) {
          offset = next
          saveOffset(curFile, offset)
        }
      }
    } catch (err) {
      tlog('loop', `${err}`)
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  tlog('exit', 'shutting down')
  setTimeout(() => process.exit(0), 200)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

tlog('boot', `relay=${RELAY} dir=${TRANSCRIPT_DIR} poll=${POLL_MS}ms`)
void loop()
