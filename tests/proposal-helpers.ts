import { auditTools } from '../src/audit.js'
import { runWithPrincipal, type Principal } from '../src/auth.js'
import { parseWikiConfig, type ProposalsConfig } from '../src/config.js'
import { createGitHubClient } from '../src/github.js'
import {
  createProposer,
  type ProposeInput,
  type ProposeResult,
  type Proposer,
} from '../src/proposals.js'
import { wikiProposePageTool } from '../src/tools/propose-page.js'
import type { Telemetry } from '../src/telemetry.js'
import { FakeGitHub } from './fake-github.js'
import { cleanup, frontmatter, setupService, type Fixture } from './helpers'
import { makeTelemetry, type Ev } from './obs-helpers'

export const principal = (
  id: string,
  groups: string[] = [],
  extra: Partial<Principal> = {},
): Principal => ({
  id,
  user: id.replace(/-\d+$/, ''),
  groups,
  wikis: '*',
  propose: ['test'],
  ...extra,
})

export const WIKI_FILES: Record<string, string> = {
  'concetti/aperta.md': frontmatter() + '# Aperta\n\nTesto pubblico.\n',
  'riservate/hr.md':
    frontmatter({ extra: 'visibilita: riservata\ngruppi: [hr]' }) + '# HR\n\nSolo HR.\n',
  'riservate/legale.md':
    frontmatter({ extra: 'visibilita: riservata\ngruppi: [legal]' }) +
    '# Legale\n\nSegreto legale.\n',
  'index.md': '# Indice\n',
}

export interface ProposalEnv {
  fx: Fixture
  fake: FakeGitHub
  proposer: Proposer
  tel: Telemetry
  events: (name?: string) => Ev[]
  lines: string[]
  config: ProposalsConfig
  run: (p: Principal | undefined, input: ProposeInput) => Promise<ProposeResult>
  close: () => Promise<void>
}

/** Wiki di prova + finto GitHub + proposer, senza HTTP. `overrides` modifica il campo `proposals`. */
export async function makeProposalEnv(
  opts: {
    overrides?: Record<string, unknown>
    files?: Record<string, string>
    seed?: Record<string, string>
    now?: () => number
    timeoutMs?: number
    token?: string
  } = {},
): Promise<ProposalEnv> {
  const fake = new FakeGitHub()
  await fake.start()
  for (const [p, c] of Object.entries(
    opts.seed ?? { 'wiki/concetti/aperta.md': '# vecchia versione\n' },
  ))
    fake.seed(p, c)
  const fx = setupService(opts.files ?? WIKI_FILES)
  const config = parseWikiConfig(
    [
      {
        name: 'test',
        wikiPath: 'wiki',
        proposals: { repo: fake.repo, apiUrl: fake.url, ...opts.overrides },
      },
    ],
    fx.root,
  )[0].proposals!
  const { tel, events, lines } = makeTelemetry()
  const proposer = createProposer({
    svc: fx.svc,
    config,
    telemetry: tel,
    github: createGitHubClient({
      apiUrl: fake.url,
      token: opts.token ?? fake.token,
      repo: fake.repo,
      timeoutMs: opts.timeoutMs ?? 2000,
    }),
    now: opts.now,
  })
  // Il tool vero, avvolto da withAudit come in server.ts: `run` produce anche gli eventi di audit.
  const { wikiProposePage } = auditTools(
    { wikiProposePage: wikiProposePageTool(proposer) },
    { wiki: 'test', auditor: tel.auditor, metrics: tel.metrics, queryMaxChars: 100 },
  )
  const exec = (input: ProposeInput) =>
    (wikiProposePage.execute as (i: ProposeInput, c: unknown) => Promise<ProposeResult>)(input, {})
  return {
    fx,
    fake,
    proposer,
    tel,
    events,
    lines,
    config,
    run: (p, input) => (p ? runWithPrincipal(p, () => exec(input)) : exec(input)),
    close: async () => {
      await fake.stop()
      cleanup(fx)
    },
  }
}

export const VALID = (extra = ''): string =>
  frontmatter(extra ? { extra } : {}) + '# Titolo\n\nCorpo della proposta.\n'
