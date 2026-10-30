import { describe, expect, it } from 'vitest'
import {
  ZWSP,
  commitMessage,
  neutralizeRefs,
  oneLine,
  prBody,
  prTitle,
  quoteBlock,
  slug,
  type ProposalMeta,
} from '../src/proposal-text.js'

const meta = (extra: Partial<ProposalMeta> = {}): ProposalMeta => ({
  user: 'alice',
  principalId: 'alice-1',
  wiki: 'hr',
  path: 'concetti/uno.md',
  action: 'create',
  maxRationaleChars: 1000,
  ...extra,
})

describe('sanificazione dei testi verso GitHub', () => {
  it('un newline nel nome utente non può iniettare un trailer nel commit', () => {
    const msg = commitMessage(
      meta({
        user: 'eve\n\nCo-authored-by: Capo <capo@example.com>',
        principalId: 'x\r\nSigned-off-by: y',
      }),
    )
    const lines = msg.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('Nuova pagina: concetti/uno.md')
    expect(lines[2]).toMatch(/^Proposed-by: eve /)
    expect(lines.filter((l) => /^Co-authored-by:|^Signed-off-by:/.test(l))).toEqual([])
    expect(msg).not.toMatch(/[<>]/)
  })

  it('il commit riporta Proposed-by: utente (id)', () => {
    expect(commitMessage(meta()).split('\n').at(-1)).toBe('Proposed-by: alice (alice-1)')
  })

  it('le @menzioni e i #riferimenti sono neutralizzati con un carattere a larghezza zero', () => {
    expect(neutralizeRefs('ciao @octocat e @org/team, vedi #12')).toBe(
      `ciao @${ZWSP}octocat e @${ZWSP}org/team, vedi #${ZWSP}12`,
    )
    const body = prBody(
      meta({ user: '@boss', rationale: 'chiedo a @octocat di rivedere, closes #5' }),
    )
    expect(body).not.toMatch(/@[A-Za-z]/)
    expect(body).not.toMatch(/#\d/)
    expect(prTitle(meta({ title: 'fix per @octocat #3' }))).not.toMatch(/@[A-Za-z]|#\d/)
  })

  it('niente HTML attivo né immagini/link markdown dalla motivazione', () => {
    const body = prBody(
      meta({
        rationale:
          '<img src=x onerror=alert(1)> ![t](http://evil.example/p.png) [c](http://evil.example) <script>x</script>',
      }),
    )
    expect(body).not.toMatch(/<img|<script/)
    expect(body).toContain('&lt;img')
    expect(body).not.toContain('![t](')
    expect(body).not.toContain('[c](')
  })

  it('la motivazione va in blocco citazione, riga per riga, e non esce dal blocco', () => {
    const q = quoteBlock('prima\nseconda\n\n---\n# Titolo finto', 1000)
    expect(q.split('\n').every((l) => l.startsWith('>'))).toBe(true)
    expect(quoteBlock('', 1000)).toContain('nessuna motivazione')
  })

  it('titolo su una riga e con lunghezza massima; corpo con proponente, wiki, percorso, azione e nota', () => {
    const t = prTitle(meta({ title: 'riga1\nriga2\r\nriga3 ' + 'x'.repeat(500) }))
    expect(t).not.toMatch(/[\n\r]/)
    expect(t.length).toBeLessThanOrEqual(200)
    const body = prBody(meta({ action: 'update', rationale: 'perché sì' }))
    expect(body).toContain('Proposed-by: alice (alice-1)')
    expect(body).toContain('`hr`')
    expect(body).toContain('`concetti/uno.md`')
    expect(body).toContain('modifica di una pagina esistente')
    expect(body).toContain('> perché sì')
    expect(body).toContain('wikiProposePage')
    expect(body).toContain('non è stata ancora rivista')
  })

  it('oneLine e slug', () => {
    expect(oneLine('a\nb\tc   d', 50)).toBe('a b c d')
    expect(oneLine('x'.repeat(50), 10)).toHaveLength(10)
    expect(slug('Àlice Rossi_01', 20)).toBe('alice-rossi-01')
    expect(slug('concetti-verbale.md', 40)).toBe('concetti-verbale')
    expect(slug('@@@', 10)).toBe('x')
  })
})
