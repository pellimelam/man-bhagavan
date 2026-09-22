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

let lastRateLimitState = {
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

function parseDurationToMs(value) {
  if (!value) {
    return 0;
  }

  const text =
    String(value).trim();

  let total = 0;

  const minuteMatch =
    text.match(
      /([\d.]+)m/
    );

  const secondMatch =
    text.match(
      /([\d.]+)s/
    );

  const millisecondMatch =
    text.match(
      /([\d.]+)ms/
    );

  if (minuteMatch) {
    total +=
      Number(minuteMatch[1]) *
      60 *
      1000;
  }

  if (secondMatch) {
    total +=
      Number(secondMatch[1]) *
      1000;
  }

  if (millisecondMatch) {
    total +=
      Number(millisecondMatch[1]);
  }

  if (total === 0) {
    const numeric =
      Number(text);

    if (
      Number.isFinite(numeric)
    ) {
      return numeric * 1000;
    }
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

  lastRateLimitState = {
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

function extractSanskritVerse(
  content
) {
  if (
    typeof content !==
    "string"
  ) {
    return null;
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
    return null;
  }

  const start =
    labelMatch.index +
    labelMatch[0].length;

  const remaining =
    normalized.slice(
      start
    );

  const blankLine =
    remaining.search(
      /\n\s*\n/
    );

  let verse;

  if (
    blankLine >= 0
  ) {
    verse =
      remaining
        .slice(
          0,
          blankLine
        )
        .trim();
  } else {
    verse =
      remaining.trim();
  }

  return verse || null;
}

function getSanskritMap(
  entries
) {
  const map =
    new Map();

  for (
    const entry of entries
  ) {
    const verse =
      extractSanskritVerse(
        entry.content
      );

    if (!verse) {
      throw new Error(
        `Could not extract Sanskrit verse from ${entry.id}.`
      );
    }

    map.set(
      entry.id,
      verse
    );
  }

  return map;
}

function protectSanskrit(
  entries
) {
  const protectedEntries =
    [];

  const verseMap =
    getSanskritMap(
      entries
    );

  for (
    const entry of entries
  ) {
    const verse =
      verseMap.get(
        entry.id
      );

    const placeholder =
      `__SANSKRIT_${entry.id}__`;

    const replaced =
      entry.content.replace(
        verse,
        placeholder
      );

    if (
      replaced ===
      entry.content
    ) {
      throw new Error(
        `Failed to protect Sanskrit in ${entry.id}.`
      );
    }

    protectedEntries.push({
      id: entry.id,
      title: entry.title,
      content: replaced
    });
  }

  return {
    entries:
      protectedEntries,
    verses:
      verseMap
  };
}

function restoreSanskrit(
  translatedEntries,
  sourceEntries,
  language
) {
  const sourceSanskrit =
    getSanskritMap(
      sourceEntries
    );

  return translatedEntries.map(
    entry => {
      const sourceVerse =
        sourceSanskrit.get(
          entry.id
        );

      const placeholder =
        `__SANSKRIT_${entry.id}__`;

      if (
        !entry.content.includes(
          placeholder
        )
      ) {
        throw new Error(
          `${language.name}: Sanskrit placeholder missing in ${entry.id}.`
        );
      }

      const restored =
        entry.content.replace(
          placeholder,
          sourceVerse
        );

      if (
        restored.includes(
          placeholder
        )
      ) {
        throw new Error(
          `${language.name}: Sanskrit placeholder was not fully restored in ${entry.id}.`
        );
      }

      return {
        id: entry.id,
        title: entry.title,
        content: restored
      };
    }
  );
}

function buildCompactGlossary() {
  const compact = {};

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
        `${language.name}: ${sourceEntry.id} is not an object.`
      );
    }

    const keys =
      Object.keys(
        translatedEntry
      ).sort();

    if (
      keys.length !== 3 ||
      keys[0] !== "content" ||
      keys[1] !== "id" ||
      keys[2] !== "title"
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
        "string" ||
      translatedEntry.title.trim() ===
        ""
    ) {
      throw new Error(
        `${language.name}: ${translatedEntry.id} has empty title.`
      );
    }

    if (
      typeof translatedEntry.content !==
        "string" ||
      translatedEntry.content.trim() ===
        ""
    ) {
      throw new Error(
        `${language.name}: ${translatedEntry.id} has empty content.`
      );
    }

    const placeholder =
      `__SANSKRIT_${sourceEntry.id}__`;

    if (
      !translatedEntry.content.includes(
        placeholder
      )
    ) {
      throw new Error(
        `${language.name}: Sanskrit placeholder changed or missing in ${sourceEntry.id}.`
      );
    }
  }

  return true;
}

function buildSystemPrompt(
  language
) {
  return `
You are a highly accurate Bhagavad Gita translator.

Translate the supplied Telugu source into ${language.name}.

The supplied Telugu source is the ONLY authoritative source.

IMPORTANT:

The Sanskrit verses have been replaced by protected placeholders.

A placeholder looks like:

__SANSKRIT_gita_1__

You MUST preserve every Sanskrit placeholder EXACTLY.

Never translate it.

Never transliterate it.

Never modify it.

Never remove it.

Never change its spelling.

Never change its capitalization.

Never add spaces inside it.

Never move it to another entry.

The application will restore the original Sanskrit verse automatically after translation.

STRICT RULES:

1. Translate the title faithfully.
2. Translate the content faithfully.
3. Preserve every meaning expressed in the source.
4. Preserve every important qualification.
5. Do not summarize.
6. Do not shorten.
7. Do not expand.
8. Do not add explanations.
9. Do not remove explanations.
10. Do not add outside information.
11. Do not silently correct the Telugu source.
12. Preserve exact IDs.
13. Preserve exact entry order.
14. Return exactly the requested number of entries.
15. Do not duplicate entries.
16. Use natural and grammatically correct ${language.name}.
17. Preserve spiritual meaning.
18. Preserve philosophical meaning.
19. Maintain terminology consistency.
20. Preserve every Sanskrit placeholder exactly.
21. Do not add markdown.
22. Do not add comments.
23. Do not add fields.
24. Return only the requested JSON object.

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
  protectedBatch
) {
  return `
Translate these Bhagavad Gita entries from Telugu to ${language.name}.

Return exactly this structure:

{
  "entries": [
    {
      "id": "gita_1",
      "title": "...",
      "content": "..."
    }
  ]
}

The entries array must contain exactly ${protectedBatch.length} objects.

Preserve every ID exactly.

Preserve entry order exactly.

MOST IMPORTANT:

Every Sanskrit placeholder must remain EXACTLY unchanged.

For example:

__SANSKRIT_gita_59__

must remain:

__SANSKRIT_gita_59__

Do not translate it.

Do not modify it.

Do not remove it.

Do not replace it with Sanskrit.

The application will automatically restore the original Sanskrit verse.

SOURCE:

${JSON.stringify(
  protectedBatch
)}
`;
}

function estimateTokens(
  text
) {
  const characters =
    String(text).length;

  return Math.ceil(
    characters / 3.5
  );
}

function estimateRequestTokens(
  systemPrompt,
  userPrompt
) {
  const promptTokens =
    estimateTokens(
      systemPrompt
    ) +
    estimateTokens(
      userPrompt
    );

  const schemaTokens =
    estimateTokens(
      JSON.stringify(
        buildSchema(
          BATCH_SIZE
        )
      )
    );

  return (
    promptTokens +
    schemaTokens +
    1000
  );
}

async function waitBeforeRequest(
  estimatedTokens
) {
  const state =
    lastRateLimitState;

  if (
    state.remainingTokens !==
      null &&
    state.remainingTokens <
      estimatedTokens +
        config.rateLimit
          .safetyMarginTokens
  ) {
    const waitMs =
      Math.max(
        state.resetTokensMs,
        3000
      );

    console.log("");
    console.log(
      `Waiting ${Math.ceil(
        waitMs / 1000
      )} seconds for TPM window...`
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

async function callGroq(
  language,
  sourceBatch
) {
  const protectedData =
    protectSanskrit(
      sourceBatch
    );

  const protectedBatch =
    protectedData.entries;

  const schema =
    buildSchema(
      protectedBatch.length
    );

  const systemPrompt =
    buildSystemPrompt(
      language
    );

  const userPrompt =
    buildUserPrompt(
      language,
      protectedBatch
    );

  const estimatedTokens =
    estimateRequestTokens(
      systemPrompt,
      userPrompt
    );

  console.log(
    `Estimated request tokens: ${estimatedTokens}`
  );

  if (
    estimatedTokens >
    7000
  ) {
    console.error(
      `WARNING: Estimated request size is ${estimatedTokens} tokens.`
    );
  }

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
            method: "POST",
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

      validateTranslatedBatch(
        parsed.entries,
        protectedBatch,
        language
      );

      const restored =
        restoreSanskrit(
          parsed.entries,
          sourceBatch,
          language
        );

      return restored;

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
        console.error("");
        console.error(
          "Groq rejected the request as too large."
        );
        console.error(
          "Reducing batch size automatically for this batch."
        );

        if (
          sourceBatch.length >
          1
        ) {
          const middle =
            Math.ceil(
              sourceBatch.length /
                2
            );

          const firstHalf =
            sourceBatch.slice(
              0,
              middle
            );

          const secondHalf =
            sourceBatch.slice(
              middle
            );

          const first =
            await callGroq(
              language,
              firstHalf
            );

          const second =
            secondHalf.length > 0
              ? await callGroq(
                  language,
                  secondHalf
                )
              : [];

          return [
            ...first,
            ...second
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
      getSanskritMap(
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
    getSanskritMap(
      source
    );

  for (
    const entry of
      allTranslations
  ) {
    const expected =
      sourceSanskrit.get(
        entry.id
      );

    if (
      !entry.content.includes(
        expected
      )
    ) {
      throw new Error(
        `${language.name}: final Sanskrit verification failed for ${entry.id}.`
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
