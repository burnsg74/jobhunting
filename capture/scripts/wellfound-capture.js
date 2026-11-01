import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  createJobFitScorerFromText,
  fitFrontmatterEntries,
} from './jobFit.js'

const JOBS_URL = 'https://wellfound.com/jobs'
const JOB_HREF_RE = /^\/jobs\/(\d+)-([^/?#]+)/
const STARTUP_RESULT = 'div[data-test="StartupResult"]'
const TEXT_BODY_LIMIT = 500_000
const SCROLL_STABLE_ROUNDS = 3
const SCROLL_IDLE_MS = 1_800
const MAX_SCROLLS = 80
const DETAIL_WAIT_MS = 8_000
const BETWEEN_JOBS_MS = 800
const CDP_PORT = Number(process.env.WELLFOUND_CDP_PORT ?? 9222)
const MAX_JOBS = process.env.WELLFOUND_MAX_JOBS
  ? Number(process.env.WELLFOUND_MAX_JOBS)
  : Number.POSITIVE_INFINITY
const CHROME_APP = process.env.WELLFOUND_CHROME_APP ?? 'Google Chrome'
const SRC_USER_DIR =
  process.env.WELLFOUND_CHROME_SRC_DIR ??
  path.join(process.env.HOME ?? '', 'Library/Application Support/Google/Chrome')
const USER_DATA_DIR =
  process.env.WELLFOUND_CHROME_USER_DATA_DIR ??
  path.join(process.env.HOME ?? '', 'Library/Application Support/Google/Chrome-Remote')
const KEEP_USER_DATA_DIR = process.env.WELLFOUND_KEEP_USER_DATA_DIR === '1'
// The API (backend/server.js) owns the data. The script only reads known ids and posts new jobs.
const API_URL = (process.env.WELLFOUND_API_URL ?? 'http://127.0.0.1:4002').replace(/\/$/, '')
const PROMPT_FILE = process.env.WELLFOUND_PROMPT_FILE ?? ''
// Network and job JSON dumps are about 7 MB per few runs, so they are off unless asked for.
const SAVE_NETWORK = process.env.WELLFOUND_SAVE_NETWORK === '1'

const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|x-csrf-token|csrf-token)$/i
const SKIP_PROFILE_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'DevToolsActivePort',
  'LOCK',
])

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(
  scriptDir,
  '..',
  'captures',
  'wellfound',
  new Date().toISOString().replaceAll(':', '-'),
)
const networkDir = path.join(outDir, 'network')
const jobsDir = path.join(outDir, 'jobs')

const captures = []
let writeChain = Promise.resolve()
let nextId = 1

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// One JSON line per step on stdout for the API (backend/pulls.js). Everything else is plain log text.

function emit(step) {
  process.stdout.write(`${JSON.stringify(step)}\n`)
}

function sanitizeHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER.test(key) ? '[redacted]' : value
  }
  return out
}

function parseBody(raw) {
  if (raw == null) return { value: null, truncated: false }
  let truncated = false
  let text = raw
  if (text.length > TEXT_BODY_LIMIT) {
    text = text.slice(0, TEXT_BODY_LIMIT)
    truncated = true
  }
  try {
    return { value: JSON.parse(text), truncated }
  } catch {
    return { value: text, truncated }
  }
}

function graphqlOperationName(url, requestBody) {
  if (requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody)) {
    const name = requestBody.operationName
    if (typeof name === 'string' && name) return name
  }
  if (Array.isArray(requestBody)) {
    const names = requestBody
      .map((item) =>
        item && typeof item === 'object' && 'operationName' in item
          ? String(item.operationName ?? '')
          : '',
      )
      .filter(Boolean)
    if (names.length) return names.join('+')
  }
  try {
    const op = new URL(url).searchParams.get('operationName')
    if (op) return op
  } catch {
    // ignore
  }
  return url.includes('graphql') ? 'graphql' : null
}

function isInteresting(response) {
  const type = response.request().resourceType()
  if (type !== 'xhr' && type !== 'fetch') return false
  const url = response.url()
  if (url.includes('graphql')) return true
  const contentType = response.headers()['content-type'] ?? ''
  return contentType.includes('json') || contentType.includes('graphql')
}

