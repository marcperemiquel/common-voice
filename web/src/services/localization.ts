import 'intl-pluralrules'; // polyfill Intl.PluralRules
const { negotiateLanguages } = require('@fluent/langneg');
const locales = require('../../../locales/all.json') as string[];
export const NATIVE_NAMES = require('../../../locales/native-names.json') as {
  [key: string]: string;
};
const translatedLocales = require('../../../locales/translated.json');
import { FluentBundle, FluentResource } from '@fluent/bundle';
import { ReactLocalization } from '@fluent/react';
import { Flags } from '../stores/flags';
import { isProduction } from '../utility';
import API from './api';
import MessageOverwrites = Flags.MessageOverwrites;

export const DEFAULT_LOCALE = 'en';
export const LOCALES = isProduction()
  ? (translatedLocales as string[])
  : locales;
export const LOCALES_WITH_NAMES = LOCALES.map(code => {
  return {
    code,
    name: NATIVE_NAMES[code] || code,
  };
}).sort((localeA, localeB) => {
  return localeA.name.localeCompare(localeB.name);
});

export function negotiateLocales(locales: ReadonlyArray<string>) {
  return negotiateLanguages(locales, LOCALES, {
    defaultLocale: DEFAULT_LOCALE,
  });
}

// By implementing the sequence of FluentBundles as a generator, the cost of
// parsing fallback resources is deferred to until they're needed.
export function* asBundleGenerator(
  localeMessages: string[][],
  messageOverwrites?: MessageOverwrites
) {
  for (const [locale, messages] of localeMessages) {
    const bundle = new FluentBundle(locale, { useIsolating: false });
    bundle.addResource(
      new FluentResource(
        messages +
          (messageOverwrites?.[locale] ? '\n' + messageOverwrites[locale] : '')
      )
    );
    yield bundle;
  }
}

export function createCrossLocalization(
  localeMessages: string[][],
  locales: string[]
) {
  const currentLocales = negotiateLocales([...locales, ...navigator.languages]);

  localeMessages = localeMessages
    .filter(([locale]) => currentLocales.includes(locale))
    .sort(([locale1], [locale2]) =>
      currentLocales.indexOf(locale1) > currentLocales.indexOf(locale2) ? 1 : -1
    );

  return new ReactLocalization(asBundleGenerator(localeMessages));
}

export async function createLocalization(
  api: API,
  userLocales: string[],
  messageOverwrites: MessageOverwrites
) {
  const currentLocales = negotiateLocales(userLocales);

  const localeMessages: any = await Promise.all(
    currentLocales.map(async (locale: string) => [
      locale,
      await api.fetchLocaleMessages(locale),
    ])
  );

  return new ReactLocalization(
    asBundleGenerator(localeMessages, messageOverwrites)
  );
}
