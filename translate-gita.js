const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "translation-config.json");
const GLOSSARY_PATH = path.join(__dirname, "translation-glossary.json");

const config = JSON.parse(
  fs.readFileSync(CONFIG_PATH, "utf8")
);

const glossary = JSON.parse(
  fs.readFileSync(GLOSSARY_PATH, "utf8")
);

const API_KEY = process.env.GROQ_API_KEY;

if (!API_KEY) {
  console.error("ERROR: GROQ_API_KEY is not set.");
  process.exit(1);
}

const API_URL = "https://api.groq.com/openai/v1/chat/completions";

const MODEL = config.project.model;
const BATCH_SIZE = config.project.batchSize;
const MAX_RETRIES = config.project.maxRetries;

const SOURCE_FILE = path.join(
  __dirname,
  config.project.sourceFile
);

const source = JSON.parse(
  fs.readFileSync(SOURCE_FILE, "utf8")
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getLanguageFromArgument() {
  const argument = process.argv[2];

  if (!argument) {
    console.error("");
    console.error("ERROR: Language code is required.");
    console.error("");
    console.error("Examples:");
    console.error("  node translate-gita.js en");
    console.error("  node translate-gita.js hi");
    console.error("  node translate-gita.js ta");
    console.error("");
    process.exit(1);
  }

  const normalized = argument.toLowerCase();

  const language = config.languages.find(
    item =>
      item.code.toLowerCase() === normalized ||
      item.name.toLowerCase() === normalized ||
      item.file.toLowerCase() === normalized
  );

  if (!language) {
    console.error(
      `ERROR: Language not found in translation-config.json: ${argument}`
    );
    process.exit(1);
  }

  return language;
}

function validateSource() {
  if (!Array.isArray(source)) {
    throw new Error("Source file must contain a JSON array.");
  }

  if (
    config.validation.requireExactly100Entries &&
    source.length !== config.project.totalEntries
  ) {
    throw new Error(
      `Source must contain exactly ${config.project.totalEntries} entries. Found ${source.length}.`
    );
  }

  const ids = new Set();

  for (let i = 0; i < source.length; i++) {
    const entry = source[i];

    if (!entry || typeof entry !== "object") {
      throw new Error(
        `Source entry ${i + 1} is invalid.`
      );
    }

    const expectedId = `gita_${i + 1}`;

    if (entry.id !== expectedId) {
      throw new Error(
        `Source entry ${i + 1} must have id ${expectedId}. Found ${entry.id}.`
      );
    }

    if (ids.has(entry.id)) {
      throw new Error(
        `Duplicate source id: ${entry.id}`
      );
    }

    ids.add(entry.id);

    if (
      typeof entry.title !== "string" ||
      entry.title.trim() === ""
    ) {
      throw new Error(
        `Source ${entry.id} has an empty title.`
      );
    }

    if (
      typeof entry.content !== "string" ||
      entry.content.trim() === ""
    ) {
      throw new Error(
        `Source ${entry.id} has empty content.`
      );
    }
  }
}

function getSanskritVerse(content) {
  if (typeof content !== "string") {
    return null;
  }

  const match = content.match(
    /(?:శ్లోకం|श्लोक|श्लोकः|Verse|Sloka|śloka)\s*:\s*([\s\S]*?)(?:\n\s*\n|$)/i
  );

  return match
    ? match[1].trim()
    : null;
}

function extractSanskritMap(entries) {
  const map = new Map();

  for (const entry of entries) {
    const verse = getSanskritVerse(entry.content);

    if (!verse) {
      throw new Error(
        `Could not extract Sanskrit verse from ${entry.id}.`
      );
    }

    map.set(entry.id, verse);
  }

  return map;
}

function buildSchema(batchLength) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      entries: {
        type: "array",
        minItems: batchLength,
        maxItems: batchLength,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string"
            },
            title: {
              type: "string"
            },
            content: {
              type: "string"
            }
          },
          required: [
            "id",
            "title",
            "content"
          ]
        }
      }
    },
    required: [
      "entries"
    ]
  };
}

