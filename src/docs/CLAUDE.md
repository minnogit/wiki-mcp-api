# Wiki – Dominio: Verbalizzazione Codice della Strada

Questa è la configurazione che guida l'agente nella manutenzione di una wiki
personale di concetti di dominio per un software gestionale di **verbalizzazione
del Codice della Strada (CdS) italiano**.

L'agente possiede e mantiene la wiki. L'utente cura le sorgenti, pone domande,
e co-evolve questo schema. L'agente **non modifica mai** `raw/`.

> Nota: opencode legge sia `CLAUDE.md` sia `AGENTS.md`. Se preferisci la
> convenzione nativa di opencode, rinomina questo file in `AGENTS.md`.

---

## 1. Architettura

```
.
├── CLAUDE.md          # questo file (schema operativo)
├── raw/               # sorgenti immutabili (documentazione e analisi in markdown)
└── wiki/              # pagine generate e mantenute dall'agente
    ├── index.md       # catalogo navigabile di tutte le pagine
    ├── log.md         # registro cronologico delle operazioni
    ├── overview.md    # sintesi corrente del dominio
    ├── sources.md     # registro sorgenti processate con checksum
    ├── concetti/      # concetti di dominio (Verbale, Sanzione, ecc.)
    ├── soggetti/      # ruoli e attori (Trasgressore, Agente accertatore, ecc.)
    ├── procedure/     # workflow e processi (Notifica, Pagamento, Ricorso, ecc.)
    ├── normativa/     # riferimenti normativi (articoli CdS, leggi, circolari)
    ├── modello-dati/  # entità software, relazioni, stati, regole di business
    └── analisi/       # decisioni di design, casi limite, comparazioni
```

Le sottocartelle in `wiki/` sono indicative: aggiungile, rinominale o fondile
quando emergono nuove categorie. Non creare cartelle vuote "per il futuro".

---

## 2. Convenzioni delle pagine

**Naming**: `kebab-case` in italiano. Esempi: `verbale-di-accertamento.md`,
`decurtazione-punti.md`, `obbligato-in-solido.md`. Niente abbreviazioni se non
sono di uso comune nel dominio (CdS, GdP, ecc. vanno bene).

**Frontmatter YAML** in cima a ogni pagina:

```yaml
---
tipo: concetto | soggetto | procedura | normativa | entita | analisi
tags: [verbale, sanzione, ...]
fonti: [raw/nome-file-1.md, raw/nome-file-2.md]
aggiornato: YYYY-MM-DD
stato: bozza | stabile | da-rivedere
---
```

**Granularità**: una pagina = un solo `tipo` e un solo tema coerente.
Se un argomento contiene sotto-concetti con natura o stato diversi (es. un
aspetto "stabile" e uno ancora "da-rivedere", o un concetto giuridico insieme
al suo modello software), valuta lo split in più pagine linkate invece di
un frontmatter unico che li appiattisce. Frontmatter e contenuto coerenti
rendono `wiki_search` (filtri per tag/tipo/stato + ranking sul contenuto)
affidabile; una pagina che mescola temi diversi diluisce entrambi.

**Struttura della pagina** (flessibile, adattala al tipo):

1. Titolo `H1` = nome leggibile della pagina
2. Sintesi in 2-4 righe
3. Sezioni di dettaglio
4. `## Riferimenti normativi` quando applicabile (articoli CdS, leggi)
5. `## Collegamenti` con wikilink alle pagine correlate
6. `## Fonti` con riferimenti ai file in `raw/`

**Wikilink**: usa la sintassi Obsidian `[[nome-file]]` o `[[nome-file|testo]]`
per i collegamenti interni. Per link a file in `raw/` usa il path relativo.

**Citazioni**: quando un'affermazione viene da una sorgente, indicala in linea:
`(fonte: raw/analisi-notifiche.md)`. Per affermazioni normative, cita l'articolo:
`(art. 142 c. 8 CdS)`.

---

## 3. Tassonomia di base

Categorie suggerite per orientare il lavoro. Espandile man mano.

