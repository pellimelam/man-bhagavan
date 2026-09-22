const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(
  __dirname,
  "translation-config.json"
);

const GLOSSARY_PATH = path.join(
  __dirname,
  "translation-glossary.json"
);

const config = JSON.parse(
  fs.readFileSync(CONFIG_PATH, "utf8")
);

const glossary = JSON.parse(
  fs.readFileSync(GLOSSARY_PATH, "utf8")
);

const API_KEY = process.env.GROQ_API_KEY;

if (!API_KEY) {
  console.error(
    "ERROR: GROQ_API_KEY is not set."
  );
  process.exit(1);
}

const API_URL =
  "https://api.groq.com/openai/v1/chat/completions";

const MODEL =
  config.project.model;

const BATCH_SIZE =
  config.project.batchSize;

const MAX_RETRIES =
  config.project.maxRetries;

const SOURCE_FILE =
  path.join(
    __dirname,
    config.project.sourceFile
  );

const source =
  JSON.parse(
    fs.readFileSync(
      SOURCE_FILE,
      "utf8"
    )
  );

let rateLimitState = {
  remainingTokens: null,
  resetTokensMs: 0,
  remainingRequests: null,
  resetRequestsMs: 0
};

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

/* =========================================================
   LANGUAGE
   ========================================================= */

function getLanguageFromArgument() {
  const argument =
    process.argv[2];

  if (!argument) {
    console.error("");
    console.error(
      "ERROR: Language code is required."
    );
    console.error("");
    console.error(
      "Examples:"
    );
    console.error(
      "  node translate-gita.js en"
    );
    console.error(
      "  node translate-gita.js hi"
    );
    console.error(
      "  node translate-gita.js ta"
    );
    console.error("");

    process.exit(1);
  }

  const normalized =
    argument.toLowerCase();

  const language =
    config.languages.find(
      item =>
        item.code.toLowerCase() ===
          normalized ||
        item.name.toLowerCase() ===
          normalized ||
        item.file.toLowerCase() ===
          normalized
    );

  if (!language) {
    console.error(
      `ERROR: Language not found: ${argument}`
    );

    process.exit(1);
  }

  return language;
}

/* =========================================================
   SOURCE VALIDATION
   ========================================================= */

function validateSource() {
  if (
    !Array.isArray(source)
  ) {
    throw new Error(
      "Source file must contain a JSON array."
    );
  }

  if (
    config.validation
      .requireExactly100Entries &&
    source.length !==
      config.project.totalEntries
  ) {
    throw new Error(
      `Source must contain exactly ${config.project.totalEntries} entries. Found ${source.length}.`
    );
  }

  const ids =
    new Set();

  for (
    let i = 0;
    i < source.length;
    i++
  ) {
    const entry =
      source[i];

    if (
      !entry ||
      typeof entry !==
        "object" ||
      Array.isArray(entry)
    ) {
      throw new Error(
        `Source entry ${i + 1} is invalid.`
      );
    }

    const expectedId =
      `gita_${i + 1}`;

    if (
      entry.id !==
      expectedId
    ) {
      throw new Error(
        `Source entry ${i + 1} must have id ${expectedId}. Found ${entry.id}.`
      );
    }

    if (
      ids.has(entry.id)
    ) {
      throw new Error(
        `Duplicate source id: ${entry.id}`
      );
    }

    ids.add(
      entry.id
    );

    if (
      typeof entry.title !==
        "string" ||
      entry.title.trim() ===
        ""
    ) {
      throw new Error(
        `Source ${entry.id} has empty title.`
      );
    }

    if (
      typeof entry.content !==
        "string" ||
      entry.content.trim() ===
        ""
    ) {
      throw new Error(
        `Source ${entry.id} has empty content.`
      );
    }
  }
}

/* =========================================================
   SANSKRIT EXTRACTION

   IMPORTANT:
   Sanskrit is NEVER sent to Groq.
   ========================================================= */

