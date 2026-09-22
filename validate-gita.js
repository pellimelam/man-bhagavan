const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "translation-config.json");

const config = JSON.parse(
  fs.readFileSync(CONFIG_PATH, "utf8")
);

const SOURCE_FILE = path.join(
  __dirname,
  config.project.sourceFile
);

function fail(message) {
  console.error(`\nVALIDATION FAILED: ${message}\n`);
  process.exit(1);
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`File not found: ${path.basename(filePath)}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(
      `${path.basename(filePath)} contains invalid JSON: ${error.message}`
    );
  }
}

function getExpectedIds() {
  return Array.from(
    { length: config.project.totalEntries },
    (_, index) => `gita_${index + 1}`
  );
}

function getObjectKeys(object) {
  return Object.keys(object).sort();
}

function validateExactKeys(object, expectedKeys, label) {
  const actualKeys = getObjectKeys(object);
  const requiredKeys = [...expectedKeys].sort();

  if (
    JSON.stringify(actualKeys) !==
    JSON.stringify(requiredKeys)
  ) {
    fail(
      `${label} has incorrect keys.\n` +
        `Expected: ${requiredKeys.join(", ")}\n` +
        `Found: ${actualKeys.join(", ")}`
    );
  }
}

function extractSanskritVerse(content, entryId) {
  if (typeof content !== "string") {
    fail(
      `${entryId}: content must be a string.`
    );
  }

  const match = content.match(
    /(?:^|\n)శ్లోకం:\s*\n([\s\S]*?)(?:\n\n|$)/
  );

  if (!match) {
    fail(
      `${entryId}: Sanskrit verse could not be located.`
    );
  }

  return match[1].trim();
}

function validateSource(source) {
  console.log("Validating source JSON...");

  if (!Array.isArray(source)) {
    fail("Source must be a top-level JSON array.");
  }

  if (
    source.length !==
    config.project.totalEntries
  ) {
    fail(
      `Source must contain exactly ${config.project.totalEntries} entries. Found ${source.length}.`
    );
  }

  const expectedIds = getExpectedIds();

  const expectedKeys = [
    "id",
    "title",
    "content"
  ];

  const seenIds = new Set();

  source.forEach((entry, index) => {
    const expectedId = expectedIds[index];

    if (!entry || typeof entry !== "object") {
      fail(
        `Source entry ${index + 1} is not an object.`
      );
    }

    validateExactKeys(
      entry,
      expectedKeys,
      expectedId
    );

    if (entry.id !== expectedId) {
      fail(
        `Source order/ID mismatch at position ${
          index + 1
        }. Expected ${expectedId}, found ${entry.id}.`
      );
    }

    if (seenIds.has(entry.id)) {
      fail(
        `Duplicate source ID detected: ${entry.id}`
      );
    }

    seenIds.add(entry.id);

    if (
      typeof entry.title !== "string" ||
      !entry.title.trim()
    ) {
      fail(
        `${entry.id}: title is empty.`
      );
    }

    if (
      typeof entry.content !== "string" ||
      !entry.content.trim()
    ) {
      fail(
        `${entry.id}: content is empty.`
      );
    }

    extractSanskritVerse(
      entry.content,
      entry.id
    );
  });

  console.log(
    `Source validation passed: ${source.length} entries.`
  );
}

function validateTranslatedFile(
  filePath,
  source,
  sourceVerses
) {
  const languageName =
    path.basename(filePath);

  console.log(
    `\nValidating ${languageName}...`
  );

  const translated = loadJson(filePath);

  if (!Array.isArray(translated)) {
    fail(
      `${languageName}: top-level value must be an array.`
    );
  }

  if (
    translated.length !==
    source.length
  ) {
    fail(
      `${languageName}: expected ${source.length} entries, found ${translated.length}.`
    );
  }

  const expectedKeys = [
    "id",
    "title",
    "content"
  ];

  const seenIds = new Set();

  translated.forEach(
    (entry, index) => {
      const sourceEntry = source[index];
      const expectedId = sourceEntry.id;

      if (!entry || typeof entry !== "object") {
        fail(
          `${languageName}: entry ${index + 1} is not an object.`
        );
      }

      validateExactKeys(
        entry,
        expectedKeys,
        `${languageName} ${expectedId}`
      );

      if (entry.id !== expectedId) {
        fail(
          `${languageName}: entry ${
            index + 1
          } must have ID ${expectedId}, found ${entry.id}.`
        );
      }

      if (seenIds.has(entry.id)) {
        fail(
          `${languageName}: duplicate ID detected: ${entry.id}`
        );
      }

      seenIds.add(entry.id);

      if (
        typeof entry.title !== "string" ||
        !entry.title.trim()
      ) {
        fail(
          `${languageName}: ${entry.id} has an empty title.`
        );
      }

      if (
        typeof entry.content !== "string" ||
        !entry.content.trim()
      ) {
        fail(
          `${languageName}: ${entry.id} has empty content.`
        );
      }

      const expectedVerse =
        sourceVerses.get(expectedId);

      const translatedVerse =
        extractAnySupportedSanskritVerse(
          entry.content,
          languageName,
          expectedId
        );

      if (
        translatedVerse !==
        expectedVerse
      ) {
        fail(
          `${languageName}: Sanskrit verse was modified in ${expectedId}.`
        );
      }
    }
  );

  console.log(
    `${languageName}: validation passed.`
  );
}

function extractAnySupportedSanskritVerse(
  content,
  fileName,
  entryId
) {
  const labels = [
    "శ్లోకం",
    "श्लोक",
    "श्लोकः",
    "श्लोकम्",
    "Verse",
    "Sloka",
    "শ্লোক",
    "শ্লোকঃ",
    "ಶ್ಲೋಕ",
    "ಶ್ಲೋಕಃ",
    "ശ്ലോകം",
    "ശ്ലോക",
    "சுலோகம்",
    "சுலோகம்:",
    "ਸਲੋਕ",
    "ਸਲੋਕ:",
    "ଶ୍ଲୋକ",
    "શ્લોક",
    "श्लोक:",
    "شلوک",
    "شلوک:"
  ];

  for (const label of labels) {
    const escapedLabel =
      label.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    const pattern = new RegExp(
      `(?:^|\\n)${escapedLabel}\\s*:?\\s*\\n([\\s\\S]*?)(?:\\n\\n|$)`,
      "i"
    );

    const match =
      content.match(pattern);

    if (match) {
      return match[1].trim();
    }
  }

  fail(
    `${fileName}: ${entryId}: could not locate Sanskrit verse.`
  );
}

function buildSourceVerseMap(source) {
  const map = new Map();

  source.forEach((entry) => {
    map.set(
      entry.id,
      extractSanskritVerse(
        entry.content,
        entry.id
      )
    );
  });

  return map;
}

function validateAllTranslations(source) {
  const sourceVerses =
    buildSourceVerseMap(source);

  console.log(
    `\nConfigured languages: ${config.languages.length}`
  );

  let completeFiles = 0;

  for (const language of config.languages) {
    const filePath = path.join(
      __dirname,
      language.file
    );

    if (!fs.existsSync(filePath)) {
      console.log(
        `${language.file}: not generated yet — skipped.`
      );
      continue;
    }

    validateTranslatedFile(
      filePath,
      source,
      sourceVerses
    );

    completeFiles++;
  }

  console.log(
    `\nValidated translation files: ${completeFiles}/${config.languages.length}`
  );
}

function main() {
  console.log(
    "=========================================="
  );
  console.log(
    "VIDHWAAN GITA STRUCTURAL VALIDATOR"
  );
  console.log(
    "=========================================="
  );

  const source =
    loadJson(SOURCE_FILE);

  validateSource(source);

  validateAllTranslations(source);

  console.log(
    "\n=========================================="
  );
  console.log(
    "ALL AVAILABLE VALIDATIONS PASSED"
  );
  console.log(
    "=========================================="
  );
}

main();
