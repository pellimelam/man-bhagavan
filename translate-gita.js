const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG_PATH = path.join(__dirname, "translation-config.json");
const GLOSSARY_PATH = path.join(__dirname, "translation-glossary.json");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const glossary = JSON.parse(fs.readFileSync(GLOSSARY_PATH, "utf8"));

const SOURCE_FILE = path.join(__dirname, config.project.sourceFile);
const SOURCE_LANGUAGE = config.project.sourceLanguage;
const MODEL = config.project.model;
const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const API_KEY = process.env.GROQ_API_KEY;

if (!API_KEY) {
  throw new Error(
    "GROQ_API_KEY is not available. Add it to GitHub Secrets or the environment."
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function loadSource() {
  if (!fs.existsSync(SOURCE_FILE)) {
    throw new Error(`Source file not found: ${SOURCE_FILE}`);
  }

  const raw = fs.readFileSync(SOURCE_FILE, "utf8");

  let source;

  try {
    source = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Source JSON is invalid: ${error.message}`);
  }

  if (!Array.isArray(source)) {
    throw new Error("Source JSON must contain a top-level array.");
  }

  if (source.length !== config.project.totalEntries) {
    throw new Error(
      `Expected ${config.project.totalEntries} source entries, found ${source.length}.`
    );
  }

  source.forEach((entry, index) => {
    const expectedId = `gita_${index + 1}`;

    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid source entry at index ${index}.`);
    }

    if (entry.id !== expectedId) {
      throw new Error(
        `Invalid source ID at index ${index}: expected ${expectedId}, found ${entry.id}.`
      );
    }

    if (typeof entry.title !== "string" || !entry.title.trim()) {
      throw new Error(`Missing title for ${expectedId}.`);
    }

    if (typeof entry.content !== "string" || !entry.content.trim()) {
      throw new Error(`Missing content for ${expectedId}.`);
    }
  });

  return {
    source,
    raw,
    hash: sha256(raw)
  };
}

function extractSanskritVerse(content) {
  const match = content.match(
    /(?:^|\n)శ్లోకం:\s*\n([\s\S]*?)(?:\n\n|$)/
  );

  if (!match) {
    throw new Error("Could not locate Sanskrit verse in source content.");
  }

  return match[1].trim();
}

function getSourceVerseMap(source) {
  const map = new Map();

  for (const entry of source) {
    map.set(entry.id, extractSanskritVerse(entry.content));
  }

  return map;
}

function getExpectedKeys() {
  return ["id", "title", "content"];
}

function validateBasicBatch(result, expectedEntries) {
  if (!Array.isArray(result)) {
    throw new Error("Model response is not a JSON array.");
  }

  if (result.length !== expectedEntries.length) {
    throw new Error(
      `Expected ${expectedEntries.length} translated entries, received ${result.length}.`
    );
  }

  const expectedKeys = getExpectedKeys();

  expectedEntries.forEach((sourceEntry, index) => {
    const translated = result[index];

    if (!translated || typeof translated !== "object") {
      throw new Error(
        `Translated entry at index ${index} is not an object.`
      );
    }

    const actualKeys = Object.keys(translated).sort();
    const requiredKeys = [...expectedKeys].sort();

    if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) {
      throw new Error(
        `Invalid keys for ${sourceEntry.id}. Expected ${requiredKeys.join(
          ", "
        )}; received ${actualKeys.join(", ")}.`
      );
    }

    if (translated.id !== sourceEntry.id) {
      throw new Error(
        `ID changed for ${sourceEntry.id}. Received ${translated.id}.`
      );
    }

    if (
      typeof translated.title !== "string" ||
      !translated.title.trim()
    ) {
      throw new Error(`Empty translated title for ${sourceEntry.id}.`);
    }

    if (
      typeof translated.content !== "string" ||
      !translated.content.trim()
    ) {
      throw new Error(`Empty translated content for ${sourceEntry.id}.`);
    }
  });
}

function validateSanskritBatch(result, expectedEntries, sourceVerseMap) {
  for (const translated of result) {
    const expectedVerse = sourceVerseMap.get(translated.id);

    if (!expectedVerse) {
      throw new Error(
        `No source Sanskrit verse found for ${translated.id}.`
      );
    }

    const translatedVerse = extractTranslatedSanskritVerse(
      translated.content
    );

    if (translatedVerse !== expectedVerse) {
      throw new Error(
        `Sanskrit verse changed for ${translated.id}.`
      );
    }
  }
}

function extractTranslatedSanskritVerse(content) {
  const match = content.match(
    /(?:^|\n)(?:శ్లోకం|श्लोक|श्लोकः|Verse|Sloka|শ্লোক|ಶ್ಲೋಕ|ശ്ലോകം|சுலோகம்|ਸਲੋਕ|ଶ୍ଲୋକ|શ્લોક|श्लोकम्|شلوک)\s*:\s*\n([\s\S]*?)(?:\n\n|$)/i
  );

  if (!match) {
    throw new Error("Could not locate translated Sanskrit verse.");
  }

  return match[1].trim();
}

