import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

export const FIT_MODEL = 'claude-haiku-4-5'

const MAX_TOKENS = 2048
// The SDK defaults to 10 minutes, far too long to stall a 100-job scrape on.
const REQUEST_TIMEOUT_MS = 120_000
const PREFILL = '{'
const REPAIR_MESSAGE = 'Your previous response was not valid JSON. Return only the JSON object.'
const HOURS_PER_YEAR = 2080
const MONTHS_PER_YEAR = 12
const SKILLS_THRESHOLD = 0.7
const HIGH_COMP_ANNUAL = 100_000
const EVIDENCE_LIMIT = 300

// The prompt lives in the vault: 10 Clients/Work/Alfred/Job Hunt/8-Prompts/evaluate-job-fit.md
const PROMPT_FILE = process.env.WELLFOUND_PROMPT_FILE ?? ''
const USER_TURN_HEADING = /^# USER TURN TEMPLATE[ \t]*$/m
const POSTING_PLACEHOLDER = '{{POSTING_MARKDOWN}}'

// # OUTPUT SCHEMA, mirrored exactly. Strict objects so extra keys fail validation
// and trigger the repair retry instead of being silently dropped.
const hardScreenItem = z.strictObject({
  result: z.enum(['pass', 'fail', 'unclear']),
  evidence: z.string(),
})

