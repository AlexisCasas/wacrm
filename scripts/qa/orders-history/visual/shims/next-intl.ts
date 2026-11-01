import messages from '../../../../../messages/es.json'

type Dict = Record<string, string>
export function useTranslations(ns: string) {
  const dict = ((messages as unknown as Record<string, Dict>)[ns] ?? {}) as Dict
  return (key: string, params?: Record<string, unknown>) => {
    let s = dict[key] ?? `[missing:${ns}.${key}]`
    for (const [k, v] of Object.entries(params ?? {})) s = s.replace(`{${k}}`, String(v))
    return s
  }
}
export const useLocale = () => 'es'
