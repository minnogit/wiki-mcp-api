# Wiki – Dominio: <nome del dominio>

> **Questo è un file template.** Copialo nella directory della tua wiki
> (accanto a `raw/` e `wiki/`, puntate da `WIKI_PATH`/`RAW_PATH`) e
> personalizza ogni sezione: il titolo, la descrizione del dominio, gli
> esempi di pagine/tag/categorie. Le parti tra `<...>` vanno sostituite; il
> resto (workflow INGEST/QUERY/LINT, forma del frontmatter, tool MCP da
> usare) è pensato per restare valido per qualunque dominio. La lingua dei
> contenuti (qui l'italiano, a titolo di esempio) è anch'essa una scelta del
> progetto: cambiala se serve, basta restare coerenti in tutta la wiki.

Questa è la configurazione che guida l'agente nella manutenzione di una wiki
personale di concetti di dominio per <descrivi qui in una riga il dominio
applicativo — es. "un CRM immobiliare", "un sistema di fatturazione SaaS",
"un gioco da tavolo e le sue regole", "una codebase e le sue convenzioni
architetturali">.

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
    ├── concetti/      # concetti di dominio (<Entità-1>, <Entità-2>, ecc.)
    ├── soggetti/      # ruoli e attori (<Ruolo-1>, <Ruolo-2>, ecc.)
    ├── procedure/     # workflow e processi (<Processo-1>, <Processo-2>, ecc.)
    ├── normativa/     # riferimenti normativi/regolamentari, se il dominio ne ha
    ├── modello-dati/  # entità software, relazioni, stati, regole di business
    ├── analisi/       # decisioni di design, casi limite, comparazioni
    └── architettura/  # documenti trasversali a più servizi (usa tipo: analisi)
```

Le sottocartelle in `wiki/` sono indicative: aggiungile, rinominale o fondile
quando emergono nuove categorie, e rimuovi quelle che non si applicano al tuo
dominio (es. `normativa/` non serve se non c'è alcun aspetto regolamentare).
Non creare cartelle vuote "per il futuro".

---

## 2. Convenzioni delle pagine

**Naming**: `kebab-case` nella lingua scelta per il progetto. Esempi:
`<entita-principale>.md`, `<azione-chiave>.md`, `<ruolo-chiave>.md`. Niente
abbreviazioni se non sono di uso comune nel dominio.

**Frontmatter YAML** in cima a ogni pagina:

```yaml
---
tipo: concetto | soggetto | procedura | normativa | entita | analisi
tags: [<tag-1>, <tag-2>, ...]
fonti: [raw/nome-file-1.md, raw/nome-file-2.md]
aggiornato: YYYY-MM-DD
stato: bozza | stabile | da-rivedere
---
```

I valori di `tipo` sono un punto di partenza plausibile per domini con una
componente regolamentare/normativa; adattali al tuo — rimuovi `normativa` se
non si applica, aggiungi altri valori se il dominio ha categorie proprie che
gli enum sopra non colgono (basta restare coerenti nel tempo).

**Tag**: prima di inventare un tag nuovo, controlla se esiste già uno
equivalente (`wiki_search` senza `q`, o scorri `tags:` di pagine simili) e
riusalo — anche se il nome che avresti scelto tu è leggermente diverso
(plurale/singolare, sinonimo). Preferisci il **singolare** per i tag
concettuali, salvo quando il plurale identifica un'entità di codice con quel
nome esatto (es. una classe chiamata `Ordini`) o una collezione (es.
`regole-ordini` per un catalogo di regole). Un tag usato una sola volta non
è un problema in sé (serve comunque da parola chiave per la ricerca
testuale); lo è quando **duplica** — con parola diversa o forma diversa — un
tag già usato altrove per lo stesso concetto: una wiki reale si è già
trovata con coppie come `notifica`/`notifiche`, `posizione-debitoria`/
`posizioni-debitorie`, `transazione`/`transazioni` a indicare la stessa cosa
su pagine diverse, rendendo inutile il filtro per tag esatto. Attenzione
anche al caso opposto: due concetti distinti che condividono una parola non
vanno forzati sotto lo stesso tag solo per assonanza (es. una "notifica" di
dominio inviata a un utente finale vs una "notifica" UI/toast mostrata
nell'interfaccia — restano tag distinti anche se la parola è la stessa).
Rivedi periodicamente (in un LINT) la distribuzione dei tag: un solo tag
usato sulla quasi totalità delle pagine è spesso il nome del progetto/dominio
stesso — non è un errore, ma non serve a filtrare nulla, e non va confuso col
problema dei quasi-duplicati.

Se lavori con un issue tracker (Jira, GitHub Issues, ecc.), **non taggare i
riferimenti ai singoli ticket** (es. `PROJ-1234`): un ticket compare tipicamente
su 1-2 pagine, quindi il tag non raggruppa nulla, e il codice da solo non è
informativo senza aprire il tracker. Il riferimento resta comunque utile **nel
corpo della pagina**, in linea vicino all'affermazione che documenta — è lì
che va, non nel frontmatter.

**Granularità**: una pagina = un solo `tipo` e un solo tema coerente.
Se un argomento contiene sotto-concetti con natura o stato diversi (es. un
aspetto "stabile" e uno ancora "da-rivedere", o un concetto di dominio insieme
al suo modello software), valuta lo split in più pagine linkate invece di
un frontmatter unico che li appiattisce. Frontmatter e contenuto coerenti
rendono `wiki_search` (filtri per tag/tipo/stato + ranking sul contenuto)
affidabile; una pagina che mescola temi diversi diluisce entrambi.

**Struttura della pagina** (flessibile, adattala al tipo):

1. Titolo `H1` = nome leggibile della pagina
2. Sintesi in 2-4 righe
3. Sezioni di dettaglio
4. `## Riferimenti normativi` quando applicabile (solo per domini regolamentati)
5. `## Collegamenti` con wikilink alle pagine correlate
6. `## Fonti` con riferimenti ai file in `raw/`

**Wikilink**: usa la sintassi Obsidian `[[nome-file]]` o `[[nome-file|testo]]`
per i collegamenti interni. Per link a file in `raw/` usa il path relativo.

**Citazioni**: quando un'affermazione viene da una sorgente, indicala in linea:
`(fonte: raw/analisi-esempio.md)`. Per affermazioni normative/regolamentari,
cita la fonte precisa nel formato standard del tuo dominio (es. un articolo
di legge, una clausola contrattuale, una sezione di uno standard).

---

## 3. Tassonomia di base

Categorie suggerite per orientare il lavoro. Sono un esempio generico:
sostituisci gli elenchi con i concetti/ruoli/processi reali del tuo dominio,
ed espandi man mano che emergono.

- **concetti/** — entità concettuali del dominio: <esempio: per un CRM
  immobiliare sarebbero Immobile, Trattativa, Mandato, Provvigione; per un
  gioco da tavolo, Carta, Turno, Punteggio>.
- **soggetti/** — attori coinvolti: <esempio: Cliente, Agente, Operatore,
  Amministratore — chiunque compia o subisca un'azione nel dominio>.
- **procedure/** — processi operativi: <esempio: onboarding di un cliente,
  chiusura di una trattativa, elaborazione di un rimborso>.
- **normativa/** — riferimenti normativi/regolamentari, se il dominio ne ha
  (leggi, regolamenti, policy interne, standard di settore, sentenze
  rilevanti). Ometti questa cartella se non si applica.
- **modello-dati/** — entità software, attributi, relazioni, stati,
  transizioni, regole di business, vincoli, codifiche.
- **analisi/** — documenti di design, decisioni architetturali, casi limite,
  comparazioni tra soluzioni, domande aperte.
- **architettura/** — documenti trasversali a più servizi dell'ecosistema
  (mappe di sistema, strategie di migrazione, integrazione tra servizi).
  Usa `tipo: analisi` come le altre pagine di analisi: la cartella è solo
  organizzativa, non introduce un valore `tipo` proprio.

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
   Per i tag, oltre a valori palesemente sbagliati, controlla la
   distribuzione: pochi tag usati su molte pagine e una lunga coda di tag
   usati una sola volta è normale, ma cerca specificamente **coppie
   quasi-duplicate** (singolare/plurale, sinonimi) che spezzano un cluster
   reale in due — vedi §2 sopra.
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
- [[<entita-1>]] — <breve descrizione> (3 fonti)
- [[<entita-2>]] — ...

## Soggetti
- [[<ruolo-1>]] — <breve descrizione> (2 fonti)

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
| raw/foo.md | a3f1b2c4d5e6 | 2026-06-28 | [[entita-1]], [[entita-2]] |
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

- **Lingua**: scegli una lingua per contenuti wiki, frontmatter, `log.md` e
  `index.md`, e mantienila coerente in tutto il progetto (qui si esemplifica
  in italiano, ma il criterio vale per qualunque lingua).
- **Terminologia**: usa i termini ufficiali/di uso comune nel tuo dominio,
  non parafrasi generiche. Mantieni un glossario inline nelle pagine
  concetto quando emergono sinonimi.
- **Tono**: tecnico-descrittivo, conciso, neutro. Niente fronzoli.
- **Lunghezza**: pagine concetto/soggetto ~50-200 righe. Pagine procedura
  possono essere più lunghe. Se una pagina supera ~400 righe, valuta lo split.
  Il criterio guida resta comunque la coerenza del frontmatter (§2, Granularità),
  non solo il conteggio righe: una pagina corta ma con temi/stati misti va
  comunque splittata.
- **Riferimenti a fonti normative/regolamentari**: se il dominio ne ha, cita
  nel formato standard del settore (es. articolo di legge, sezione di uno
  standard, clausola contrattuale) — definisci qui la forma canonica e
  usala ovunque nella wiki.
- **Doppia natura del dominio** (se applicabile): molti domini hanno una
  componente "di specifica" (normativa, contrattuale, di business) distinta
  da come il software la implementa. Se è il tuo caso, distingui chiaramente,
  anche nello stesso argomento, tra (a) il concetto di dominio/specifica e
  (b) come il software lo modella. Quando utile, usa due sezioni
  `## Concetto` e `## Modello` nella stessa pagina, oppure due pagine
  separate linkate fra loro.

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