function validateTranslatedBatch(
  translated,
  sourceBatch,
  language
) {
  if (!Array.isArray(translated)) {
    throw new Error(
      `${language.name}: Groq response is not an array.`
    );
  }

  if (translated.length !== sourceBatch.length) {
    throw new Error(
      `${language.name}: expected ${sourceBatch.length} entries but received ${translated.length}.`
    );
  }

  const sourceSanskrit =
    extractSanskritMap(sourceBatch);

  const ids = new Set();

  for (let i = 0; i < sourceBatch.length; i++) {
    const sourceEntry = sourceBatch[i];
    const translatedEntry = translated[i];

    if (
      !translatedEntry ||
      typeof translatedEntry !== "object" ||
      Array.isArray(translatedEntry)
    ) {
      throw new Error(
        `${language.name}: ${sourceEntry.id} is not a valid object.`
      );
    }

    const keys = Object.keys(
      translatedEntry
    ).sort();

    if (
      keys.length !== 3 ||
      keys[0] !== "content" ||
      keys[1] !== "id" ||
      keys[2] !== "title"
    ) {
      throw new Error(
        `${language.name}: ${sourceEntry.id} has invalid object structure.`
      );
    }

    if (
      translatedEntry.id !== sourceEntry.id
    ) {
      throw new Error(
        `${language.name}: expected ${sourceEntry.id}, received ${translatedEntry.id}.`
      );
    }

    if (ids.has(translatedEntry.id)) {
      throw new Error(
        `${language.name}: duplicate id ${translatedEntry.id}.`
      );
    }

    ids.add(translatedEntry.id);

    if (
      typeof translatedEntry.title !== "string" ||
      translatedEntry.title.trim() === ""
    ) {
      throw new Error(
        `${language.name}: ${translatedEntry.id} has empty title.`
      );
    }

    if (
      typeof translatedEntry.content !== "string" ||
      translatedEntry.content.trim() === ""
    ) {
      throw new Error(
        `${language.name}: ${translatedEntry.id} has empty content.`
      );
    }

    const expectedSanskrit =
      sourceSanskrit.get(sourceEntry.id);

    if (
      !translatedEntry.content.includes(
        expectedSanskrit
      )
    ) {
      throw new Error(
        `${language.name}: Sanskrit verse changed or missing in ${sourceEntry.id}.`
      );
    }
  }

  return true;
}

function buildSystemPrompt(language) {
  return `
You are translating a supplied Telugu Bhagavad Gita text into ${language.name}.

The supplied Telugu source is the ONLY authoritative source.

Your task is faithful translation, not rewriting.

STRICT RULES:

1. Translate every supplied title faithfully.
2. Translate every supplied content faithfully.
3. Preserve the exact id.
4. Preserve the exact entry order.
5. Return exactly the same number of entries.
6. Do not omit any entry.
7. Do not duplicate any entry.
8. Do not summarize.
9. Do not shorten.
10. Do not expand.
11. Do not add explanations that are not present in the source.
12. Do not remove explanations that are present in the source.
13. Do not change the philosophical meaning.
14. Do not change the spiritual meaning.
15. Do not silently correct the supplied Telugu source.
16. Do not replace the supplied source with another version of the Bhagavad Gita.
17. Use natural, grammatically correct ${language.name}.
18. Preserve important Bhagavad Gita terminology consistently.
19. Sanskrit-derived spiritual terms may be retained when that is natural and appropriate for the target language.
20. The Sanskrit verse contained in the content MUST remain EXACTLY unchanged, character-for-character.
21. Do not translate, transliterate, correct, reformat, or modify the Sanskrit verse itself.
22. Only the surrounding explanatory Telugu text should be translated.
23. Do not add markdown.
24. Do not add comments.
25. Do not add fields.
26. Return ONLY the requested JSON object.

The glossary supplied by the application is guidance for terminology consistency.
It does not override the meaning of the supplied Telugu source.

Target language:
${language.name}
`;
}

function buildUserPrompt(
  language,
  batch
) {
  return `
Translate the following Bhagavad Gita entries from Telugu to ${language.name}.

Return an object containing exactly one property named "entries".

The "entries" property must contain exactly ${batch.length} translated objects.

Required structure:

{
  "entries": [
    {
      "id": "gita_1",
      "title": "...",
      "content": "..."
    }
  ]
}

Do not change IDs.

Do not change entry order.

Do not translate or modify the Sanskrit verse.

Do not add or remove information.

SOURCE ENTRIES:

${JSON.stringify(batch, null, 2)}

TERMINOLOGY GLOSSARY:

${JSON.stringify(glossary, null, 2)}
`;
}

