import { cloneElement, Fragment, useSyncExternalStore, type ReactElement, type ReactNode } from "react";

export const LANGUAGES = [
  { id: "en", name: "English", short: "EN" },
  { id: "zh-CN", name: "简体中文", short: "中" },
  { id: "ru", name: "Русский", short: "RU" },
  { id: "ko", name: "한국어", short: "한국" },
  { id: "ja", name: "日本語", short: "日本" },
] as const;
export type Locale = typeof LANGUAGES[number]["id"];
type Catalog = Record<string, string>;
const loaders = {
  "zh-CN": () => import("../locales/zh-CN.json"),
  ru: () => import("../locales/ru.json"),
  ko: () => import("../locales/ko.json"),
  ja: () => import("../locales/ja.json"),
};
const catalogs: Partial<Record<Locale, Catalog>> = { en: {} };
const pending: Partial<Record<Locale, Promise<Catalog>>> = {};
const listeners = new Set<() => void>();
export const LANGUAGE_KEY = "tape:language";
let locale: Locale = "en";
let selection = 0;
export const getLocale = () => locale;
export const isLocale = (value: unknown): value is Locale => LANGUAGES.some(language => language.id === value);
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useLocale = () => useSyncExternalStore(subscribe, getLocale, () => "en" as Locale);

/** Load only the requested language. Switching never remounts the exchange or resets an order. */
export async function setLocale(next: Locale, persist = true): Promise<void> {
  if (!isLocale(next)) return;
  const request = ++selection;
  if (!catalogs[next] && next !== "en") {
    const loading = pending[next] ??= loaders[next]().then(module => module.default);
    try { catalogs[next] = await loading; }
    catch (error) { delete pending[next]; throw error; }
  }
  if (request !== selection) return;
  locale = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    document.documentElement.dir = "ltr";
  }
  if (persist) { try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Storage may be disabled. */ } }
  for (const listener of listeners) listener();
}

/** English keys are the fallback. Values are never translated: prices, addresses and names stay intact. */
export function tx(message: string, values?: readonly unknown[]): string;
export function tx<T extends ReactNode>(message: T): T;
export function tx(message: ReactNode, values: readonly unknown[] = []): ReactNode {
  if (typeof message !== "string") return message;
  return translated(message).replace(/\{(\d+)\}/g, (token, index) => index in values ? String(values[Number(index)] ?? "") : token);
}
function translated(message: string): string {
  const catalog = catalogs[locale], key = message.trim();
  const replacement = catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  return replacement === undefined ? message : (message.match(/^\s*/)?.[0] ?? "") + replacement + (message.match(/\s*$/)?.[0] ?? "");
}

/** Numbered rich-text tags preserve links/emphasis and let each language put values in natural order. */
export function Localized({ message, values = [], components = [] }: { message: string; values?: ReactNode[]; components?: ReactElement<{ children?: ReactNode }>[] }) {
  useLocale();
  const render = (text: string): ReactNode[] => {
    const result: ReactNode[] = [];
    const pattern = /<(\d+)>([\s\S]*?)<\/\1>|\{(\d+)\}/g;
    let end = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index! > end) result.push(text.slice(end, match.index));
      if (match[1] !== undefined) {
        const component = components[Number(match[1])];
        result.push(component ? cloneElement(component, { key: match.index }, render(match[2])) : render(match[2]));
      } else result.push(<Fragment key={match.index}>{values[Number(match[3])]}</Fragment>);
      end = match.index! + match[0].length;
    }
    if (end < text.length) result.push(text.slice(end));
    return result;
  };
  return <>{render(translated(message))}</>;
}

export function restoreLocale(): void {
  try { const saved = localStorage.getItem(LANGUAGE_KEY); if (isLocale(saved)) void setLocale(saved, false).catch(() => {}); } catch { /* English remains usable. */ }
  window.addEventListener("storage", event => {
    if (event.key === LANGUAGE_KEY && isLocale(event.newValue)) void setLocale(event.newValue, false).catch(() => {});
  });
}
