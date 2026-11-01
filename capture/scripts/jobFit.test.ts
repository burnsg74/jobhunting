import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  annualize,
  computeFit,
  fitFrontmatterEntries,
  parseFitPrompt,
  renderFitReport,
  type FitSkill,
  type JobFit,
} from './jobFit.js'

function skill(overrides: Partial<FitSkill> & { name: string }): FitSkill {
  return {
    requirement: 'required',
    tier: 1,
    status: 'HAVE',
    inferred: false,
    soft: false,
    note: null,
    ...overrides,
  }
}

function fixture(overrides: Partial<JobFit> = {}): JobFit {
  return {
    job: { title: 'Engineer', company: 'Acme', source: 'Wellfound', companyDescription: null },
    earlyExit: false,
    hardScreen: {
      remoteOnly: { result: 'pass', evidence: 'fully remote' },
      compensation: { result: 'pass', evidence: '$80k' },
      timezone: { result: 'pass', evidence: 'US based' },
      roleType: { result: 'pass', evidence: 'full-time' },
    },
    primaryStack: ['React', 'Node.js'],
    skills: [skill({ name: 'React' }), skill({ name: 'Node.js' })],
    company: {
      sizeBucket: 'unknown',
      headcountEvidence: 'Not disclosed',
      stage: null,
      stageEvidence: 'Not disclosed',
      isStartupOrSmall: 'unknown',
      ownershipModel: 'balanced',
      ownershipEvidence: 'Not disclosed',
      seniorityFraming: 'neutral',
      seniorityEvidence: 'Not disclosed',
      interviewProcess: 'unknown',
      interviewEvidence: 'Not disclosed',
    },
    location: {
      companyTimezone: null,
      remoteStatus: 'remote_us',
      remoteRestriction: null,
      overlapNote: null,
      evidence: 'remote US',
    },
    // Deliberately below $100k so the baseline fixture triggers no score
    // adjustment at all and each test can opt into exactly one.
    compensation: {
      roleType: 'full_time',
      hoursPerWeek: 40,
      salaryMin: 80_000,
      salaryMax: 80_000,
      salaryPeriod: 'year',
      currency: 'USD',
      equity: null,
      evidence: '$80k',
    },
    summary: 'Good fit.',
    ...overrides,
  }
}

describe('match percentages', () => {
  it('weights HAVE as 1, TOUCHED as 0.5, and DONT_HAVE as 0', () => {
    const { requiredMatchPct } = computeFit(
      fixture({
        primaryStack: [],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'GraphQL', tier: 3, status: 'TOUCHED' }),
          skill({ name: 'Go', tier: 4, status: 'DONT_HAVE' }),
          skill({ name: 'Rust', tier: 4, status: 'DONT_HAVE' }),
        ],
      }),
    )
    expect(requiredMatchPct).toBeCloseTo(0.375)
  })

  it('excludes soft skills from both percentages', () => {
    const { requiredMatchPct, overallMatchPct } = computeFit(
      fixture({
        primaryStack: [],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'Go', tier: 4, status: 'DONT_HAVE' }),
          skill({ name: 'Scrum', soft: true, status: 'HAVE' }),
          skill({ name: 'Mentoring', soft: true, status: 'HAVE', requirement: 'nice' }),
        ],
      }),
    )
    expect(requiredMatchPct).toBeCloseTo(0.5)
    expect(overallMatchPct).toBeCloseTo(0.5)
  })

  it('separates required from nice-to-have in the overall percentage', () => {
    const { requiredMatchPct, overallMatchPct } = computeFit(
      fixture({
        primaryStack: [],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'Go', tier: 4, status: 'DONT_HAVE', requirement: 'nice' }),
        ],
      }),
    )
    expect(requiredMatchPct).toBe(1)
    expect(overallMatchPct).toBeCloseTo(0.5)
  })

  it('falls back to the overall percentage when nothing is marked required', () => {
    const { requiredMatchPct, overallMatchPct, skills70Pass } = computeFit(
      fixture({
        primaryStack: [],
        skills: [
          skill({ name: 'React', requirement: 'nice' }),
          skill({ name: 'Vue.js', requirement: 'nice' }),
        ],
      }),
    )
    expect(requiredMatchPct).toBe(1)
    expect(overallMatchPct).toBe(1)
    expect(skills70Pass).toBe(true)
  })

  it('scores a posting with no non-soft skills at zero', () => {
    const { requiredMatchPct, overallMatchPct, skills70Pass, recommendation } = computeFit(
      fixture({ primaryStack: [], skills: [skill({ name: 'Scrum', soft: true })] }),
    )
    expect(requiredMatchPct).toBe(0)
    expect(overallMatchPct).toBe(0)
    expect(skills70Pass).toBe(false)
    expect(recommendation).toBe('SKIP')
  })
})

