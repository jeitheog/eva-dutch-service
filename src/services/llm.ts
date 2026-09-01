/**
 * Traducción NL↔ES de Lingua vía el api_server interno del VPS
 * (POST http://127.0.0.1:8642/v1/chat/completions, model hermes, key
 * API_SERVER_KEY del /opt/data/.env — mismo patrón que llm.ts de
 * eva-youtube-intelligence).
 *
 * Cualquier fallo → fallback determinista (diccionario básico + respuesta
 * literal marcada used_llm:false): nunca se deja al usuario sin respuesta.
 */

import { config } from '../config'

export class LlmError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'LlmError'
  }
}

export interface LlmFetcher {
  (url: string, init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
}

const defaultLlmFetcher: LlmFetcher = async (url, init) => {
  const res = await fetch(url, { ...init, signal: init.signal })
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json().catch(() => ({})),
  }
}

export interface TranslateResult {
  /** Idioma objetivo de la traducción: 'nl' (holandés) | 'en' (inglés). */
  language: 'nl' | 'en'
  /** Texto en neerlandés (vacío si language='en'). */
  nl: string
  /** Texto en inglés (vacío si language='nl'). */
  en: string
  es: string
  pronunciation: string
  explanation: string
  examples: string[]
  used_llm: boolean
}

/** Diccionario básico del fallback determinista (frases cotidianas). */
const BASIC_DICT: Array<[string, string]> = [
  ['geef me de halter even', 'dame la mancuerna un momento'],
  ['geef me', 'dame'],
  ['de halter', 'la mancuerna'],
  ['even', 'un momento'],
  ['ik wil', 'quiero'],
  ['ik moet', 'tengo que'],
  ['dank je wel', 'muchas gracias'],
  ['alsjeblieft', 'por favor'],
  ['goedemorgen', 'buenos días'],
  ['goedenavond', 'buenas tardes'],
  ['tot ziens', 'hasta luego'],
  ['hoe gaat het', '¿cómo estás?'],
  ['ik begrijp het niet', 'no lo entiendo'],
  ['waar is', '¿dónde está'],
  ['hoeveel kost', '¿cuánto cuesta'],
  ['een biertje', 'una cerveza'],
  ['het water', 'el agua'],
  ['de rekening', 'la cuenta'],
  ['ik hou van je', 'te quiero'],
  ['mancuerna', 'halter (dumbbell)'],
]

/** Detecta si el texto parece holandés (heurística simple). */
export function looksDutch(text: string): boolean {
  const t = text.toLowerCase()
  const markers = ['ij', 'sch', 'je ', ' de ', ' het ', 'een ', 'geef', 'ik ', 'niet', 'zijn', 'voor']
  return markers.filter((m) => t.includes(m)).length >= 2
}

/** Detecta si el texto parece inglés (heurística simple). */
export function looksEnglish(text: string): boolean {
  const t = text.toLowerCase()
  const markers = ['the ', ' i ', 'you', 'is ', 'are ', 'this ', 'to ', 'for ', 'and ', 'with ']
  return markers.filter((m) => t.includes(m)).length >= 2
}

/**
 * Fallback determinista: dirección explícita o heurística. Con
 * language='en' devuelve el texto literal en el campo 'en' (marcado como
 * no-LLM para que el usuario sepa revisarlo).
 */