function slugFilename(name) {
  return name.replaceAll(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'capture'
}

function readLocalState(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State')
  const raw = JSON.parse(fs.readFileSync(localStatePath, 'utf8'))
  const cache = raw.profile?.info_cache ?? {}
  const profiles = Object.entries(cache).map(([directory, meta]) => ({
    directory,
    name: meta.name ?? directory,
    user: meta.user_name ?? '',
  }))
  return { lastUsed: raw.profile?.last_used ?? 'Default', profiles }
}

function resolveProfile() {
  const { lastUsed, profiles } = readLocalState(SRC_USER_DIR)
  const requested = process.env.WELLFOUND_CHROME_PROFILE ?? lastUsed
  const known = profiles.map((p) => `${p.directory} (${p.name}${p.user ? `, ${p.user}` : ''})`).join('; ')
  console.log(`Chrome profiles: ${known || '(none)'}`)
  const match = profiles.find((p) => p.directory === requested)
  if (!match) {
    throw new Error(`Chrome profile not found: ${requested}. Available: ${known || '(none)'}`)
  }
  return match
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_PROFILE_NAMES.has(entry.name) || entry.name.endsWith('.lock')) continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    try {
      if (entry.isDirectory()) copyDir(from, to)
      else fs.copyFileSync(from, to)
    } catch (err) {
      console.warn(`Skipping ${from}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

function backupSqlite(srcFile, destFile) {
  if (!fs.existsSync(srcFile)) return
  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  const destSql = destFile.replaceAll("'", "''")
  const result = spawnSync('sqlite3', [srcFile], {
    input: `.backup '${destSql}'\n`,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    console.warn(
      `sqlite backup failed for ${srcFile}: ${(result.stderr || result.stdout || 'unknown error').trim()}`,
    )
    fs.copyFileSync(srcFile, destFile)
  }
}

function cloneProfile(srcProfileDir, destProfileDir, srcUserDir, destUserDir) {
  console.log(`Copying ${path.basename(srcProfileDir)} into debug user data dir...`)
  copyDir(srcProfileDir, destProfileDir)
  for (const relative of ['Cookies', path.join('Network', 'Cookies')]) {
    backupSqlite(path.join(srcProfileDir, relative), path.join(destProfileDir, relative))
  }
  const srcLocalState = path.join(srcUserDir, 'Local State')
  const destLocalState = path.join(destUserDir, 'Local State')
  if (fs.existsSync(srcLocalState)) fs.copyFileSync(srcLocalState, destLocalState)
  const srcFirstRun = path.join(srcUserDir, 'First Run')
  const destFirstRun = path.join(destUserDir, 'First Run')
  if (fs.existsSync(srcFirstRun)) fs.copyFileSync(srcFirstRun, destFirstRun)
  else fs.writeFileSync(destFirstRun, '')
}

async function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

async function waitForCdp(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      // waiting for port
    }
    await sleep(500)
  }
  throw new Error(`Chrome CDP did not become ready on port ${port}`)
}

function chromePids() {
  try {
    // macOS pgrep treats argv starting with '-' as flags, so omit the '--' prefix.
    const out = execFileSync('pgrep', ['-f', `user-data-dir=${USER_DATA_DIR}`], {
      encoding: 'utf8',
    })
    return out
      .trim()
      .split('\n')
      .map((line) => Number(line))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

async function openChrome() {
  if (!process.env.HOME) throw new Error('HOME is not set')
  await killChrome()
  if (await portInUse(CDP_PORT)) {
    throw new Error(
      `CDP port ${CDP_PORT} is already in use. Quit leftover Chrome-Remote (or whatever is bound to that port) and retry.`,
    )
  }

  const profile = resolveProfile()
  const srcProfileDir = path.join(SRC_USER_DIR, profile.directory)
  const destProfileDir = path.join(USER_DATA_DIR, profile.directory)
  if (!fs.existsSync(srcProfileDir)) {
    throw new Error(`Chrome profile not found: ${srcProfileDir}`)
  }

  const reuseExisting = KEEP_USER_DATA_DIR && fs.existsSync(destProfileDir)
  if (!reuseExisting) {
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
    fs.mkdirSync(USER_DATA_DIR, { recursive: true })
    cloneProfile(srcProfileDir, destProfileDir, SRC_USER_DIR, USER_DATA_DIR)
  } else {
    console.log(`Reusing existing debug profile at ${destProfileDir}`)
  }

  console.log(
    `Launching ${CHROME_APP} profile "${profile.directory}" (${profile.name}${profile.user ? `, ${profile.user}` : ''})`,
  )
  const opened = spawnSync(
    'open',
    [
      '-na',
      CHROME_APP,
      '--args',
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${USER_DATA_DIR}`,
      `--profile-directory=${profile.directory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      JOBS_URL,
    ],
    { encoding: 'utf8' },
  )
  if (opened.status !== 0) {
    throw new Error(`Failed to open Chrome: ${(opened.stderr || opened.stdout || 'unknown error').trim()}`)
  }

  console.log('Waiting for Chrome to launch...')
  try {
    await waitForCdp(CDP_PORT)
    return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  } catch (err) {
    await killChrome()
    throw err
  }
}

async function killChrome() {
  const pids = chromePids()
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && chromePids().length) {
    await sleep(200)
  }
  for (const pid of chromePids()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  await sleep(300)
}

function enqueueWrite(filePath, data) {
  enqueueWriteText(filePath, JSON.stringify(data, null, 2))
}

function enqueueWriteText(filePath, text) {
  if (!SAVE_NETWORK) return
  writeChain = writeChain.then(async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, text)
  })
}

function writeNetworkIndex() {
  enqueueWrite(
    path.join(networkDir, 'index.json'),
    captures.map(({ requestBody, responseBody, ...meta }) => meta),
  )
}

async function onResponse(response) {
  if (!isInteresting(response)) return
  const request = response.request()
  let requestRaw = null
  try {
    requestRaw = request.postData()
  } catch {
    requestRaw = null
  }
  let responseRaw = null
  try {
    responseRaw = await response.text()
  } catch {
    responseRaw = null
  }
  const reqParsed = parseBody(requestRaw)
  const resParsed = parseBody(responseRaw)
  const operationName = graphqlOperationName(response.url(), reqParsed.value)
  const record = {
    id: nextId++,
    url: response.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status(),
    operationName,
    requestHeaders: sanitizeHeaders(request.headers()),
    responseHeaders: sanitizeHeaders(response.headers()),
    requestBody: reqParsed.value,
    responseBody: resParsed.value,
    truncated: reqParsed.truncated || resParsed.truncated,
    capturedAt: new Date().toISOString(),
  }
  captures.push(record)
  const fileName = `${String(record.id).padStart(3, '0')}-${slugFilename(operationName ?? 'xhr')}.json`
  enqueueWrite(path.join(networkDir, fileName), record)
  writeNetworkIndex()
}

function parseJobHref(href) {
  let pathname = href
  try {
    pathname = new URL(href, JOBS_URL).pathname
  } catch {
    // keep as-is
  }
  const match = JOB_HREF_RE.exec(pathname)
  if (!match) return null
  return { href: pathname, jobId: match[1], slug: match[2] }
}

function graphqlVariables(requestBody) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return null
  const variables = requestBody.variables
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return null
  return variables
}

function requestJobId(requestBody) {
  const variables = graphqlVariables(requestBody)
  const id = variables?.id ?? variables?.jobListingId
  if (typeof id === 'string' && id) return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return null
}

function asJobListing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

function extractJobListing(records, jobId) {
  for (const record of records) {
    if (record.operationName !== 'JobListingModalQuery') continue
    const requested = requestJobId(record.requestBody)
    const body = record.responseBody
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue
    const listing = asJobListing(body.data?.jobListing)
    if (!listing) continue
    const listingId = listing.id == null ? null : String(listing.id)
    if (requested === jobId || listingId === jobId) return listing
  }
  return null
}

async function api(method, pathname, body) {
  let res
  try {
    res = await fetch(`${API_URL}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(
      `Cannot reach the Job Hunting API at ${API_URL} (${err instanceof Error ? err.message : err}). Start it first.`,
    )
  }
  const payload = await res.json().catch(() => null)
  if (!res.ok) throw new Error(payload?.error ?? `API ${method} ${pathname} failed (${res.status})`)
  return payload
}

async function existingJobIds() {
  const { ids } = await api('GET', '/api/jobs/ids')
  return new Set(ids)
}

function loadFitPromptText() {
  if (!PROMPT_FILE) {
    throw new Error('WELLFOUND_PROMPT_FILE is not set (path to evaluate-job-fit.md in the vault)')
  }
  let body
  try {
    body = fs.readFileSync(PROMPT_FILE, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read the fit prompt at ${PROMPT_FILE}: ${err instanceof Error ? err.message : err}`)
  }
  if (!body.trim()) throw new Error(`Fit prompt ${PROMPT_FILE} is empty`)
  return body
}

function locationsOf(listing) {
  const names = [...(listing.locationNames ?? []), ...(listing.acceptedRemoteLocationNames ?? [])]
  return [...new Set(names.filter(Boolean))].join(', ')
}

// POST /api/jobs is idempotent on source_id: returns false when the job was already known.
async function postJob(
  listing,
  href,
  capturedAt,
  evaluation,
  fallbackId,
  fallbackSlug,
) {
  const id = listing.id == null ? fallbackId : String(listing.id)
  const slug = listing.slug || fallbackSlug
  const title = listing.title || slug || 'Job'
  const company = listing.startup?.name || 'Unknown company'
  const jobUrl = `https://wellfound.com${href.startsWith('/') ? href : `/jobs/${id}-${slug}`}`
  const companySlug = listing.startup?.slug
  const companyUrl = companySlug ? `https://wellfound.com/company/${companySlug}` : ''
  const fit = Object.fromEntries(fitFrontmatterEntries(evaluation, capturedAt))
  const { created } = await api('POST', '/api/jobs', {
    source_id: id,
    source: 'Wellfound',
    name: title,
    company,
    url: jobUrl,
    company_url: companyUrl,
    compensation: listing.compensation ?? '',
    equity: listing.equity ?? '',
    job_type: listing.jobType ?? '',
    remote: listing.remote == null ? '' : String(listing.remote),
    experience_min: listing.yearsExperienceMin == null ? '' : String(listing.yearsExperienceMin),
    skills: joinNames(listing.skills),
    locations: locationsOf(listing),
    posted_at: postedAtIso(listing.liveStartAt),
    captured_at: capturedAt,
    // Hard-screen auto-delete from fit scoring: the API writes the deleted event ("Auto: <reason>").
    auto_deleted: fit.deleted_auto === 'true',
    auto_reason: fit.deleted_reason ?? '',
    status_at: fit.status_updated_at ?? '',
    fit_score: fit.fit_score ?? '',
    fit_recommendation: fit.fit_recommendation ?? '',
    fit_overall_match: fit.fit_overall_match ?? '',
    fit_primary_stack: fit.fit_primary_stack ?? '',
    fit_summary: fit.fit_summary ?? '',
    fit_have_skills: fit.fit_have_skills ?? '',
    fit_familiar_skills: fit.fit_familiar_skills ?? '',
    fit_dont_have_skills: fit.fit_dont_have_skills ?? '',
    fit_model: fit.fit_model ?? '',
    fit_evaluated_at: fit.fit_evaluated_at ?? '',
    fit_error: fit.fit_error ?? '',
    posting: listing.description?.trim() ?? '',
  })
  return created
}

function postedAtIso(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000
    return new Date(ms).toISOString()
  }
  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber) && value.trim() !== '') return postedAtIso(asNumber)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return ''
}

