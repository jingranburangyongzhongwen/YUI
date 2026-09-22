import { type Locale, subscribe as subscribeLocale } from "../../ui/i18n";

interface CueLocaleStore {
  syncLocale(previous: Locale, next: Locale): void;
}

/** Reseeds the built-in cues a display-language change leaves in the old language. */
export function wireCueLocaleSync(stores: {
  proactiveSettings: CueLocaleStore;
  scheduleSettings: CueLocaleStore;
}): () => void {
  return subscribeLocale((locale, previous) => {
    stores.proactiveSettings.syncLocale(previous, locale);
    stores.scheduleSettings.syncLocale(previous, locale);
  });
}
