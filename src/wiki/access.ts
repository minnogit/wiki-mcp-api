// Autorizzazione per pagina: decisa dal frontmatter (`visibilita`, `gruppi`) e dai gruppi del
// Principal. Funzioni pure, senza dipendenze dal transport né dal service: le usa il service per
// filtrare (search, list, graph, status, read) e le userà la scrittura remota della PR successiva
// con la stessa regola, così «chi può leggere» e «chi può scrivere» non divergono per caso.
//
// Regole (vedi README, sezione «Permessi per pagina»):
// - nessun principal (`undefined`: stdio locale) = fiducia piena, vede e scrive tutto;
// - il gruppo `admin` vede e scrive tutto nella wiki;
// - `visibilita` assente, `pubblica` o `interna`: aperta a ogni principal che ha accesso alla wiki
//   (`interna` oggi vale come `pubblica`: è un'etichetta riservata a distinzioni future, ad esempio
//   l'accesso anonimo; non ha altre regole);
// - `riservata`: solo chi ha almeno un gruppo tra quelli in `gruppi`; senza `gruppi` (o vuoto)
//   solo `admin`;
// - fail-closed: un valore di `visibilita` sconosciuto (refuso) vale `riservata`, mai `pubblica`;
// - `gruppi` su una pagina non riservata non ha effetto.

import type { Principal } from '../auth.js'
import type { DeniedReason } from '../audit.js'

export const VISIBILITA = ['pubblica', 'interna', 'riservata'] as const
export type Visibilita = (typeof VISIBILITA)[number]

/** Gruppo speciale: vede e scrive tutto nella wiki, comprese le riservate senza `gruppi`. */
export const ADMIN_GROUP = 'admin'

/** I soli campi del frontmatter che contano per i permessi. */
export interface AccessFields {
  /** Valore di `visibilita`; qualunque stringa fuori da `VISIBILITA` è trattata come `riservata`. */
  visibilita?: string
  gruppi?: readonly string[]
  /** Presente se il valore originale era sconosciuto (già normalizzato a `riservata`): solo per il motivo del rifiuto. */
  visibilitaNonValida?: string
}

/** Una pagina (o un oggetto con `frontmatter`) oppure i soli campi di accesso. */
export type AccessSubject = AccessFields | { frontmatter: AccessFields }

export type Action = 'read' | 'write'

export type AccessDecision = { allowed: true } | { allowed: false; reason: DeniedReason }

/** Campi di accesso letti da un frontmatter YAML grezzo, già normalizzati. */
export interface ParsedAccess {
  /** assente se il campo non c'è; `riservata` anche per un valore sconosciuto (fail-closed) */
  visibilita?: Visibilita
  /** sempre una lista: un valore non-lista vale lista vuota */
  gruppi: string[]
  /** il valore sconosciuto trovato (troncato), per segnalarlo; assente se valido o assente */
  visibilitaNonValida?: string
}

const isVisibilita = (v: unknown): v is Visibilita =>
  typeof v === 'string' && (VISIBILITA as readonly string[]).includes(v)

/**
 * Legge `visibilita` e `gruppi` da un frontmatter grezzo. Non lancia mai: un valore sconosciuto
 * diventa `riservata` con `visibilitaNonValida` valorizzato; `gruppi` che non è una lista vale vuoto.
 */
export function parseAccess(data: Record<string, unknown>): ParsedAccess {
  const gruppi = Array.isArray(data.gruppi)
    ? [...new Set(data.gruppi.map((g) => String(g).trim()).filter((g) => g !== ''))]
    : []
  if (data.visibilita === undefined) return { gruppi }
  if (isVisibilita(data.visibilita)) return { visibilita: data.visibilita, gruppi }
  const raw =
    typeof data.visibilita === 'string' ? data.visibilita : JSON.stringify(data.visibilita)
  return { visibilita: 'riservata', gruppi, visibilitaNonValida: (raw ?? 'null').slice(0, 40) }
}

const fieldsOf = (s: AccessSubject): AccessFields => ('frontmatter' in s ? s.frontmatter : s)

/**
 * Decisione completa, con il motivo del rifiuto (vocabolario chiuso, per l'audit).
 * `principal` `undefined` = locale, fiducia piena.
 */
export function authorize(
  subject: AccessSubject,
  principal: Principal | undefined,
  // Oggi lettura e scrittura hanno la stessa regola: la scrittura remota non esiste ancora (la
  // introduce la PR successiva, che chiamerà `canWrite`). Il parametro c'è perché le due regole
  // potranno divergere (es. leggere sì, scrivere no) senza cambiare i chiamanti.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _action: Action = 'read',
): AccessDecision {
  if (!principal) return { allowed: true }
  if (principal.groups.includes(ADMIN_GROUP)) return { allowed: true }
  const { visibilita, gruppi = [], visibilitaNonValida } = fieldsOf(subject)
  if (visibilita === undefined || visibilita === 'pubblica' || visibilita === 'interna')
    return { allowed: true }
  // `riservata`, o un valore sconosciuto che vale come tale
  if (gruppi.some((g) => principal.groups.includes(g))) return { allowed: true }
  const known = visibilita === 'riservata' && visibilitaNonValida === undefined
  return { allowed: false, reason: known ? 'visibility' : 'visibility-invalid' }
}

/** Questo principal può leggere la pagina? */
export function canRead(subject: AccessSubject, principal: Principal | undefined): boolean {
  return authorize(subject, principal, 'read').allowed
}

/**
 * Questo principal può scrivere la pagina? Oggi coincide con `canRead`, e la scrittura da remoto
 * non esiste ancora: la userà la PR successiva (scrittura remota con PR), che dovrà chiamarla
 * prima di accettare una modifica. Su stdio (`principal` `undefined`) è sempre `true`.
 */
export function canWrite(subject: AccessSubject, principal: Principal | undefined): boolean {
  return authorize(subject, principal, 'write').allowed
}

/** Predicato per filtrare liste di pagine: `pages.filter(visibleTo(principal))`. */
export function visibleTo(
  principal: Principal | undefined,
): <T extends AccessSubject>(subject: T) => boolean {
  return (subject) => canRead(subject, principal)
}