describe('primaryStackPass', () => {
  it('passes when exactly half of the stack is tier 4', () => {
    const { primaryStackPass } = computeFit(
      fixture({
        primaryStack: ['React', 'Go'],
        skills: [skill({ name: 'React' }), skill({ name: 'Go', tier: 4, status: 'DONT_HAVE' })],
      }),
    )
    expect(primaryStackPass).toBe(false)
  })

  it('passes when fewer than half of the stack is tier 4', () => {
    const { primaryStackPass } = computeFit(
      fixture({
        primaryStack: ['React', 'Node.js', 'Go'],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'Node.js' }),
          skill({ name: 'Go', tier: 4, status: 'DONT_HAVE' }),
        ],
      }),
    )
    expect(primaryStackPass).toBe(true)
  })

  it('matches stack entries to skills regardless of case and spacing', () => {
    const { primaryStackPass } = computeFit(
      fixture({
        primaryStack: ['  .NET / c#  '],
        skills: [skill({ name: '.NET / C#', tier: 4, status: 'DONT_HAVE' })],
      }),
    )
    expect(primaryStackPass).toBe(false)
  })

  it('treats stack entries absent from skills as not tier 4', () => {
    const { primaryStackPass } = computeFit(
      fixture({ primaryStack: ['Some Unlisted Thing'], skills: [skill({ name: 'React' })] }),
    )
    expect(primaryStackPass).toBe(true)
  })

  it('passes on an empty stack', () => {
    expect(computeFit(fixture({ primaryStack: [] })).primaryStackPass).toBe(true)
  })
})

describe('hard screen failures', () => {
  it('scores 0 and SKIPs when a hard criterion fails', () => {
    const { score, recommendation, hardScreenFail } = computeFit(
      fixture({
        hardScreen: {
          ...fixture().hardScreen,
          remoteOnly: { result: 'fail', evidence: 'hybrid, 3 days in office' },
        },
      }),
    )
    expect(hardScreenFail).toBe(true)
    expect(score).toBe(0)
    expect(recommendation).toBe('SKIP')
  })

  it('scores 1 when only the skills threshold fails', () => {
    const { score, recommendation } = computeFit(
      fixture({
        primaryStack: [],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'Go', tier: 4, status: 'DONT_HAVE' }),
          skill({ name: 'Kubernetes', tier: 4, status: 'DONT_HAVE' }),
        ],
      }),
    )
    expect(score).toBe(1)
    expect(recommendation).toBe('SKIP')
  })

  it('scores 2 when only the primary stack check fails', () => {
    const { score, skills70Pass, primaryStackPass } = computeFit(
      fixture({
        primaryStack: ['Go', 'Kubernetes'],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'Node.js' }),
          skill({ name: 'PostgreSQL' }),
          skill({ name: 'TypeScript' }),
          skill({ name: 'Go', tier: 4, status: 'DONT_HAVE', requirement: 'nice' }),
          skill({ name: 'Kubernetes', tier: 4, status: 'DONT_HAVE', requirement: 'nice' }),
        ],
      }),
    )
    expect(skills70Pass).toBe(true)
    expect(primaryStackPass).toBe(false)
    expect(score).toBe(2)
  })
})