export function fallbackTranslate(text: string, direction?: string, language: 'nl' | 'en' = 'nl'): TranslateResult {
  const clean = text.trim()
  if (language === 'en') {
    return {
      language: 'en',
      nl: '',
      en: clean,
      es: clean,
      pronunciation: '',
      explanation: 'Traducción literal (LLM no disponible — revisa esta tarjeta).',
      examples: [],
      used_llm: false,
    }
  }
  const dir = direction ?? (looksDutch(clean) ? 'nl2es' : 'es2nl')
  const dict = BASIC_DICT.find(([nl]) => clean.toLowerCase().includes(nl))
  if (dict) {
    const [nl, es] = dict
    return {
      language: 'nl',
      nl,
      en: '',
      es,
      pronunciation: '',
      explanation: 'Traducción del diccionario básico (LLM no disponible).',
      examples: [],
      used_llm: false,
    }
  }
  if (dir === 'nl2es') {
    return {
      language: 'nl',
      nl: clean,
      en: '',
      es: clean,
      pronunciation: '',
      explanation: 'Traducción literal (LLM no disponible — revisa esta tarjeta).',
      examples: [],
      used_llm: false,
    }
  }
  return {
    language: 'nl',
    nl: clean,
    en: '',
    es: clean,
    pronunciation: '',
    explanation: 'Traducción literal (LLM no disponible — revisa esta tarjeta).',
    examples: [],
    used_llm: false,
  }
}

/** Extrae el primer objeto JSON balanceado de la respuesta del LLM. */
export function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth += 1
    else if (raw[i] === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function createTranslator(opts: { fetcher?: LlmFetcher; baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number } = {}) {
  const baseUrl = opts.baseUrl ?? config.llmBaseUrl
  const apiKey = opts.apiKey ?? config.llmApiKey
  const model = opts.model ?? config.llmModel
  const timeoutMs = opts.timeoutMs ?? 45_000
  const fetcher = opts.fetcher ?? defaultLlmFetcher

  return {
    async translate(text: string, direction?: string, language: 'nl' | 'en' = 'nl'): Promise<TranslateResult> {
      const clean = text.trim()
      if (!clean) throw new Error('text vacío')
      if (!apiKey) return fallbackTranslate(clean, direction, language)
      const system =
        language === 'en'
          ? [
              'Eres Lingua, un profesor de inglés para un hispanohablante.',
              'Traduce el texto dado entre inglés (en) y español (es).',
              'Responde SOLO con JSON válido con estas claves:',
              '{"en": string, "es": string, "pronunciation": string (fonética aproximada en español), "explanation": string (explicación breve de la frase/palabra), "examples": [string] (2-3 frases de ejemplo en inglés con su traducción al español)}',
              'Si el texto está en inglés, traduce a español y viceversa. La pronunciación va SIEMPRE en caracteres legibles para un hispanohablante.',
            ].join(' ')
          : [
              'Eres Lingua, un profesor de holandés para un hispanohablante.',
              'Traduce el texto dado entre holandés (nl) y español (es).',
              'Responde SOLO con JSON válido con estas claves:',
              '{"nl": string, "es": string, "pronunciation": string (fonética aproximada en español), "explanation": string (explicación breve de la frase/palabra), "examples": [string] (2-3 frases de ejemplo en holandés con su traducción al español)}',
              'Si el texto está en holandés, traduce a español y viceversa. La pronunciación va SIEMPRE en caracteres legibles para un hispanohablante.',
            ].join(' ')
      const user = `Dirección: ${direction ?? 'auto'}\nTexto: ${clean}`
      try {
        const res = await fetcher(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.4,
            max_tokens: 700,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
          throw new LlmError(`api_server devolvió ${res.status}`, res.status)
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
        const content = data.choices?.[0]?.message?.content
        if (typeof content !== 'string' || !content.trim()) throw new LlmError('respuesta vacía')
        const parsed = extractJson(content)
        if (!parsed) return fallbackTranslate(clean, direction, language)
        return {
          language,
          nl: language === 'en' ? '' : String(parsed.nl ?? clean),
          en: language === 'en' ? String(parsed.en ?? parsed.nl ?? clean) : '',
          es: String(parsed.es ?? clean),
          pronunciation: String(parsed.pronunciation ?? ''),
          explanation: String(parsed.explanation ?? ''),
          examples: Array.isArray(parsed.examples)
            ? parsed.examples.map((e) => String(e))
            : [],
          used_llm: true,
        }
      } catch (e) {
        if (e instanceof LlmError) throw e
        throw new LlmError((e as Error).message)
      }
    },
  }
}
