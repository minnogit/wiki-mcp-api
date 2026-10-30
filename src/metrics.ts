// Metriche in formato testo Prometheus, scritte a mano (nessuna dipendenza). Cardinalità
// limitata per costruzione: le etichette sono scelte dal chiamante tra insiemi chiusi (wiki
// configurate, tool registrati, motivi di `AUTH_REASONS`, codici di stato). Mai valori scritti
// dall'utente (utente, slug, query): per questo `Labels` ammette solo stringhe che il codice
// sceglie, e i valori sono comunque escapati nell'output.

export type Labels = Record<string, string>

/** Motivi di fallimento di accesso: insieme chiuso, usato sia nell'evento `auth` sia nella metrica. */
export const AUTH_REASONS = [
  'missing-token',
  'invalid-token',
  'expired-token',
  'rate-limited',
  'wiki-not-allowed',
  'wiki-unknown',
] as const
export type AuthReason = (typeof AUTH_REASONS)[number]

/** Esiti di una chiamata a un tool. */
export const OUTCOMES = ['ok', 'error', 'denied'] as const
export type Outcome = (typeof OUTCOMES)[number]

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function render(labels: Labels): string {
  const entries = Object.entries(labels)
  if (entries.length === 0) return ''
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`
}

const keyOf = (labels: Labels): string => JSON.stringify(Object.entries(labels).sort())

interface HistogramState {
  name: string
  labels: Labels
  buckets: number[]
  sum: number
  count: number
}

type GaugeSource = () => Promise<{ labels: Labels; value: number }[]>

export class Metrics {
  private readonly counters = new Map<string, Map<string, { labels: Labels; value: number }>>()
  private readonly help = new Map<string, string>()
  private readonly histograms = new Map<string, HistogramState>()
  private readonly gauges = new Map<string, GaugeSource[]>()

  private describe(name: string, help: string): void {
    this.help.set(name, help)
  }

  inc(name: string, labels: Labels = {}, help = name): void {
    this.describe(name, help)
    let series = this.counters.get(name)
    if (!series) {
      series = new Map<string, { labels: Labels; value: number }>()
      this.counters.set(name, series)
    }
    const key = keyOf(labels)
    const hit = series.get(key)
    if (hit) hit.value += 1
    else series.set(key, { labels, value: 1 })
  }

  observeDuration(name: string, labels: Labels, seconds: number): void {
    this.describe(name, 'Durata delle chiamate ai tool, in secondi')
    const key = `${name}|${keyOf(labels)}`
    let h = this.histograms.get(key)
    if (!h) {
      h = { name, labels, buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 }
      this.histograms.set(key, h)
    }
    DURATION_BUCKETS.forEach((le, i) => {
      if (seconds <= le) h.buckets[i] += 1
    })
    h.sum += seconds
    h.count += 1
  }

  /** Gauge calcolato a ogni scrape da `source` (es. pagine in cache di una wiki). */
  addGauge(name: string, help: string, source: GaugeSource): void {
    this.describe(name, help)
    const list = this.gauges.get(name) ?? []
    list.push(source)
    this.gauges.set(name, list)
  }

  /** Testo nel formato di esposizione Prometheus 0.0.4. */
  async renderText(): Promise<string> {
    const out: string[] = []
    const header = (name: string, type: string) => {
      out.push(`# HELP ${name} ${this.help.get(name) ?? name}`, `# TYPE ${name} ${type}`)
    }
    for (const [name, series] of [...this.counters].sort()) {
      header(name, 'counter')
      for (const { labels, value } of series.values()) out.push(`${name}${render(labels)} ${value}`)
    }
    const histogramNames = [...new Set([...this.histograms.values()].map((h) => h.name))].sort()
    for (const name of histogramNames) {
      header(name, 'histogram')
      for (const h of this.histograms.values()) {
        if (h.name !== name) continue
        DURATION_BUCKETS.forEach((le, i) =>
          out.push(`${name}_bucket${render({ ...h.labels, le: String(le) })} ${h.buckets[i]}`),
        )
        out.push(`${name}_bucket${render({ ...h.labels, le: '+Inf' })} ${h.count}`)
        out.push(
          `${name}_sum${render(h.labels)} ${h.sum}`,
          `${name}_count${render(h.labels)} ${h.count}`,
        )
      }
    }
    for (const [name, sources] of [...this.gauges].sort()) {
      header(name, 'gauge')
      for (const source of sources) {
        try {
          for (const { labels, value } of await source())
            out.push(`${name}${render(labels)} ${value}`)
        } catch {
          // una wiki illeggibile non deve far fallire l'intero scrape: la serie manca e basta
        }
      }
    }
    return out.join('\n') + '\n'
  }
}

export const METRIC = {
  toolCalls: 'wiki_mcp_tool_calls_total',
  toolDuration: 'wiki_mcp_tool_duration_seconds',
  authFailures: 'wiki_mcp_auth_failures_total',
  httpRequests: 'wiki_mcp_http_requests_total',
  wikiPages: 'wiki_mcp_wiki_pages',
} as const