describe('score adjustments', () => {
  it('uses the base score from the required match with no adjustments', () => {
    expect(computeFit(fixture()).score).toBe(9)
  })

  it('drops a point when compensation is undisclosed', () => {
    const { score, recommendation } = computeFit(
      fixture({
        hardScreen: {
          ...fixture().hardScreen,
          compensation: { result: 'unclear', evidence: 'Not disclosed' },
        },
      }),
    )
    expect(score).toBe(8)
    expect(recommendation).toBe('PASS')
  })

  it('adds a point for a sub-50-person company', () => {
    const { score } = computeFit(fixture({ company: { ...fixture().company, sizeBucket: '<50' } }))
    expect(score).toBe(10)
  })

  it('adds a point for an ownership culture', () => {
    const { score } = computeFit(
      fixture({ company: { ...fixture().company, ownershipModel: 'ownership' } }),
    )
    expect(score).toBe(10)
  })

  it('drops a point for a process-heavy culture', () => {
    const { score } = computeFit(
      fixture({ company: { ...fixture().company, ownershipModel: 'process' } }),
    )
    expect(score).toBe(8)
  })

  it('drops a point for a complex interview process', () => {
    const { score } = computeFit(
      fixture({ company: { ...fixture().company, interviewProcess: 'complex' } }),
    )
    expect(score).toBe(8)
  })

  it('adds a point for full-time US remote at or above $100k', () => {
    const under = computeFit(
      fixture({ compensation: { ...fixture().compensation, salaryMax: 99_999 } }),
    )
    const at = computeFit(
      fixture({ compensation: { ...fixture().compensation, salaryMax: 100_000 } }),
    )
    expect(under.score).toBe(9)
    expect(at.score).toBe(10)
  })

  it('skips the compensation bonus when the salary is undisclosed', () => {
    const { score } = computeFit(
      fixture({
        compensation: { ...fixture().compensation, salaryMax: null, salaryPeriod: null },
        hardScreen: {
          ...fixture().hardScreen,
          compensation: { result: 'pass', evidence: 'competitive' },
        },
      }),
    )
    expect(score).toBe(9)
  })

  it('clamps two stacked bonuses to 10', () => {
    const { score } = computeFit(
      fixture({
        company: { ...fixture().company, sizeBucket: '<50' },
        compensation: { ...fixture().compensation, salaryMax: 150_000 },
      }),
    )
    expect(score).toBe(10)
  })

  it('applies penalties cumulatively without dropping below 0', () => {
    const { score } = computeFit(
      fixture({
        hardScreen: {
          ...fixture().hardScreen,
          compensation: { result: 'unclear', evidence: 'Not disclosed' },
        },
        company: { ...fixture().company, ownershipModel: 'process', interviewProcess: 'complex' },
        primaryStack: [],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'Node.js' }),
          skill({ name: 'GraphQL', tier: 3, status: 'TOUCHED' }),
          skill({ name: 'Supabase', tier: 3, status: 'TOUCHED' }),
        ],
      }),
    )
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBe(4)
  })
})

describe('recommendation boundaries', () => {
  it('requires no unclear criteria for STRONG_PASS', () => {
    expect(computeFit(fixture()).recommendation).toBe('STRONG_PASS')

    const withUnclear = computeFit(
      fixture({
        hardScreen: {
          ...fixture().hardScreen,
          timezone: { result: 'unclear', evidence: 'Not disclosed' },
        },
      }),
    )
    expect(withUnclear.score).toBe(9)
    expect(withUnclear.recommendation).toBe('PASS')
  })

  it('returns PASS at 7', () => {
    const { score, recommendation } = computeFit(
      fixture({
        company: { ...fixture().company, ownershipModel: 'process', interviewProcess: 'complex' },
      }),
    )
    expect(score).toBe(7)
    expect(recommendation).toBe('PASS')
  })

  it('returns HOLD between 5 and 6', () => {
    const { score, recommendation } = computeFit(
      fixture({
        hardScreen: {
          ...fixture().hardScreen,
          compensation: { result: 'unclear', evidence: 'Not disclosed' },
        },
        company: { ...fixture().company, ownershipModel: 'process', interviewProcess: 'complex' },
        primaryStack: [],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'Node.js' }),
          skill({ name: 'GraphQL', tier: 3, status: 'TOUCHED' }),
        ],
      }),
    )
    expect(score).toBe(5)
    expect(recommendation).toBe('HOLD')
  })
})