function buildJsonSchema(expectedEntries) {
  return {
    type: "array",
    minItems: expectedEntries.length,
    maxItems: expectedEntries.length,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "content"],
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
      }
    }
  };
}

function buildSystemPrompt(language) {
  const glossaryText = JSON.stringify(
    glossary.coreTerms,
    null,
    2
  );

  return `
You are the official multilingual translation engine for Vidhwaan,
a village-based global technology company.

Your task is to translate the supplied Telugu Bhagavad Gita educational
content into ${language.name}.

SOURCE LANGUAGE:
${SOURCE_LANGUAGE}

TARGET LANGUAGE:
${language.name}

STRICT RULES:

1. Translate the Telugu title faithfully into ${language.name}.

2. Translate the explanatory Telugu content faithfully into ${language.name}.

3. DO NOT summarize.

4. DO NOT shorten.

5. DO NOT expand.

6. DO NOT add new teachings, opinions, interpretations, examples,
   explanations, quotations, commentary, or religious claims.

7. DO NOT remove any idea, sentence, paragraph, or meaningful detail
   from the source.

8. Preserve the original meaning, sequence, and logical structure.

9. The Sanskrit shloka contained inside each content field is LOCKED.
   Copy it EXACTLY from the source.
   Do not translate it.
   Do not transliterate it.
   Do not correct it.
   Do not modify punctuation.
   Do not change characters.
   Do not change spacing inside the Sanskrit verse.

10. Only the label immediately before the Sanskrit verse may be
    translated if appropriate for the target language.

11. Preserve the same paragraph structure as closely as possible.

12. Preserve names such as Arjuna and Krishna according to normal
    usage in the target language, without changing their identity.

13. Preserve Bhagavad Gita philosophical terminology accurately.

14. Maintain terminology consistently throughout this batch.

15. Return ONLY the requested JSON array.

16. Do not use Markdown code fences.

17. Do not add comments before or after the JSON.

18. The object structure MUST remain exactly:
    {
      "id": "...",
      "title": "...",
      "content": "..."
    }

19. IDs MUST remain exactly unchanged.

20. Preserve the original order.

IMPORTANT:
The Telugu source supplied to you is authoritative for this project.
Do not silently correct, reinterpret, or replace the source content.

TRANSLATION GLOSSARY:
${glossaryText}
`.trim();
}

function buildUserPrompt(language, entries) {
  return `
Translate the following ${SOURCE_LANGUAGE} Bhagavad Gita entries into ${language.name}.

Return exactly ${entries.length} translated objects.

The IDs must remain exactly:

${entries.map((entry) => entry.id).join("\n")}

SOURCE:

${JSON.stringify(entries, null, 2)}
`.trim();
}

async function callGroq(language, entries) {
  const systemPrompt = buildSystemPrompt(language);
  const userPrompt = buildUserPrompt(language, entries);

  const schema = buildJsonSchema(entries);

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
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
          schema
        }
      }
    })
  });

  const responseText = await response.text();

  if (!response.ok) {
    const error = new Error(
      `Groq API error ${response.status}: ${responseText}`
    );

    error.status = response.status;
    error.headers = response.headers;

    throw error;
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Groq returned invalid API JSON: ${error.message}`
    );
  }

  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Groq returned an empty model response.");
  }

  let translated;

  try {
    translated = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Model returned invalid translation JSON: ${error.message}`
    );
  }

  return {
    translated,
    headers: response.headers
  };
}

function getHeader(headers, name) {
  if (!headers) {
    return null;
  }

  return headers.get(name);
}

