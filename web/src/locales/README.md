The interface defaults to English. The language control loads one local catalog at a time and saves the visitor's choice under `tape:language`. It does not reload the exchange, translate customer messages, or change financial values and input parsing.

English copy is the catalog key. Add each new message to all five JSON files. `tx(message, values)` uses numbered values such as `{0}`. `Localized` also supports numbered component tags such as `<0>link text</0>`; keep the same tags and values in every translation, in the order the language needs. Never put transaction payloads, addresses, customer text or editable form values through the translator.

Run `node --test web/test/i18n.test.mjs` from the repository root to check coverage, placeholders, recovery links, escaping and money formatting. `node web/e2e/languages.mjs` checks the browser flows.