function extractSanskritParts(
  content
) {
  if (
    typeof content !==
    "string"
  ) {
    throw new Error(
      "Content is not a string."
    );
  }

  const normalized =
    content
      .replace(
        /\r\n/g,
        "\n"
      )
      .replace(
        /\r/g,
        "\n"
      );

  const labelMatch =
    normalized.match(
      /(?:^|\n)\s*(?:శ్లోకం|श्लोक|श्लोकः|Verse|Sloka|śloka)\s*:\s*\n?/i
    );

  if (
    !labelMatch
  ) {
    throw new Error(
      "Sanskrit verse label could not be found."
    );
  }

  const verseStart =
    labelMatch.index +
    labelMatch[0].length;

  const remaining =
    normalized.slice(
      verseStart
    );

  const blankLineIndex =
    remaining.search(
      /\n\s*\n/
    );

  if (
    blankLineIndex < 0
  ) {
    throw new Error(
      "Could not determine Sanskrit verse boundary."
    );
  }

  const verse =
    remaining
      .slice(
        0,
        blankLineIndex
      )
      .trim();

  if (
    !verse
  ) {
    throw new Error(
      "Sanskrit verse is empty."
    );
  }

  const afterVerseStart =
    verseStart +
    blankLineIndex +
    remaining
      .slice(
        blankLineIndex
      )
      .match(
        /^\n\s*\n/
      )[0].length;

  const beforeVerse =
    normalized.slice(
      0,
      verseStart
    );

  const afterVerse =
    normalized.slice(
      afterVerseStart
    );

  return {
    beforeVerse,
    verse,
    afterVerse
  };
}

/* =========================================================
   PREPARE TRANSLATION INPUT

   Sanskrit is removed entirely.
   ========================================================= */

function prepareEntry(
  entry
) {
  const parts =
    extractSanskritParts(
      entry.content
    );

  return {
    id: entry.id,
    title: entry.title,
    beforeVerse:
      parts.beforeVerse,
    afterVerse:
      parts.afterVerse
  };
}

/* =========================================================
   COMPACT GLOSSARY
   ========================================================= */

function buildCompactGlossary() {
  const compact =
    {};

  if (
    Array.isArray(
      glossary.coreTerms
    )
  ) {
    for (
      const term of
        glossary.coreTerms
    ) {
      if (
        term &&
        typeof term.source ===
          "string"
      ) {
        compact[
          term.source
        ] =
          term.concept ||
          "";
      }
    }
  }

  return compact;
}

const COMPACT_GLOSSARY =
  buildCompactGlossary();

/* =========================================================
   STRUCTURED OUTPUT SCHEMA

   Root MUST be an object for Groq Structured Outputs.
   ========================================================= */

function buildSchema(
  batchLength
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      entries: {
        type: "array",
        minItems:
          batchLength,
        maxItems:
          batchLength,
        items: {
          type: "object",
          additionalProperties:
            false,
          properties: {
            id: {
              type: "string"
            },
            title: {
              type: "string"
            },
            beforeVerse: {
              type: "string"
            },
            afterVerse: {
              type: "string"
            }
          },
          required: [
            "id",
            "title",
            "beforeVerse",
            "afterVerse"
          ]
        }
      }
    },
    required: [
      "entries"
    ]
  };
}

/* =========================================================
   PROMPTS
   ========================================================= */

function buildSystemPrompt(
  language
) {
  return `
You are a highly accurate Bhagavad Gita translator.

Translate the supplied Telugu text into ${language.name}.

The supplied Telugu source is the ONLY authoritative source.

IMPORTANT ARCHITECTURE:

The Sanskrit verse has been completely removed from the translation input.

You will NOT receive the Sanskrit verse.

Therefore:

- Do not attempt to recreate it.
- Do not invent it.
- Do not add Sanskrit.
- Do not add a replacement verse.
- Do not add another Bhagavad Gita version.

The application will automatically restore the exact original Sanskrit verse after your translation is complete.

Your job is ONLY to translate:

1. title
2. beforeVerse
3. afterVerse

STRICT RULES:

1. Translate faithfully.
2. Preserve the complete meaning.
3. Preserve philosophical meaning.
4. Preserve spiritual meaning.
5. Preserve every qualification.
6. Do not summarize.
7. Do not shorten.
8. Do not expand.
9. Do not add explanations.
10. Do not remove explanations.
11. Do not add outside information.
12. Do not silently correct the Telugu source.
13. Preserve IDs exactly.
14. Preserve entry order.
15. Return exactly the requested number of entries.
16. Do not duplicate entries.
17. Use natural, grammatically correct ${language.name}.
18. Maintain consistent Bhagavad Gita terminology.
19. Do not add Sanskrit verses.
20. Do not add markdown.
21. Do not add comments.
22. Do not add fields.
23. Return only the requested JSON object.

Terminology guidance:

${JSON.stringify(
  COMPACT_GLOSSARY
)}

Target language:

${language.name}
`;
}