async function waitForRateLimit(response) {
  const remainingTokens = Number(
    response.headers.get(
      "x-ratelimit-remaining-tokens"
    )
  );

  const remainingRequests = Number(
    response.headers.get(
      "x-ratelimit-remaining-requests"
    )
  );

  const resetTokens =
    response.headers.get(
      "x-ratelimit-reset-tokens"
    );

  const resetRequests =
    response.headers.get(
      "x-ratelimit-reset-requests"
    );

  if (
    Number.isFinite(remainingTokens) &&
    remainingTokens <= 0
  ) {
    console.log(
      `Token limit reached. Reset: ${resetTokens || "unknown"}`
    );

    await sleep(5000);
  }

  if (
    Number.isFinite(remainingRequests) &&
    remainingRequests <= 0
  ) {
    console.log(
      `Request limit reached. Reset: ${resetRequests || "unknown"}`
    );

    await sleep(5000);
  }

  await sleep(
    config.rateLimit.minimumDelayBetweenRequestsMs
  );
}

async function callGroq(
  language,
  batch
) {
  const schema = buildSchema(
    batch.length
  );

  const systemPrompt =
    buildSystemPrompt(language);

  const userPrompt =
    buildUserPrompt(
      language,
      batch
    );

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      console.log(
        `Groq request attempt ${attempt}/${MAX_RETRIES}...`
      );

      const response = await fetch(
        API_URL,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            "Authorization":
              `Bearer ${API_KEY}`
          },
          body: JSON.stringify({
            model: MODEL,
            temperature: 0,
            max_completion_tokens: 12000,
            reasoning_effort: "medium",
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: userPrompt
              }
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "gita_translation",
                strict: true,
                schema: schema
              }
            }
          })
        }
      );

      if (response.status === 429) {
        const retryAfter =
          Number(
            response.headers.get(
              "retry-after"
            )
          ) || 10;

        console.log(
          `Rate limited. Waiting ${retryAfter} seconds...`
        );

        await sleep(
          retryAfter * 1000
        );

        continue;
      }

      if (!response.ok) {
        const body =
          await response.text();

        throw new Error(
          `Groq API ${response.status}: ${body}`
        );
      }

      await waitForRateLimit(
        response
      );

      const result =
        await response.json();

      const content =
        result &&
        result.choices &&
        result.choices[0] &&
        result.choices[0].message &&
        result.choices[0].message.content;

      if (!content) {
        throw new Error(
          "Groq returned an empty response."
        );
      }

      let parsed;

      try {
        parsed =
          JSON.parse(content);
      } catch (error) {
        throw new Error(
          `Groq returned invalid JSON: ${error.message}`
        );
      }

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !Array.isArray(parsed.entries)
      ) {
        throw new Error(
          "Groq returned invalid translation structure. Expected an object containing an entries array."
        );
      }

      validateTranslatedBatch(
        parsed.entries,
        batch,
        language
      );

      return parsed.entries;

    } catch (error) {
      lastError = error;

      console.error(
        `Attempt ${attempt} failed: ${error.message}`
      );

      if (
        attempt < MAX_RETRIES
      ) {
        const delay =
          Math.min(
            30000,
            2000 *
              Math.pow(
                2,
                attempt - 1
              )
          );

        console.log(
          `Retrying in ${delay / 1000} seconds...`
        );

        await sleep(delay);
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Translation failed."
    )
  );
}

function findExistingOutput(
  language
) {
  const outputPath =
    path.join(
      __dirname,
      language.file
    );

  if (
    !fs.existsSync(
      outputPath
    )
  ) {
    return null;
  }

  try {
    const existing =
      JSON.parse(
        fs.readFileSync(
          outputPath,
          "utf8"
        )
      );

    if (
      !Array.isArray(existing) ||
      existing.length !==
        source.length
    ) {
      return null;
    }

    for (
      let i = 0;
      i < source.length;
      i++
    ) {
      if (
        existing[i].id !==
          source[i].id ||
        typeof existing[i].title !==
          "string" ||
        typeof existing[i].content !==
          "string" ||
        existing[i].title.trim() ===
          "" ||
        existing[i].content.trim() ===
          ""
      ) {
        return null;
      }
    }

    const sourceSanskrit =
      extractSanskritMap(
        source
      );

    for (
      let i = 0;
      i < existing.length;
      i++
    ) {
      const verse =
        sourceSanskrit.get(
          source[i].id
        );

      if (
        !existing[i].content.includes(
          verse
        )
      ) {
        return null;
      }
    }

    return existing;

  } catch {
    return null;
  }
}

