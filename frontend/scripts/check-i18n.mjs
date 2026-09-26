import { readFile } from "node:fs/promises";

const locales = ["en", "es", "tl"];

function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" ? flatten(child, path) : [[path, child]];
  });
}

const messages = Object.fromEntries(
  await Promise.all(
    locales.map(async (locale) => [locale, JSON.parse(await readFile(`messages/${locale}.json`, "utf8"))]),
  ),
);
const referenceEntries = flatten(messages.en);
const referenceKeys = new Set(referenceEntries.map(([key]) => key));
let failed = false;

for (const locale of locales.slice(1)) {
  const entries = flatten(messages[locale]);
  const keys = new Set(entries.map(([key]) => key));
  for (const key of referenceKeys) {
    if (!keys.has(key)) {
      console.error(`${locale}.json is missing ${key}`);
      failed = true;
    }
  }
  for (const [key, value] of entries) {
    if (typeof value !== "string" || value.trim() === "") {
      console.error(`${locale}.json has an empty translation at ${key}`);
      failed = true;
    }
  }
}

for (const [key, value] of referenceEntries) {
  if (typeof value !== "string" || value.trim() === "") {
    console.error(`en.json has an empty translation at ${key}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Translation key parity passed for ${locales.join(", ")}`);