function buildUserPrompt(
  language,
  batch
) {
  return `
Translate these Bhagavad Gita entries from Telugu to ${language.name}.

IMPORTANT:

The Sanskrit verse has intentionally been removed.

Do NOT recreate or add the Sanskrit verse.

The application will restore the exact original Sanskrit automatically.

Translate these fields:

- title
- beforeVerse
- afterVerse

Return exactly this structure:

{
  "entries": [
    {
      "id": "gita_1",
      "title": "...",
      "beforeVerse": "...",
      "afterVerse": "..."
    }
  ]
}

Return exactly ${batch.length} entries.

Preserve IDs exactly.

Preserve entry order exactly.

SOURCE:

${JSON.stringify(
  batch
)}
`;
}

/* =========================================================
   RATE LIMIT HELPERS
   ========================================================= */

function parseDurationToMs(
  value
) {
  if (!value) {
    return 0;
  }

  const text =
    String(value).trim();

  let total = 0;

  const minute =
    text.match(
      /([\d.]+)m/
    );

  const second =
    text.match(
      /([\d.]+)s/
    );

  const millisecond =
    text.match(
      /([\d.]+)ms/
    );

  if (minute) {
    total +=
      Number(
        minute[1]
      ) *
      60 *
      1000;
  }

  if (second) {
    total +=
      Number(
        second[1]
      ) *
      1000;
  }

  if (millisecond) {
    total +=
      Number(
        millisecond[1]
      );
  }

  return total;
}