describe('annualize', () => {
  it('converts hourly, monthly, and yearly periods', () => {
    expect(annualize(50, 'hour')).toBe(104_000)
    expect(annualize(10_000, 'month')).toBe(120_000)
    expect(annualize(120_000, 'year')).toBe(120_000)
  })

  it('returns null when the amount or period is missing', () => {
    expect(annualize(null, 'year')).toBeNull()
    expect(annualize(120_000, null)).toBeNull()
  })

  it('derives the hourly equivalent from the annualized max', () => {
    const { annualizedMax, hourlyEquivalent } = computeFit(
      fixture({ compensation: { ...fixture().compensation, salaryMax: 60, salaryPeriod: 'hour' } }),
    )
    expect(annualizedMax).toBe(124_800)
    expect(hourlyEquivalent).toBe(60)
  })
})

describe('deleteReason mapping', () => {
  const hardScreenFixture = (overrides: Partial<JobFit['hardScreen']>) =>
    computeFit(fixture({ hardScreen: { ...fixture().hardScreen, ...overrides } }))

  it('maps a remote failure to wrong_location', () => {
    expect(
      hardScreenFixture({ remoteOnly: { result: 'fail', evidence: 'onsite' } }).deleteReason,
    ).toBe('wrong_location')
  })

  it('maps a compensation failure to compensation', () => {
    expect(
      hardScreenFixture({ compensation: { result: 'fail', evidence: 'equity only' } }).deleteReason,
    ).toBe('compensation')
  })

  it('maps a role type failure to role_mismatch', () => {
    expect(
      hardScreenFixture({ roleType: { result: 'fail', evidence: 'unpaid internship' } })
        .deleteReason,
    ).toBe('role_mismatch')
  })

  it('maps a timezone failure to wrong_location', () => {
    expect(
      hardScreenFixture({ timezone: { result: 'fail', evidence: 'CET overlap required' } })
        .deleteReason,
    ).toBe('wrong_location')
  })

  it('prefers remote over compensation when both fail', () => {
    expect(
      hardScreenFixture({
        remoteOnly: { result: 'fail', evidence: 'onsite' },
        compensation: { result: 'fail', evidence: 'equity only' },
      }).deleteReason,
    ).toBe('wrong_location')
  })

  it('maps a skills gap to missing_skills and lists the names', () => {
    const { deleteReason, missingRequiredSkills } = computeFit(
      fixture({
        primaryStack: [],
        skills: [
          skill({ name: 'React' }),
          skill({ name: 'Go', tier: 4, status: 'DONT_HAVE' }),
          skill({ name: 'Kubernetes', tier: 4, status: 'DONT_HAVE' }),
        ],
      }),
    )
    expect(deleteReason).toBe('missing_skills')
    expect(missingRequiredSkills).toEqual(['Go', 'Kubernetes'])
  })

  it('falls back to role_mismatch when the gap is all TOUCHED', () => {
    const { deleteReason, missingRequiredSkills, skills70Pass } = computeFit(
      fixture({
        primaryStack: [],
        skills: [
          skill({ name: 'GraphQL', tier: 3, status: 'TOUCHED' }),
          skill({ name: 'Supabase', tier: 3, status: 'TOUCHED' }),
        ],
      }),
    )
    expect(skills70Pass).toBe(false)
    expect(missingRequiredSkills).toEqual([])
    expect(deleteReason).toBe('role_mismatch')
  })

  it('leaves deleteReason null when the recommendation is not SKIP', () => {
    expect(computeFit(fixture()).deleteReason).toBeNull()
  })
})