- **concetti/** — entità concettuali del dominio: Verbale, Sanzione amministrativa,
  Trasgressione, Accertamento, Notifica, Decurtazione punti, Ricorso, ecc.
- **soggetti/** — attori coinvolti: Trasgressore, Conducente, Proprietario,
  Obbligato in solido, Agente accertatore, Organo accertatore, Prefetto,
  Giudice di Pace, ecc.
- **procedure/** — processi operativi: emissione verbale, notifica, pagamento
  in misura ridotta, rateazione, ricorso al Prefetto, ricorso al GdP,
  decurtazione punti, misure cautelari (fermo, sequestro), ecc.
- **normativa/** — articoli CdS (D.Lgs. 285/1992), leggi correlate (L. 689/1981
  ecc.), regolamenti, circolari ministeriali, sentenze rilevanti.
- **modello-dati/** — entità software, attributi, relazioni, stati, transizioni,
  regole di business, vincoli, codifiche.
- **analisi/** — documenti di design, decisioni architetturali, casi limite,
  comparazioni tra soluzioni, domande aperte.

---

## 4. Workflow: INGEST

Trigger: l'utente dice "ingerisci [file]" o segnala un nuovo file in `raw/`.
Se l'utente chiede di controllare l'intera cartella `raw/` (es. "ci sono
sorgenti nuove o cambiate?"), usa `wiki_list_raw` per ottenere in un colpo
solo filename + checksum attuale di tutti i file, e confrontali con
`wiki/sources.md` invece di chiamare `wiki_checksum` per ognuno.

1. **Calcola il checksum** del file con il tool `wiki_checksum` (primi 12 caratteri dello SHA256).
2. **Confronta con `wiki/sources.md`**:
   - File assente → primo ingest, procedi.
   - Checksum uguale → avvisa l'utente "file già processato, nessuna modifica rilevata" e **fermati** (a meno che l'utente forzi con "forza ingest").
   - Checksum diverso → aggiorna il checksum in `sources.md` e procedi segnalando "file aggiornato rispetto all'ultimo ingest".
3. **Leggi** la sorgente completa con `wiki_read_raw`.
4. **Discuti** con l'utente i punti chiave (3-7 punti), per allineamento.
5. **Decidi** quali pagine creare e quali aggiornare. Privilegia
   l'aggiornamento di pagine esistenti rispetto alla creazione di duplicati.
6. **Crea/aggiorna le pagine** con `wiki_write_page`:
   - Per ogni concetto/soggetto/procedura/entità nuova → pagina dedicata.
   - Per ogni pagina esistente impattata → integra le nuove informazioni,
     segnalando contraddizioni con `> ⚠ Contraddizione: ...` in linea.
   - Aggiorna cross-reference in entrambe le direzioni.
7. **Aggiorna `wiki/sources.md`** (con `wiki_write_page`) con il checksum e le pagine toccate.
8. **Aggiorna `index.md`** (con `wiki_write_page`) con le nuove pagine e i nuovi link.
9. **Appendi a `log.md`** con `wiki_append_log` una voce:

   ```
   ## [YYYY-MM-DD] ingest | nome-file-sorgente
   - Checksum: <sha256-12-chars>
   - Pagine create: [[pagina-1]], [[pagina-2]]
   - Pagine aggiornate: [[pagina-3]], [[pagina-4]]
   - Note: ...
   ```

10. **Riassumi all'utente** cosa è stato fatto, in 5-10 righe.

Un singolo ingest può toccare 5-15 pagine. Se ne toccherebbe di più, **fermati
e chiedi conferma** sullo scope.

---

## 5. Workflow: QUERY

Trigger: l'utente fa una domanda di dominio.

1. **Leggi `index.md`** (con `wiki_read_page`) per un quadro d'insieme, poi usa
   `wiki_search` (per `q`/`tag`/`tipo`/`stato`) o `wiki_list_pages` (per
   categoria) per individuare le pagine candidate senza affidarti solo
   all'indice manuale, che può essere disallineato.
2. **Leggi le pagine rilevanti** con `wiki_read_page` (di solito 3-8). Usa lo
   `snippet` restituito da `wiki_search` per scartare i candidati poco
   pertinenti prima di leggerli per intero.
3. **Sintetizza la risposta** con citazioni esplicite alle pagine wiki e,
   dove rilevante, alle sorgenti `raw/` (consultabili con `wiki_read_raw`).
4. **Proponi all'utente** se la risposta merita di essere filata:
   - come nuova pagina in `analisi/`,
   - come sezione aggiuntiva di una pagina esistente,
   - oppure di non filare nulla.
5. Se l'utente accetta, fila la risposta (`wiki_write_page`) e appendi a
   `log.md` con `wiki_append_log`:

   ```
   ## [YYYY-MM-DD] query | breve titolo della domanda
   - Pagine consultate: [[...]]
   - Filata in: [[...]]
   ```

---

## 6. Workflow: LINT

Trigger: l'utente dice "lint" o "controlla la wiki".

Usa `wiki_list_pages` per ottenere tutte le pagine con frontmatter, `wiki_graph`
per la mappa dei wikilink, e `wiki_status` per i conteggi per `tipo`/`stato` e
la data di ultimo aggiornamento. Controlla:

1. **Contraddizioni** tra pagine.
2. **Pagine stale**: due segnali distinti, entrambi da controllare:
   - `stato: da-rivedere` in `wiki_list_pages`/`wiki_status` (segnale esplicito).
   - Per ogni pagina, confronta i checksum correnti dei suoi `fonti` (via
     `wiki_list_raw`, un'unica chiamata per tutta `raw/`) con quelli registrati
     in `wiki/sources.md`: se un checksum è cambiato dopo l'ultimo `aggiornato`
     della pagina, la sorgente è stata aggiornata ma la pagina no.
3. **Orfani**: leggi direttamente il campo `orphans` di `wiki_graph` (già
   esclude `index.md`, `log.md`, `sources.md`, `overview.md`).
4. **Concetti senza pagina**: termini ricorrenti in più pagine ma privi di
   pagina propria.
5. **Cross-reference mancanti**: coppie A/B che dovrebbero linkarsi (verifica
   con il campo `reverse` di `wiki_graph`).
6. **Frontmatter inconsistente**: tag, tipi, date — confronta con `wiki_list_pages`.
7. **Link rotti**: nel campo `reverse` di `wiki_graph`, uno slug presente come
   chiave ma assente tra le pagine reali (`wiki_list_pages`) è un wikilink che
   punta a una pagina non ancora creata.
8. **Lacune di copertura**: aree del dominio sotto-documentate.

Produci un report sintetico in `analisi/lint-YYYY-MM-DD.md` e appendi a
`log.md`. **Non correggere automaticamente**: proponi all'utente cosa fixare.

---

## 7. `index.md`

Catalogo navigabile organizzato per categoria. Una riga per pagina, con
breve descrizione e conteggio fonti:

```markdown
# Index

## Concetti
- [[verbale-di-accertamento]] — atto formale dell'accertamento (3 fonti)
- [[sanzione-amministrativa]] — ...

## Soggetti
- [[trasgressore]] — soggetto a cui è imputata la violazione (2 fonti)

## Procedure
- ...

## Normativa
- ...

## Modello dati
- ...

## Analisi
- ...
```

Aggiorna a ogni ingest.

---

## 8. `log.md`

Append-only. Formato obbligatorio dell'intestazione voce (per parsabilità):

```
## [YYYY-MM-DD] <ingest|query|lint|refactor> | <titolo breve>
```

Consultazione rapida da shell:

```
grep "^## \[" wiki/log.md | tail -10
```

---

## 9. `sources.md`

Registro delle sorgenti processate. Aggiornato a ogni ingest.

Formato:

```markdown
# Sorgenti processate

| File | SHA256 (12 car.) | Ultimo ingest | Pagine toccate |
|------|-----------------|---------------|----------------|
| raw/foo.md | a3f1b2c4d5e6 | 2026-06-28 | [[verbale]], [[sanzione]] |
```

- Il checksum è calcolato con `sha256sum` (primi 12 caratteri dell'hash).
- La colonna "Pagine toccate" elenca tutte le pagine wiki che dipendono da
  quella sorgente, anche se aggiunte in ingest successivi.
- Se lo stesso file viene re-ingerito, aggiorna la riga esistente (non aggiungerne una nuova).

Consultazione rapida da shell:

```
grep "raw/" wiki/sources.md
```

---

## 10. `overview.md`

Sintesi corrente del dominio in 1-2 pagine. Aggiornata quando ingest o
analisi cambiano significativamente la comprensione. Non descrivere ogni
dettaglio: copri i concetti chiave, i workflow principali, i punti aperti,
e linka le pagine pertinenti.

---

## 11. Lingua e stile

- **Lingua**: italiano per contenuti wiki, frontmatter, `log.md` e `index.md`.
- **Terminologia**: usa termini ufficiali del CdS e della prassi (verbale,
  sanzione, decurtazione, ecc.). Mantieni un glossario inline nelle pagine
  concetto quando emergono sinonimi.
- **Tono**: tecnico-descrittivo, conciso, neutro. Niente fronzoli.
- **Lunghezza**: pagine concetto/soggetto ~50-200 righe. Pagine procedura
  possono essere più lunghe. Se una pagina supera ~400 righe, valuta lo split.
  Il criterio guida resta comunque la coerenza del frontmatter (§2, Granularità),
  non solo il conteggio righe: una pagina corta ma con temi/stati misti va
  comunque splittata.
- **Normativa**: cita articoli in forma standard (es. `art. 142 c. 8 CdS`).
  Per leggi correlate indica anno e numero (es. `L. 689/1981`).
- **Doppia natura del dominio**: distingui chiaramente, anche nello stesso
  argomento, tra (a) il concetto giuridico/normativo e (b) come il software
  lo modella. Quando utile, usa due sezioni `## Concetto` e `## Modello`
  nella stessa pagina, oppure due pagine separate linkate fra loro.

---

## 12. Divisione di responsabilità

| Layer        | Owner                                       |
| ------------ | ------------------------------------------- |
| `raw/`       | Utente (sola lettura per l'agente)          |
| `wiki/`      | Agente (scrittura completa)                 |
| `CLAUDE.md`  | Co-evoluto (utente decide, agente propone)  |

L'agente **non** modifica `raw/`. Mai. Se serve correggere una sorgente, lo
fa l'utente manualmente.

L'agente **non** modifica `CLAUDE.md` senza chiedere. Può proporre modifiche
quando emergono pattern ricorrenti non coperti dallo schema.

---

## 13. Quando chiedere all'utente

Fermati e chiedi quando:

- Una sorgente sembra fuori dominio.
- Un ingest toccherebbe più di 15 pagine.
- Emerge una contraddizione importante con la wiki esistente.
- Stai per creare più di 5 pagine nuove in un colpo solo.
- Lo schema attuale non copre il caso che hai davanti.

Negli altri casi: procedi, riassumi, e l'utente correggerà se serve.