function updateRateLimitState(
  response
) {
  const remainingTokens =
    Number(
      response.headers.get(
        "x-ratelimit-remaining-tokens"
      )
    );

  const remainingRequests =
    Number(
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

  rateLimitState = {
    remainingTokens:
      Number.isFinite(
        remainingTokens
      )
        ? remainingTokens
        : null,

    resetTokensMs:
      parseDurationToMs(
        resetTokens
      ),

    remainingRequests:
      Number.isFinite(
        remainingRequests
      )
        ? remainingRequests
        : null,

    resetRequestsMs:
      parseDurationToMs(
        resetRequests
      )
  };
}

function estimateTokens(
  text
) {
  return Math.ceil(
    String(text).length /
      3.5
  );
}

function estimateRequestTokens(
  systemPrompt,
  userPrompt,
  schema
) {
  return (
    estimateTokens(
      systemPrompt
    ) +
    estimateTokens(
      userPrompt
    ) +
    estimateTokens(
      JSON.stringify(schema)
    ) +
    1000
  );
}

async function waitBeforeRequest(
  estimatedTokens
) {
  const remaining =
    rateLimitState
      .remainingTokens;

  if (
    remaining !== null &&
    remaining <
      estimatedTokens +
        config.rateLimit
          .safetyMarginTokens
  ) {
    const waitMs =
      Math.max(
        rateLimitState
          .resetTokensMs,
        5000
      );

    console.log("");
    console.log(
      `Waiting ${Math.ceil(
        waitMs / 1000
      )} seconds for Groq token window...`
    );

    await sleep(
      waitMs
    );
  }

  await sleep(
    config.rateLimit
      .minimumDelayBetweenRequestsMs
  );
}

/* =========================================================
   VALIDATE GROQ RESPONSE
   ========================================================= */

function validateModelResponse(
  translated,
  sourceBatch,
  language
) {
  if (
    !Array.isArray(
      translated
    )
  ) {
    throw new Error(
      `${language.name}: response entries is not an array.`
    );
  }

  if (
    translated.length !==
    sourceBatch.length
  ) {
    throw new Error(
      `${language.name}: expected ${sourceBatch.length} entries, received ${translated.length}.`
    );
  }

  const ids =
    new Set();

  for (
    let i = 0;
    i < sourceBatch.length;
    i++
  ) {
    const sourceEntry =
      sourceBatch[i];

    const translatedEntry =
      translated[i];

    if (
      !translatedEntry ||
      typeof translatedEntry !==
        "object" ||
      Array.isArray(
        translatedEntry
      )
    ) {
      throw new Error(
        `${language.name}: ${sourceEntry.id} is invalid.`
      );
    }

    const keys =
      Object.keys(
        translatedEntry
      ).sort();

    if (
      keys.length !== 4 ||
      keys[0] !==
        "afterVerse" ||
      keys[1] !==
        "beforeVerse" ||
      keys[2] !==
        "id" ||
      keys[3] !==
        "title"
    ) {
      throw new Error(
        `${language.name}: ${sourceEntry.id} has invalid fields.`
      );
    }

    if (
      translatedEntry.id !==
      sourceEntry.id
    ) {
      throw new Error(
        `${language.name}: expected ${sourceEntry.id}, received ${translatedEntry.id}.`
      );
    }

    if (
      ids.has(
        translatedEntry.id
      )
    ) {
      throw new Error(
        `${language.name}: duplicate id ${translatedEntry.id}.`
      );
    }

    ids.add(
      translatedEntry.id
    );

    if (
      typeof translatedEntry.title !==
        "string"
    ) {
      throw new Error(
        `${language.name}: ${translatedEntry.id} title is invalid.`
      );
    }

    if (
      typeof translatedEntry.beforeVerse !==
        "string"
    ) {
      throw new Error(
        `${language.name}: ${translatedEntry.id} beforeVerse is invalid.`
      );
    }

    if (
      typeof translatedEntry.afterVerse !==
        "string"
    ) {
      throw new Error(
        `${language.name}: ${translatedEntry.id} afterVerse is invalid.`
      );
    }
  }
}

/* =========================================================
   GROQ REQUEST
   ========================================================= */

async function callGroq(
  language,
  sourceBatch
) {
  const preparedBatch =
    sourceBatch.map(
      prepareEntry
    );

  const schema =
    buildSchema(
      preparedBatch.length
    );

  const systemPrompt =
    buildSystemPrompt(
      language
    );

  const userPrompt =
    buildUserPrompt(
      language,
      preparedBatch
    );

  const estimatedTokens =
    estimateRequestTokens(
      systemPrompt,
      userPrompt,
      schema
    );

  console.log(
    `Estimated request tokens: ${estimatedTokens}`
  );

  let lastError =
    null;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      await waitBeforeRequest(
        estimatedTokens
      );

      console.log(
        `Groq request attempt ${attempt}/${MAX_RETRIES}...`
      );

      const response =
        await fetch(
          API_URL,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "Authorization":
                `Bearer ${API_KEY}`
            },

            body:
              JSON.stringify({
                model:
                  MODEL,

                temperature:
                  0,

                max_completion_tokens:
                  8000,

                reasoning_effort:
                  "medium",

                messages: [
                  {
                    role:
                      "system",

                    content:
                      systemPrompt
                  },

                  {
                    role:
                      "user",

                    content:
                      userPrompt
                  }
                ],

                response_format: {
                  type:
                    "json_schema",

                  json_schema: {
                    name:
                      "gita_translation",

                    strict:
                      true,

                    schema
                  }
                }
              })
          }
        );

      updateRateLimitState(
        response
      );

      if (
        response.status ===
        429
      ) {
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
          retryAfter *
            1000
        );

        continue;
      }

      if (
        response.status ===
        413
      ) {
        const body =
          await response.text();

        throw new Error(
          `REQUEST_TOO_LARGE: ${body}`
        );
      }

      if (
        !response.ok
      ) {
        const body =
          await response.text();

        throw new Error(
          `Groq API ${response.status}: ${body}`
        );
      }

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
          JSON.parse(
            content
          );
      } catch (
        error
      ) {
        throw new Error(
          `Groq returned invalid JSON: ${error.message}`
        );
      }

      if (
        !parsed ||
        typeof parsed !==
          "object" ||
        Array.isArray(
          parsed
        ) ||
        !Array.isArray(
          parsed.entries
        )
      ) {
        throw new Error(
          "Groq returned invalid translation structure."
        );
      }

      validateModelResponse(
        parsed.entries,
        preparedBatch,
        language
      );

      /*
       * Reconstruct final content.
       *
       * The Sanskrit verse is taken ONLY
       * from the original source.
       */

      const finalEntries =
        [];

      for (
        let i = 0;
        i < sourceBatch.length;
        i++
      ) {
        const sourceEntry =
          sourceBatch[i];

        const modelEntry =
          parsed.entries[i];

        const sourceParts =
          extractSanskritParts(
            sourceEntry.content
          );

        const finalContent =
          modelEntry.beforeVerse +
          sourceParts.verse +
          modelEntry.afterVerse;

        finalEntries.push({
          id:
            sourceEntry.id,

          title:
            modelEntry.title,

          content:
            finalContent
        });
      }

      return finalEntries;

    } catch (
      error
    ) {
      lastError =
        error;

      if (
        error.message.startsWith(
          "REQUEST_TOO_LARGE:"
        )
      ) {
        if (
          sourceBatch.length >
          1
        ) {
          console.log("");
          console.log(
            "Request was too large."
          );
          console.log(
            `Automatically splitting ${sourceBatch.length} entries.`
          );

          const middle =
            Math.ceil(
              sourceBatch.length /
                2
            );

          const firstBatch =
            sourceBatch.slice(
              0,
              middle
            );

          const secondBatch =
            sourceBatch.slice(
              middle
            );

          const firstResult =
            await callGroq(
              language,
              firstBatch
            );

          const secondResult =
            secondBatch.length > 0
              ? await callGroq(
                  language,
                  secondBatch
                )
              : [];

          return [
            ...firstResult,
            ...secondResult
          ];
        }

        throw error;
      }

      console.error(
        `Attempt ${attempt} failed: ${error.message}`
      );

      if (
        attempt <
        MAX_RETRIES
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
          `Retrying in ${Math.ceil(
            delay / 1000
          )} seconds...`
        );

        await sleep(
          delay
        );
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

/* =========================================================
   EXISTING OUTPUT CHECK
   ========================================================= */

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
      !Array.isArray(
        existing
      ) ||
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
      new Map();

    for (
      const entry of
        source
    ) {
      const parts =
        extractSanskritParts(
          entry.content
        );

      sourceSanskrit.set(
        entry.id,
        parts.verse
      );
    }

    for (
      let i = 0;
      i < existing.length;
      i++
    ) {
      const expected =
        sourceSanskrit.get(
          existing[i].id
        );

      if (
        !existing[i].content.includes(
          expected
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

/* =========================================================
   TELUGU
   ========================================================= */

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
      config.output
        .prettyPrint
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

/* =========================================================
   TRANSLATE LANGUAGE
   ========================================================= */

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
    `Batch size: ${BATCH_SIZE}`
  );

  console.log(
    "=============================================="
  );

  if (
    language.code ===
    "te"
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

  const allTranslations =
    [];

  for (
    let start = 0;
    start < source.length;
    start += BATCH_SIZE
  ) {
    const end =
      Math.min(
        start +
          BATCH_SIZE,
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

  /*
   * Final exact Sanskrit verification.
   */

  for (
    let i = 0;
    i < source.length;
    i++
  ) {
    const sourceParts =
      extractSanskritParts(
        source[i].content
      );

    if (
      !allTranslations[i].content.includes(
        sourceParts.verse
      )
    ) {
      throw new Error(
        `${language.name}: final Sanskrit verification failed for ${source[i].id}.`
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
      config.output
        .prettyPrint
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

/* =========================================================
   MAIN
   ========================================================= */

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

main().catch(
  error => {
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
      error.stack ||
      error.message
    );

    process.exit(1);
  }
);