describe('fitFrontmatterEntries', () => {
  const at = '2026-09-16T12:00:00.000Z'

  it('writes status new with no fit keys when scoring is off', () => {
    expect(fitFrontmatterEntries(null, at)).toEqual([['status', 'new']])
  })

  it('records the error slug and keeps the job in the inbox on failure', () => {
    expect(
      fitFrontmatterEntries({ ok: false, error: 'parse_failed', detail: 'bad json' }, at),
    ).toEqual([
      ['status', 'new'],
      ['fit_error', 'parse_failed'],
    ])
  })

  it('keeps status new for a PASS', () => {
    const fit = fixture({
      hardScreen: {
        ...fixture().hardScreen,
        compensation: { result: 'unclear', evidence: 'Not disclosed' },
      },
    })
    const entries = new Map(
      fitFrontmatterEntries(
        { ok: true, fit, computed: computeFit(fit), model: 'test-model', evaluatedAt: at },
        at,
      ),
    )
    expect(entries.get('status')).toBe('new')
    expect(entries.get('fit_recommendation')).toBe('PASS')
    expect(entries.get('fit_score')).toBe('8')
    expect(entries.get('fit_required_match')).toBe('1.00')
    expect(entries.get('fit_primary_stack')).toBe('React, Node.js')
    expect(entries.get('fit_have_skills')).toBe('React, Node.js')
    expect(entries.get('fit_familiar_skills')).toBe('')
    expect(entries.get('fit_dont_have_skills')).toBe('')
    expect(entries.get('fit_summary')).toBe('Good fit.')
    expect(entries.get('fit_model')).toBe('test-model')
    expect(entries.has('deleted_auto')).toBe(false)
  })

  it('auto-deletes a SKIP with the backend key set', () => {
    const fit = fixture({
      primaryStack: [],
      skills: [
        skill({ name: 'React' }),
        skill({ name: 'Go', tier: 4, status: 'DONT_HAVE' }),
        skill({ name: 'Kubernetes', tier: 4, status: 'DONT_HAVE' }),
      ],
    })
    const entries = fitFrontmatterEntries(
      { ok: true, fit, computed: computeFit(fit), model: 'test-model', evaluatedAt: at },
      at,
    )
    expect(entries.slice(0, 6)).toEqual([
      ['status', 'deleted'],
      ['status_updated_at', at],
      ['deleted_reason', 'missing_skills'],
      ['deleted_reason_other', ''],
      ['missing_skills', 'Go, Kubernetes'],
      ['deleted_auto', 'true'],
    ])
  })

  it('leaves missing_skills empty for a non-skills SKIP', () => {
    const fit = fixture({
      hardScreen: { ...fixture().hardScreen, remoteOnly: { result: 'fail', evidence: 'onsite' } },
    })
    const entries = new Map(
      fitFrontmatterEntries(
        { ok: true, fit, computed: computeFit(fit), model: 'test-model', evaluatedAt: at },
        at,
      ),
    )
    expect(entries.get('deleted_reason')).toBe('wrong_location')
    expect(entries.get('missing_skills')).toBe('')
    expect(entries.get('fit_score')).toBe('0')
  })
})

describe('renderFitReport', () => {
  it('prints a compact verdict without match percentages or score breakdown', () => {
    const fit = fixture()
    const text = renderFitReport({
      ok: true,
      fit,
      computed: computeFit(fit),
      model: 'test-model',
      evaluatedAt: '2026-09-17T00:00:00.000Z',
    }).join('\n')
    expect(text).toContain('**Strong pass 9/10**')
    expect(text).not.toContain('required match')
    expect(text).not.toContain('overall match')
    expect(text).not.toContain('base 9')
    expect(text).toContain('| Skill |')
    expect(text).toContain('Good fit.')
  })
})

const promptFile = process.env.WELLFOUND_PROMPT_FILE ?? ''

describe('parseFitPrompt frontmatter', () => {
  it('ignores YAML frontmatter before the first heading', () => {
    const raw = [
      '---',
      'note_type: Prompt',
      '---',
      '',
      '# ROLE',
      'You score jobs.',
      '',
      '# OUTPUT SCHEMA',
      '{}',
      '',
      '# USER TURN TEMPLATE',
      '{{POSTING_MARKDOWN}}',
    ].join('\n')
    const { system, userTemplate } = parseFitPrompt(raw)
    expect(system.startsWith('# ROLE')).toBe(true)
    expect(userTemplate).toBe('{{POSTING_MARKDOWN}}')
  })
})

describe('loadFitPrompt', () => {
  it.skipIf(!promptFile || !fs.existsSync(promptFile))(
    'splits the stored prompt into a cacheable system block and a user template',
    () => {
      const { system, userTemplate } = parseFitPrompt(fs.readFileSync(promptFile, 'utf8'), 'prompt file')
      expect(system.startsWith('# ROLE')).toBe(true)
      expect(system).toContain('# OUTPUT SCHEMA')
      expect(system).not.toContain('# USER TURN TEMPLATE')
      // Claude 3.5 Haiku only caches prefixes of 2048 tokens or more.
      expect(system.length).toBeGreaterThan(2048 * 4)
      expect(userTemplate).toContain('{{POSTING_MARKDOWN}}')
      expect(userTemplate).toContain('<job_posting>')
    },
  )
})
