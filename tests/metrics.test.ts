import { describe, expect, it } from 'vitest'
import { Metrics } from '../src/metrics.js'

describe('Metrics (formato Prometheus)', () => {
  it('contatori con etichette, HELP e TYPE una volta sola', async () => {
    const m = new Metrics()
    m.inc('x_total', { a: '1' }, 'aiuto')
    m.inc('x_total', { a: '1' })
    m.inc('x_total', { a: '2' })
    const text = await m.renderText()
    expect(text.match(/# TYPE x_total counter/g)).toHaveLength(1)
    expect(text).toContain('x_total{a="1"} 2')
    expect(text).toContain('x_total{a="2"} 1')
  })

  it('histogram: bucket cumulativi, +Inf, somma e conteggio; HELP una volta sola', async () => {
    const m = new Metrics()
    m.observeDuration('d_seconds', { t: 'a' }, 0.02)
    m.observeDuration('d_seconds', { t: 'a' }, 3)
    const text = await m.renderText()
    expect(text.match(/# TYPE d_seconds histogram/g)).toHaveLength(1)
    expect(text).toContain('d_seconds_bucket{t="a",le="0.025"} 1')
    expect(text).toContain('d_seconds_bucket{t="a",le="5"} 2')
    expect(text).toContain('d_seconds_bucket{t="a",le="+Inf"} 2')
    expect(text).toContain('d_seconds_count{t="a"} 2')
    expect(text).toContain('d_seconds_sum{t="a"} 3.02')
  })

  it('escape dei valori delle etichette', async () => {
    const m = new Metrics()
    m.inc('e_total', { v: 'a"b\\c\nd' })
    expect(await m.renderText()).toContain('e_total{v="a\\"b\\\\c\\nd"} 1')
  })

  it('un gauge che lancia non fa fallire lo scrape', async () => {
    const m = new Metrics()
    m.addGauge('g', 'g', () => Promise.reject(new Error('no')))
    m.addGauge('g', 'g', () => Promise.resolve([{ labels: { w: 'a' }, value: 3 }]))
    expect(await m.renderText()).toContain('g{w="a"} 3')
  })
})