function yamlScalar(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  if (/[\n\r]|: |^[&*!|>'"%@`[{]/.test(text) || text !== text.trim()) return JSON.stringify(text)
  return text
}

function joinNames(values) {
  if (!Array.isArray(values)) return ''
  return values
    .map((item) => (typeof item === 'string' ? item : item?.displayName))
    .filter((item) => Boolean(item))
    .join(', ')
}

function toMarkdown(
  listing,
  href,
  capturedAt,
  evaluation,
) {
  const id = listing.id == null ? '' : String(listing.id)
  const slug = listing.slug || ''
  const title = listing.title || slug || 'Job'
  const company = listing.startup?.name || 'Unknown company'
  const jobUrl = `https://wellfound.com${href.startsWith('/') ? href : `/jobs/${id}-${slug}`}`
  const companySlug = listing.startup?.slug
  const companyUrl = companySlug ? `https://wellfound.com/company/${companySlug}` : ''
  const skills = joinNames(listing.skills)
  const lines = [
    '---',
    `note_type: Job`,
    `name: ${yamlScalar(title)}`,
    `company: ${yamlScalar(company)}`,
    'source: Wellfound',
    `source_id: "${id}"`,
    `url: ${yamlScalar(jobUrl)}`,
    `company_url: ${yamlScalar(companyUrl)}`,
    `compensation: ${yamlScalar(listing.compensation)}`,
    `equity: ${yamlScalar(listing.equity)}`,
    `job_type: ${yamlScalar(listing.jobType)}`,
    `remote: ${listing.remote == null ? '' : String(listing.remote)}`,
    `experience_min: ${listing.yearsExperienceMin == null ? '' : String(listing.yearsExperienceMin)}`,
    `skills: ${yamlScalar(skills)}`,
    `posted_at: ${postedAtIso(listing.liveStartAt)}`,
    `captured_at: ${capturedAt}`,
  ]
  for (const [key, value] of fitFrontmatterEntries(evaluation)) {
    lines.push(`${key}: ${yamlScalar(value)}`)
  }
  lines.push('---', '')
  if (listing.description?.trim()) {
    lines.push(listing.description.trim(), '')
  }
  return lines.join('\n')
}

async function readListings(page) {
  return page.evaluate(({ selector, origin }) => {
    const jobHrefRe = /^\/jobs\/(\d+)-([^/?#]+)/
    const cards = [...document.querySelectorAll(selector)].map((card) => {
      const links = [...card.querySelectorAll('a[href]')]
        .map((a) => {
          const href = a.getAttribute('href') ?? ''
          let pathname = href
          try {
            pathname = new URL(href, origin).pathname
          } catch {
            // keep
          }
          const match = jobHrefRe.exec(pathname)
          if (!match) return null
          return {
            href: pathname,
            jobId: match[1],
            slug: match[2],
            title: (a.textContent ?? '').replace(/\s+/g, ' ').trim(),
          }
        })
        .filter((job) => job !== null)
      const heading =
        card.querySelector('h2, h3, [data-test*="Startup"], a[href^="/company"]')?.textContent ?? ''
      return {
        company: heading.replace(/\s+/g, ' ').trim(),
        text: (card.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000),
        jobs: links,
      }
    })
    const jobUrls = [...new Set(cards.flatMap((card) => card.jobs.map((job) => job.href)))]
    return { cards, jobUrls }
  }, { selector: STARTUP_RESULT, origin: JOBS_URL })
}

async function scrollUntilStable(page) {
  await page.waitForSelector(STARTUP_RESULT, { timeout: 30_000 })
  let stable = 0
  let lastKey = ''
  for (let i = 0; i < MAX_SCROLLS; i++) {
    const { cards, jobUrls } = await readListings(page)
    const key = `${cards.length}:${jobUrls.length}`
    console.log(`Scroll ${i + 1}: ${cards.length} startups, ${jobUrls.length} jobs`)
    if (key === lastKey) {
      stable += 1
      if (stable >= SCROLL_STABLE_ROUNDS) {
        console.log('Listing growth stopped')
        return
      }
    } else {
      stable = 0
      lastKey = key
    }
    await page.evaluate((selector) => {
      const cards = document.querySelectorAll(selector)
      const last = cards[cards.length - 1]
      last?.scrollIntoView({ block: 'end' })
      const overflowParent = last?.parentElement
      if (overflowParent && overflowParent.scrollHeight > overflowParent.clientHeight) {
        overflowParent.scrollTop = overflowParent.scrollHeight
      }
      window.scrollBy(0, window.innerHeight)
    }, STARTUP_RESULT)
    await sleep(SCROLL_IDLE_MS)
  }
  console.warn(`Reached max scrolls (${MAX_SCROLLS})`)
}

async function closeJobDetail(page) {
  await page.keyboard.press('Escape')
  await sleep(400)
  if (!/\/jobs\/\d+-/.test(new URL(page.url()).pathname)) return
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
  await page.waitForSelector(STARTUP_RESULT, { timeout: 15_000 }).catch(() => undefined)
}

async function evaluateFit(fit, posting) {
  if (!fit.scorer) {
    return fit.fallback ? { ok: false, error: fit.fallback, detail: 'scorer unavailable' } : null
  }
  const result = await fit.scorer.evaluate(posting)
  if (!result.ok) {
    console.warn(`Fit scoring failed (${result.error}): ${result.detail}`)
  }
  return result
}

async function captureJobDetails(
  page,
  jobUrls,
  fit,
) {
  const knownIds = await existingJobIds()
  console.log(`Known jobs: ${knownIds.size}`)
  const limit = Math.min(jobUrls.length, MAX_JOBS)
  if (SAVE_NETWORK) fs.mkdirSync(jobsDir, { recursive: true })
  emit({ event: 'listing', total: limit, known: knownIds.size })
  let skipped = 0
  let written = 0
  let failed = 0
  const fitCounts = {}
  for (let i = 0; i < limit; i++) {
    const parsed = parseJobHref(jobUrls[i])
    if (!parsed) continue
    if (knownIds.has(parsed.jobId)) {
      skipped += 1
      console.log(`Job ${i + 1}/${limit}: skip ${parsed.href} (already captured)`)
      emit({ event: 'skip', index: i + 1, total: limit, id: parsed.jobId })
      continue
    }
    const startId = nextId
    const locator = page.locator(`a[href="${parsed.href}"], a[href*="${parsed.href}"]`).first()
    console.log(`Job ${i + 1}/${limit}: ${parsed.href}`)
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 5_000 })
      } else {
        await page.goto(`https://wellfound.com${parsed.href}`, { waitUntil: 'domcontentloaded' })
      }
      const deadline = Date.now() + DETAIL_WAIT_MS
      let listing = null
      while (Date.now() < deadline) {
        listing = extractJobListing(captures.filter((c) => c.id >= startId), parsed.jobId)
        if (listing) break
        await sleep(200)
      }
      if (!listing) {
        listing = extractJobListing(captures, parsed.jobId)
      }
      const related = captures.filter((c) => c.id >= startId)
      enqueueWrite(path.join(jobsDir, `${parsed.jobId}-${slugFilename(parsed.slug)}.json`), related)
      if (!listing) {
        failed += 1
        console.warn(`No JobListingModalQuery for ${parsed.href}`)
        emit({ event: 'failed', index: i + 1, total: limit, id: parsed.jobId, error: 'no job data in the listing modal' })
      } else {
        const capturedAt = new Date().toISOString()
        const evaluation = await evaluateFit(fit, toMarkdown(listing, parsed.href, capturedAt, null))
        const outcome =
          evaluation == null ? 'unscored' : evaluation.ok ? evaluation.computed.recommendation : evaluation.error
        const detail = evaluation?.ok ? `${outcome} ${evaluation.computed.score}/10` : outcome
        fitCounts[outcome] = (fitCounts[outcome] ?? 0) + 1
        const inserted = await postJob(
          listing,
          parsed.href,
          capturedAt,
          evaluation,
          parsed.jobId,
          parsed.slug,
        )
        knownIds.add(parsed.jobId)
        if (inserted) {
          written += 1
          console.log(`Saved job ${parsed.jobId} (${detail})`)
          emit({
            event: 'saved',
            index: i + 1,
            total: limit,
            id: parsed.jobId,
            name: `${listing.title ?? parsed.slug} at ${listing.startup?.name ?? 'unknown'}`,
            fit: detail,
          })
        } else {
          skipped += 1
          console.log(`Job ${parsed.jobId} was already known`)
          emit({ event: 'skip', index: i + 1, total: limit, id: parsed.jobId })
        }
      }
    } catch (err) {
      failed += 1
      console.warn(`Failed ${parsed.href}: ${err instanceof Error ? err.message : err}`)
      emit({
        event: 'failed',
        index: i + 1,
        total: limit,
        id: parsed.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
      enqueueWrite(path.join(jobsDir, `${parsed.jobId}-${slugFilename(parsed.slug)}.json`), {
        error: err instanceof Error ? err.message : String(err),
        captures: captures.filter((c) => c.id >= startId),
      })
    }
    await closeJobDetail(page)
    await sleep(BETWEEN_JOBS_MS)
  }
  return { skipped, written, failed, fitCounts }
}

async function jobsPage(browser) {
  let context = browser.contexts()[0]
  for (let i = 0; i < 20 && !context; i++) {
    await sleep(250)
    context = browser.contexts()[0]
  }
  if (!context) {
    throw new Error('Chrome launched but has no profile context; refusing to open a blank session')
  }
  let page =
    context.pages().find((p) => p.url().includes('wellfound.com')) ?? context.pages()[0]
  if (!page) page = await context.newPage()
  if (!page.url().includes('wellfound.com/jobs')) {
    await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded' })
  }
  return page
}

// Resolved before Chrome launches so a broken prompt file fails the run immediately
// rather than after a full scrape.
async function resolveFitContext() {
  if (process.env.WELLFOUND_SCORE_JOBS === '0') {
    console.log('Job fit scoring disabled (WELLFOUND_SCORE_JOBS=0)')
    return { scorer: null, fallback: null }
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY is not set; jobs will be saved with fit_error: no_api_key')
    return { scorer: null, fallback: 'no_api_key' }
  }
  return { scorer: createJobFitScorerFromText(loadFitPromptText()), fallback: null }
}

let activeBrowser
let cleanedUp = false

// Closes Chrome and removes the temporary profile. Runs from `finally`, and from SIGTERM/SIGINT
// when the API cancels a run or shuts down, so Chrome-Remote never outlives the script.
async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  const browser = activeBrowser
  pageOffSafe(browser)
  try {
    await Promise.race([browser?.close(), sleep(3_000)])
  } catch {
    // ignore
  }
  await killChrome()
  if (!KEEP_USER_DATA_DIR) {
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
      console.log(`Removed temporary user data dir ${USER_DATA_DIR}`)
    } catch (err) {
      console.warn(`Could not remove ${USER_DATA_DIR}: ${err instanceof Error ? err.message : err}`)
    }
  } else {
    console.log(`Keeping debug user data dir ${USER_DATA_DIR}`)
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.warn(`${signal} received; closing Chrome`)
    void cleanup().finally(() => process.exit(signal === 'SIGTERM' ? 143 : 130))
  })
}