export const jobFitSchema = z.strictObject({
  job: z.strictObject({
    title: z.string(),
    company: z.string(),
    source: z.string().nullable(),
    companyDescription: z.string().nullable(),
  }),
  earlyExit: z.boolean(),
  hardScreen: z.strictObject({
    remoteOnly: hardScreenItem,
    compensation: hardScreenItem,
    timezone: hardScreenItem,
    roleType: hardScreenItem,
  }),
  primaryStack: z.array(z.string()),
  skills: z.array(
    z.strictObject({
      name: z.string(),
      requirement: z.enum(['required', 'nice']),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
      status: z.enum(['HAVE', 'TOUCHED', 'DONT_HAVE']),
      inferred: z.boolean(),
      soft: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
  company: z.strictObject({
    sizeBucket: z.enum(['<50', '50-200', '200+', 'unknown']),
    headcountEvidence: z.string(),
    stage: z.string().nullable(),
    stageEvidence: z.string(),
    isStartupOrSmall: z.enum(['yes', 'no', 'partial', 'unknown']),
    ownershipModel: z.enum(['ownership', 'balanced', 'process', 'unknown']),
    ownershipEvidence: z.string(),
    seniorityFraming: z.enum(['neutral', 'skews_junior', 'skews_senior', 'unknown']),
    seniorityEvidence: z.string(),
    interviewProcess: z.enum(['straightforward', 'complex', 'unknown']),
    interviewEvidence: z.string(),
  }),
  location: z.strictObject({
    companyTimezone: z.string().nullable(),
    remoteStatus: z.enum([
      'remote_us',
      'remote_global',
      'remote_restricted',
      'hybrid',
      'onsite',
      'unknown',
    ]),
    remoteRestriction: z.string().nullable(),
    overlapNote: z.string().nullable(),
    evidence: z.string(),
  }),
  compensation: z.strictObject({
    roleType: z.enum(['full_time', 'contract', 'part_time', 'unknown']),
    hoursPerWeek: z.number().nullable(),
    salaryMin: z.number().nullable(),
    salaryMax: z.number().nullable(),
    salaryPeriod: z.enum(['year', 'hour', 'month']).nullable(),
    currency: z.string(),
    equity: z.string().nullable(),
    evidence: z.string(),
  }),
  summary: z.string(),
})

const HARD_SCREEN_KEYS = ['remoteOnly', 'compensation', 'timezone', 'roleType']

const HARD_SCREEN_LABELS = {
  remoteOnly: 'Remote only',
  compensation: 'Compensation',
  timezone: 'Timezone',
  roleType: 'Role type',
}

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

export function parseFitPrompt(rawWithFrontmatter, label = 'fit prompt') {
  // The prompt lives in the vault as a note, so it starts with YAML frontmatter.
  const raw = rawWithFrontmatter.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
  const heading = USER_TURN_HEADING.exec(raw)
  if (!heading) {
    throw new Error(`Fit prompt ${label} is missing a "# USER TURN TEMPLATE" heading`)
  }

  const system = raw.slice(0, heading.index).replace(/\s*-{3,}\s*$/, '').trim()
  const userTemplate = raw.slice(heading.index + heading[0].length).trim()

  if (!system.includes('# ROLE') || !system.includes('# OUTPUT SCHEMA')) {
    throw new Error(`Fit prompt ${label} is missing the "# ROLE" or "# OUTPUT SCHEMA" section`)
  }
  if (!userTemplate.includes(POSTING_PLACEHOLDER)) {
    throw new Error(`Fit prompt ${label} user turn is missing ${POSTING_PLACEHOLDER}`)
  }

  return { system, userTemplate }
}

export function loadFitPrompt(file = PROMPT_FILE) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(
      `Could not read fit prompt at ${file}: ${err instanceof Error ? err.message : err}`,
    )
  }
  return parseFitPrompt(raw, file)
}

// ---------------------------------------------------------------------------
// Scoring math. The model emits judgments only; everything here is computed.
// ---------------------------------------------------------------------------

function normalizeName(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function statusWeight(status) {
  return status === 'HAVE' ? 1 : status === 'TOUCHED' ? 0.5 : 0
}

function matchPct(skills) {
  if (skills.length === 0) return null
  const total = skills.reduce((sum, skill) => sum + statusWeight(skill.status), 0)
  return total / skills.length
}

function baseScore(requiredMatchPct) {
  if (requiredMatchPct >= 0.9) return 9
  if (requiredMatchPct >= 0.8) return 8
  if (requiredMatchPct >= 0.7) return 7
  if (requiredMatchPct >= 0.6) return 5
  return 3
}

export function annualize(
  salaryMax,
  salaryPeriod,
) {
  if (salaryMax == null || salaryPeriod == null) return null
  if (salaryPeriod === 'hour') return salaryMax * HOURS_PER_YEAR
  if (salaryPeriod === 'month') return salaryMax * MONTHS_PER_YEAR
  return salaryMax
}

function deleteReasonFor(
  fit,
  skills70Pass,
  primaryStackPass,
  missingRequiredSkills,
) {
  if (fit.hardScreen.remoteOnly.result === 'fail') return 'wrong_location'
  if (fit.hardScreen.compensation.result === 'fail') return 'compensation'
  if (fit.hardScreen.roleType.result === 'fail') return 'role_mismatch'
  if (fit.hardScreen.timezone.result === 'fail') return 'wrong_location'
  // The backend rejects missing_skills without names, so fall back when the gap
  // is all TOUCHED rather than DONT_HAVE.
  if ((!skills70Pass || !primaryStackPass) && missingRequiredSkills.length > 0) {
    return 'missing_skills'
  }
  return 'role_mismatch'
}

export function computeFit(fit) {
  const nonSoft = fit.skills.filter((skill) => !skill.soft)
  const requiredNonSoft = nonSoft.filter((skill) => skill.requirement === 'required')

  // With no required non-soft skills there is nothing to divide by, so fall back
  // to the overall match; a posting naming no real tech at all lands at 0.
  const overallMatchPct = matchPct(nonSoft) ?? 0
  const requiredMatchPct = matchPct(requiredNonSoft) ?? overallMatchPct
  const skills70Pass = requiredMatchPct >= SKILLS_THRESHOLD

  const tierByName = new Map(fit.skills.map((skill) => [normalizeName(skill.name), skill.tier]))
  const tier4InStack = fit.primaryStack.filter(
    (entry) => tierByName.get(normalizeName(entry)) === 4,
  ).length
  const primaryStackPass =
    fit.primaryStack.length === 0 || tier4InStack < fit.primaryStack.length / 2

  const hardFail = HARD_SCREEN_KEYS.some((key) => fit.hardScreen[key].result === 'fail')
  const hardScreenFail = hardFail || !skills70Pass || !primaryStackPass

  const annualizedMax = annualize(fit.compensation.salaryMax, fit.compensation.salaryPeriod)
  const hourlyEquivalent = annualizedMax == null ? null : annualizedMax / HOURS_PER_YEAR

  const missingRequiredSkills = requiredNonSoft
    .filter((skill) => skill.status === 'DONT_HAVE')
    .map((skill) => skill.name)

  const scoreBreakdown = []
  let score

  if (hardScreenFail) {
    if (hardFail) {
      score = 0
      scoreBreakdown.push('hard screening criterion failed')
    } else if (!skills70Pass) {
      score = 1
      scoreBreakdown.push(`required skill match below 70% (${formatPct(requiredMatchPct)})`)
    } else {
      score = 2
      scoreBreakdown.push('half or more of the primary stack is tier 4')
    }
  } else {
    score = baseScore(requiredMatchPct)
    scoreBreakdown.push(`base ${score} from ${formatPct(requiredMatchPct)} required match`)

    if (fit.hardScreen.compensation.result === 'unclear') {
      score -= 1
      scoreBreakdown.push('-1 compensation not disclosed')
    }
    if (fit.company.sizeBucket === '<50' || fit.company.ownershipModel === 'ownership') {
      score += 1
      scoreBreakdown.push('+1 small team or ownership culture')
    }
    if (fit.company.ownershipModel === 'process') {
      score -= 1
      scoreBreakdown.push('-1 process-heavy culture')
    }
    if (fit.company.interviewProcess === 'complex') {
      score -= 1
      scoreBreakdown.push('-1 complex interview process')
    }
    if (
      fit.compensation.roleType === 'full_time' &&
      fit.location.remoteStatus === 'remote_us' &&
      annualizedMax != null &&
      annualizedMax >= HIGH_COMP_ANNUAL
    ) {
      score += 1
      scoreBreakdown.push('+1 full-time US remote at or above $100k')
    }

    score = Math.min(10, Math.max(0, score))
  }

  const anyUnclear = HARD_SCREEN_KEYS.some((key) => fit.hardScreen[key].result === 'unclear')
  let recommendation
  if (hardScreenFail) {
    recommendation = 'SKIP'
  } else if (score >= 9 && !anyUnclear) {
    recommendation = 'STRONG_PASS'
  } else if (score >= 7) {
    recommendation = 'PASS'
  } else if (score >= 5) {
    recommendation = 'HOLD'
  } else {
    recommendation = 'SKIP'
  }

  return {
    requiredMatchPct,
    overallMatchPct,
    skills70Pass,
    primaryStackPass,
    hardScreenFail,
    score,
    recommendation,
    annualizedMax,
    hourlyEquivalent,
    missingRequiredSkills,
    deleteReason:
      recommendation === 'SKIP'
        ? deleteReasonFor(fit, skills70Pass, primaryStackPass, missingRequiredSkills)
        : null,
    scoreBreakdown,
  }
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export function fitFrontmatterEntries(
  result,
  now = new Date().toISOString(),
) {
  if (result == null) {
    return [['status', 'new']]
  }

  if (!result.ok) {
    return [
      ['status', 'new'],
      ['fit_error', result.error],
    ]
  }

  const { fit, computed } = result
  const entries = []

  if (computed.recommendation === 'SKIP' && computed.deleteReason) {
    entries.push(
      ['status', 'deleted'],
      ['status_updated_at', now],
      ['deleted_reason', computed.deleteReason],
      ['deleted_reason_other', ''],
      [
        'missing_skills',
        computed.deleteReason === 'missing_skills' ? computed.missingRequiredSkills.join(', ') : '',
      ],
      ['deleted_auto', 'true'],
    )
  } else {
    entries.push(['status', 'new'])
  }

  entries.push(
    ['fit_score', String(computed.score)],
    ['fit_recommendation', computed.recommendation],
    ['fit_required_match', computed.requiredMatchPct.toFixed(2)],
    ['fit_overall_match', computed.overallMatchPct.toFixed(2)],
    ['fit_primary_stack', fit.primaryStack.join(', ')],
    ['fit_missing_skills', computed.missingRequiredSkills.join(', ')],
    ['fit_have_skills', skillNames(fit.skills, 'HAVE')],
    ['fit_familiar_skills', skillNames(fit.skills, 'TOUCHED')],
    ['fit_dont_have_skills', skillNames(fit.skills, 'DONT_HAVE')],
    ['fit_summary', fit.summary.trim()],
    ['fit_early_exit', String(fit.earlyExit)],
    ['fit_model', result.model],
    ['fit_evaluated_at', result.evaluatedAt],
  )

  return entries
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function skillNames(skills, status) {
  return skills.filter((skill) => skill.status === status).map((skill) => skill.name).join(', ')
}

function formatPct(value) {
  return `${Math.round(value * 100)}%`
}

function formatUsd(value) {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function quote(evidence) {
  const text = evidence.replace(/\s+/g, ' ').trim()
  if (!text || text === 'Not disclosed') return 'Not disclosed'
  const clipped = text.length > EVIDENCE_LIMIT ? `${text.slice(0, EVIDENCE_LIMIT)}...` : text
  return `"${clipped}"`
}

function cell(value) {
  if (!value) return ''
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
}

function salaryRange(compensation) {
  const { salaryMin, salaryMax, salaryPeriod, currency } = compensation
  if (salaryMin == null && salaryMax == null) return 'Not disclosed'
  const period = salaryPeriod ? `/${salaryPeriod}` : ''
  const range =
    salaryMin != null && salaryMax != null && salaryMin !== salaryMax
      ? `${salaryMin.toLocaleString('en-US')} - ${salaryMax.toLocaleString('en-US')}`
      : (salaryMax ?? salaryMin ?? 0).toLocaleString('en-US')
  return `${range} ${currency}${period}`
}

function formatRecommendation(recommendation) {
  switch (recommendation) {
    case 'STRONG_PASS':
      return 'Strong pass'
    case 'PASS':
      return 'Pass'
    case 'HOLD':
      return 'Hold'
    case 'SKIP':
      return 'Skip'
  }
}

export function renderFitReport(result) {
  const { fit, computed } = result
  const lines = [
    '## Fit Evaluation',
    '',
    `**${formatRecommendation(computed.recommendation)} ${computed.score}/10**`,
    '',
  ]

  if (fit.summary.trim()) {
    lines.push(fit.summary.trim(), '')
  }

  if (fit.earlyExit) {
    lines.push(
      'The model exited early on a clear hard-criterion failure, so the skills list covers the primary stack only.',
      '',
    )
  }

  lines.push('### Hard Screen', '')
  for (const key of HARD_SCREEN_KEYS) {
    const item = fit.hardScreen[key]
    lines.push(`- ${HARD_SCREEN_LABELS[key]} - ${item.result}: ${quote(item.evidence)}`)
  }
  lines.push(
    `- Required skills at or above 70% - ${computed.skills70Pass ? 'pass' : 'fail'}: ${formatPct(
      computed.requiredMatchPct,
    )}`,
    `- Primary stack - ${computed.primaryStackPass ? 'pass' : 'fail'}: ${
      fit.primaryStack.length ? fit.primaryStack.join(', ') : 'not identified'
    }`,
    '',
  )

  if (fit.skills.length) {
    lines.push(
      '### Skills',
      '',
      '| Skill | Requirement | Tier | Status | Note |',
      '| --- | --- | --- | --- | --- |',
    )
    for (const skill of fit.skills) {
      const note = [skill.note, skill.inferred ? 'inferred' : null, skill.soft ? 'soft' : null]
        .filter(Boolean)
        .join('; ')
      lines.push(
        `| ${cell(skill.name)} | ${skill.requirement} | ${skill.tier} | ${skill.status} | ${cell(
          note,
        )} |`,
      )
    }
    lines.push('')
  }

  lines.push(
    '### Company',
    '',
    `- Size: ${fit.company.sizeBucket} - ${quote(fit.company.headcountEvidence)}`,
    `- Stage: ${fit.company.stage ?? 'unknown'} - ${quote(fit.company.stageEvidence)}`,
    `- Startup or small: ${fit.company.isStartupOrSmall}`,
    `- Ownership model: ${fit.company.ownershipModel} - ${quote(fit.company.ownershipEvidence)}`,
    `- Seniority framing: ${fit.company.seniorityFraming} - ${quote(fit.company.seniorityEvidence)}`,
    `- Interview process: ${fit.company.interviewProcess} - ${quote(fit.company.interviewEvidence)}`,
    '',
    '### Location',
    '',
    `- Remote status: ${fit.location.remoteStatus}`,
    `- Restriction: ${fit.location.remoteRestriction ?? 'none stated'}`,
    `- Company timezone: ${fit.location.companyTimezone ?? 'unknown'}`,
    `- Overlap: ${fit.location.overlapNote ?? 'not stated'}`,
    `- Evidence: ${quote(fit.location.evidence)}`,
    '',
    '### Compensation',
    '',
    `- Role type: ${fit.compensation.roleType}`,
    `- Range: ${salaryRange(fit.compensation)}`,
  )

  if (computed.annualizedMax != null && computed.hourlyEquivalent != null) {
    lines.push(
      `- Annualized max: ${formatUsd(computed.annualizedMax)} (~$${computed.hourlyEquivalent.toFixed(
        2,
      )}/hour)`,
    )
  }

  lines.push(
    `- Hours per week: ${fit.compensation.hoursPerWeek ?? 'not stated'}`,
    `- Equity: ${fit.compensation.equity ?? 'none stated'}`,
    `- Evidence: ${quote(fit.compensation.evidence)}`,
    '',
  )

  return lines
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

function responseText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function parseFit(raw) {
  let json
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { ok: false, detail: `invalid JSON: ${err instanceof Error ? err.message : err}` }
  }
  const parsed = jobFitSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return { ok: false, detail: `schema mismatch: ${issues}` }
  }
  return { ok: true, fit: parsed.data }
}

export function createJobFitScorer(promptFile) {
  return scorerFromPrompt(loadFitPrompt(promptFile))
}

export function createJobFitScorerFromText(raw) {
  return scorerFromPrompt(parseFitPrompt(raw, 'prompt file'))
}

function scorerFromPrompt(prompt) {
  const client = new Anthropic({ maxRetries: 3, timeout: REQUEST_TIMEOUT_MS })

  return {
    async evaluate(posting) {
      const messages = [
        { role: 'user', content: prompt.userTemplate.replace(POSTING_PLACEHOLDER, posting) },
        { role: 'assistant', content: PREFILL },
      ]

      let lastDetail = 'unknown error'
      for (let attempt = 1; attempt <= 2; attempt++) {
        let message
        try {
          message = await client.messages.create({
            model: FIT_MODEL,
            temperature: 0,
            max_tokens: MAX_TOKENS,
            system: [
              { type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } },
            ],
            messages,
          })
        } catch (err) {
          return {
            ok: false,
            error: 'api_error',
            detail: err instanceof Error ? err.message : String(err),
          }
        }

        const raw = PREFILL + responseText(message)
        const parsed = parseFit(raw)
        if (parsed.ok) {
          return {
            ok: true,
            fit: parsed.fit,
            computed: computeFit(parsed.fit),
            model: FIT_MODEL,
            evaluatedAt: new Date().toISOString(),
          }
        }

        lastDetail =
          message.stop_reason === 'max_tokens'
            ? `${parsed.detail} (response hit max_tokens)`
            : parsed.detail

        if (attempt === 1) {
          messages.splice(
            1,
            messages.length - 1,
            { role: 'assistant', content: raw.trimEnd() || PREFILL },
            { role: 'user', content: REPAIR_MESSAGE },
            { role: 'assistant', content: PREFILL },
          )
        }
      }

      return { ok: false, error: 'parse_failed', detail: lastDetail }
    },
  }
}