function copyTeluguOutput(
  language
) {
  const outputPath =
    path.join(
      __dirname,
      language.file
    );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      source,
      null,
      config.output.prettyPrint
        ? 2
        : 0
    ) + "\n",
    "utf8"
  );

  console.log("");
  console.log(
    "Telugu source copied directly."
  );
  console.log(
    `Created: ${language.file}`
  );
}

async function translateLanguage(
  language
) {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    `TRANSLATING: ${language.name}`
  );
  console.log(
    `Code: ${language.code}`
  );
  console.log(
    `Output: ${language.file}`
  );
  console.log(
    "=============================================="
  );

  if (
    language.code === "te"
  ) {
    copyTeluguOutput(
      language
    );

    return;
  }

  const existing =
    findExistingOutput(
      language
    );

  if (existing) {
    console.log("");
    console.log(
      `Valid completed file already exists: ${language.file}`
    );
    console.log(
      "Skipping translation."
    );
    return;
  }

  const allTranslations = [];

  for (
    let start = 0;
    start < source.length;
    start += BATCH_SIZE
  ) {
    const end =
      Math.min(
        start + BATCH_SIZE,
        source.length
      );

    const batch =
      source.slice(
        start,
        end
      );

    console.log("");
    console.log(
      `Translating entries ${start + 1}-${end} of ${source.length}...`
    );

    const translated =
      await callGroq(
        language,
        batch
      );

    validateTranslatedBatch(
      translated,
      batch,
      language
    );

    allTranslations.push(
      ...translated
    );

    console.log(
      `Completed entries ${start + 1}-${end}.`
    );
  }

  if (
    allTranslations.length !==
    source.length
  ) {
    throw new Error(
      `${language.name}: final translation contains ${allTranslations.length} entries instead of ${source.length}.`
    );
  }

  for (
    let i = 0;
    i < source.length;
    i++
  ) {
    if (
      allTranslations[i].id !==
      source[i].id
    ) {
      throw new Error(
        `${language.name}: final ordering mismatch at position ${i + 1}.`
      );
    }
  }

  const sourceSanskrit =
    extractSanskritMap(
      source
    );

  for (
    const translatedEntry of
      allTranslations
  ) {
    const expectedVerse =
      sourceSanskrit.get(
        translatedEntry.id
      );

    if (
      !translatedEntry.content.includes(
        expectedVerse
      )
    ) {
      throw new Error(
        `${language.name}: Sanskrit verse was changed or removed in ${translatedEntry.id}.`
      );
    }
  }

  const outputPath =
    path.join(
      __dirname,
      language.file
    );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      allTranslations,
      null,
      config.output.prettyPrint
        ? 2
        : 0
    ) + "\n",
    "utf8"
  );

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    `COMPLETED: ${language.name}`
  );
  console.log(
    `Entries: ${allTranslations.length}`
  );
  console.log(
    `File: ${language.file}`
  );
  console.log(
    "=============================================="
  );
}

async function main() {
  console.log(
    "Vidhwaan Bhagavad Gita Translation Pipeline"
  );
  console.log(
    "--------------------------------------------"
  );
  console.log(
    `Model: ${MODEL}`
  );
  console.log(
    `Source: ${config.project.sourceFile}`
  );
  console.log(
    `Batch size: ${BATCH_SIZE}`
  );

  validateSource();

  const language =
    getLanguageFromArgument();

  await translateLanguage(
    language
  );

  console.log("");
  console.log(
    "Translation process finished successfully."
  );
}

main().catch(error => {
  console.error("");
  console.error(
    "=============================================="
  );
  console.error(
    "TRANSLATION FAILED"
  );
  console.error(
    "=============================================="
  );
  console.error(
    error.stack || error.message
  );

  process.exit(1);
});