async function main() {
  // Fail fast, before launching Chrome, if the API is down.
  await existingJobIds()
  const fit = await resolveFitContext()
  if (SAVE_NETWORK) fs.mkdirSync(networkDir, { recursive: true })
  try {
    const browser = await openChrome()
    activeBrowser = browser
    const page = await jobsPage(browser)
    page.on('response', (response) => {
      void onResponse(response)
    })
    await scrollUntilStable(page)
    const listings = await readListings(page)
    enqueueWrite(path.join(outDir, 'listings.json'), listings)
    const jobStats = await captureJobDetails(page, listings.jobUrls, fit)
    await writeChain
    writeNetworkIndex()
    await writeChain
    const fitSummary = Object.entries(jobStats.fitCounts)
      .map(([outcome, count]) => `${outcome}=${count}`)
      .join(' ')
    console.log(
      `Done: ${listings.jobUrls.length} listing jobs; new=${jobStats.written} known=${jobStats.skipped} failed=${jobStats.failed}${fitSummary ? `; fit ${fitSummary}` : ''}${SAVE_NETWORK ? `; ${captures.length} network captures in ${outDir}` : ''}`,
    )
    emit({ event: 'done', new: jobStats.written, known: jobStats.skipped, failed: jobStats.failed })
  } finally {
    await cleanup()
  }
}

function pageOffSafe(browser) {
  if (!browser) return
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      page.removeAllListeners('response')
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