function parseDuration(value) {
  if (!value) {
    return null;
  }

  const text = String(value).trim();

  const match = text.match(
    /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/
  );

  if (!match) {
    return null;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  return (
    hours * 60 * 60 * 1000 +
    minutes * 60 * 1000 +
    seconds * 1000
  );
}

async function waitForRateLimit(headers) {
  if (!config.rateLimit.useResponseHeaders) {
    return;
  }

  const remainingTokens = getHeader(
    headers,
    "x-ratelimit-remaining-tokens"
  );

  const remainingRequests = getHeader(
    headers,
    "x-ratelimit-remaining-requests"
  );

  const resetTokens = getHeader(
    headers,
    "x-ratelimit-reset-tokens"
  );

  const resetRequests = getHeader(
    headers,
    "x-ratelimit-reset-requests"
  );

  console.log(
    `Rate limit status: tokens=${remainingTokens}, requests=${remainingRequests}`
  );

  const tokenCount =
    remainingTokens === null ? null : Number(remainingTokens);

  const requestCount =
    remainingRequests === null ? null : Number(remainingRequests);

  if (
    Number.isFinite(tokenCount) &&
    tokenCount <= 0 &&
    resetTokens
  ) {
    const waitMs = parseDuration(resetTokens);

    if (waitMs !== null) {
      console.log(
        `Token limit reached. Waiting ${Math.ceil(waitMs / 1000)} seconds.`
      );

      await sleep(waitMs + 1000);
      return;
    }
  }

  if (
    Number.isFinite(requestCount) &&
    requestCount <= 0 &&
    resetRequests
  ) {
    const waitMs = parseDuration(resetRequests);

    if (waitMs !== null) {
      console.log(
        `Request limit reached. Waiting ${Math.ceil(waitMs / 1000)} seconds.`
      );

      await sleep(waitMs + 1000);
      return;
    }
  }

  await sleep(config.rateLimit.minimumDelayBetweenRequestsMs);
}

async function callGroqWithRetry(language, entries) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= config.project.maxRetries;
    attempt++
  ) {
    try {
      console.log(
        `Translating ${language.name}: ${entries[0].id} → ${
          entries[entries.length - 1].id
        } (attempt ${attempt})`
      );

      const result = await callGroq(language, entries);

      await waitForRateLimit(result.headers);

      return result.translated;
    } catch (error) {
      lastError = error;

      console.error(
        `Translation attempt ${attempt} failed: ${error.message}`
      );

      if (error.status === 429 && config.rateLimit.respectRetryAfter) {
        const retryAfter = error.headers
          ? error.headers.get("retry-after")
          : null;

        if (retryAfter) {
          const seconds = Number(retryAfter);

          if (Number.isFinite(seconds)) {
            console.log(
              `Rate limited. Waiting ${seconds} seconds.`
            );

            await sleep(seconds * 1000 + 1000);
            continue;
          }
        }
      }

      if (attempt < config.project.maxRetries) {
        const delay =
          Math.min(30000, 3000 * Math.pow(2, attempt - 1));

        console.log(
          `Waiting ${Math.ceil(delay / 1000)} seconds before retry.`
        );

        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Translation failed after ${config.project.maxRetries} attempts: ${lastError.message}`
  );
}

function writeJson(filePath, data) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );
}

function getOutputPath(language) {
  return path.join(__dirname, language.file);
}

function loadExistingOutput(language) {
  const outputPath = getOutputPath(language);

  if (!fs.existsSync(outputPath)) {
    return null;
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(outputPath, "utf8")
    );

    if (!Array.isArray(data)) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function validateExistingOutput(output, source) {
  if (!Array.isArray(output)) {
    return false;
  }

  if (output.length !== source.length) {
    return false;
  }

  for (let i = 0; i < source.length; i++) {
    const sourceEntry = source[i];
    const outputEntry = output[i];

    if (!outputEntry || outputEntry.id !== sourceEntry.id) {
      return false;
    }

    if (
      typeof outputEntry.title !== "string" ||
      !outputEntry.title.trim()
    ) {
      return false;
    }

    if (
      typeof outputEntry.content !== "string" ||
      !outputEntry.content.trim()
    ) {
      return false;
    }
  }

  return true;
}

async function translateLanguage(language, source, sourceVerseMap) {
  const outputPath = getOutputPath(language);

  const existing = loadExistingOutput(language);

  if (existing && validateExistingOutput(existing, source)) {
    console.log(
      `${language.name}: existing complete file detected. Skipping.`
    );

    return;
  }

  const translatedEntries = [];

  const batchSize = config.project.batchSize;

  for (
    let start = 0;
    start < source.length;
    start += batchSize
  ) {
    const end = Math.min(start + batchSize, source.length);

    const batch = source.slice(start, end);

    console.log(
      `\n${language.name}: processing ${start + 1}-${end} of ${source.length}`
    );

    let translatedBatch = await callGroqWithRetry(
      language,
      batch
    );

    validateBasicBatch(translatedBatch, batch);

    validateSanskritBatch(
      translatedBatch,
      batch,
      sourceVerseMap
    );

    translatedEntries.push(...translatedBatch);

    console.log(
      `${language.name}: validated ${start + 1}-${end}`
    );
  }

  if (translatedEntries.length !== source.length) {
    throw new Error(
      `${language.name}: final entry count mismatch.`
    );
  }

  const finalOutput = translatedEntries;

  writeJson(outputPath, finalOutput);

  console.log(
    `\n${language.name}: COMPLETE → ${language.file}`
  );
}

async function main() {
  console.log("==========================================");
  console.log("VIDHWAAN BHAGAVAD GITA TRANSLATION ENGINE");
  console.log("==========================================");

  console.log(`Model: ${MODEL}`);
  console.log(`Source: ${config.project.sourceFile}`);
  console.log(`Entries: ${config.project.totalEntries}`);
  console.log(`Batch size: ${config.project.batchSize}`);
  console.log("");

  const { source, raw, hash } = loadSource();

  console.log(`Source SHA-256: ${hash}`);

  const sourceVerseMap = getSourceVerseMap(source);

  console.log(
    `Validated source: ${source.length} entries`
  );

  console.log(
    `Target languages: ${config.languages.length}`
  );

  for (const language of config.languages) {
    console.log("\n------------------------------------------");
    console.log(`STARTING LANGUAGE: ${language.name}`);
    console.log("------------------------------------------");

    await translateLanguage(
      language,
      source,
      sourceVerseMap
    );

    console.log(
      `Finished language: ${language.name}`
    );
  }

  console.log("\n==========================================");
  console.log("ALL TRANSLATIONS COMPLETED");
  console.log("==========================================");
}

main().catch((error) => {
  console.error("\nFATAL ERROR:");
  console.error(error.stack || error.message);
  process.exit(1);
});
