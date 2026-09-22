const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "translation-config.json");
const GLOSSARY_PATH = path.join(__dirname, "translation-glossary.json");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const glossary = JSON.parse(fs.readFileSync(GLOSSARY_PATH, "utf8"));

const API_KEY = process.env.GROQ_API_KEY;

if (!API_KEY) {
  console.error("ERROR: GROQ_API_KEY is not set.");
  process.exit(1);
}

const API_URL = "https://api.groq.com/openai/v1/chat/completions";

const MODEL = config.project.model;
const SOURCE_FILE = path.join(__dirname, config.project.sourceFile);

const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));

if (!Array.isArray(source) || source.length !== 100) {
  console.error("ERROR: Source must contain exactly 100 entries.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSanskritVerse(content) {
  if (typeof content !== "string") {
    return null;
  }

  const match = content.match(
    /(?:శ్లోకం|श्लोक|श्लोकः|Verse|Sloka|śloka)\s*:\s*([\s\S]*?)(?:\n\s*\n|$)/i
  );

  return match ? match[1].trim() : null;
}

function normalizeText(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function validateBasicStructure(data, language) {
  const errors = [];

  if (!Array.isArray(data)) {
    errors.push(`${language}: output is not an array.`);
    return errors;
  }

  if (data.length !== 100) {
    errors.push(
      `${language}: expected 100 entries, found ${data.length}.`
    );
  }

  const ids = new Set();

  for (let i = 0; i < data.length; i++) {
    const item = data[i];

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${language}: entry ${i + 1} is not an object.`);
      continue;
    }

    const keys = Object.keys(item).sort();

    if (
      keys.length !== 3 ||
      keys[0] !== "content" ||
      keys[1] !== "id" ||
      keys[2] !== "title"
    ) {
      errors.push(
        `${language}: entry ${i + 1} must contain exactly id, title, content.`
      );
    }

    const expectedId = `gita_${i + 1}`;

    if (item.id !== expectedId) {
      errors.push(
        `${language}: entry ${i + 1} expected id ${expectedId}, found ${item.id}.`
      );
    }

    if (ids.has(item.id)) {
      errors.push(`${language}: duplicate id ${item.id}.`);
    }

    ids.add(item.id);

    if (
      typeof item.title !== "string" ||
      item.title.trim().length === 0
    ) {
      errors.push(`${language}: ${item.id} has empty title.`);
    }

    if (
      typeof item.content !== "string" ||
      item.content.trim().length === 0
    ) {
      errors.push(`${language}: ${item.id} has empty content.`);
    }
  }

  return errors;
}

function validateSanskrit(sourceData, translatedData, language) {
  const errors = [];

  for (let i = 0; i < sourceData.length; i++) {
    const sourceEntry = sourceData[i];
    const translatedEntry = translatedData[i];

    if (!translatedEntry) {
      errors.push(
        `${language}: missing translated entry ${sourceEntry.id}.`
      );
      continue;
    }

    const sourceVerse = getSanskritVerse(sourceEntry.content);

    if (!sourceVerse) {
      errors.push(
        `${language}: could not extract Sanskrit verse from source ${sourceEntry.id}.`
      );
      continue;
    }

    const translatedContent = normalizeText(translatedEntry.content);

    if (!translatedContent.includes(sourceVerse)) {
      errors.push(
        `${language}: Sanskrit verse changed or missing in ${sourceEntry.id}.`
      );
    }
  }

  return errors;
}

function buildValidationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      overallPass: {
        type: "boolean"
      },
      score: {
        type: "integer",
        minimum: 0,
        maximum: 100
      },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string"
            },
            type: {
              type: "string",
              enum: [
                "meaning",
                "omission",
                "addition",
                "title",
                "language",
                "terminology",
                "format",
                "sanskrit",
                "other"
              ]
            },
            severity: {
              type: "string",
              enum: [
                "critical",
                "major",
                "minor"
              ]
            },
            explanation: {
              type: "string"
            }
          },
          required: [
            "id",
            "type",
            "severity",
            "explanation"
          ]
        }
      }
    },
    required: [
      "overallPass",
      "score",
      "issues"
    ]
  };
}

async function validateWithGroq(language, sourceBatch, translatedBatch) {
  const schema = buildValidationSchema();

  const systemPrompt = `
You are a highly rigorous multilingual Bhagavad Gita translation validator.

The supplied Telugu text is the authoritative source.

Your task is NOT to rewrite the translation.

You must determine whether the target-language translation faithfully preserves
the meaning of the supplied Telugu source.

Rules:

1. Compare every translated entry against its corresponding Telugu source entry.
2. Do not use outside versions of the Bhagavad Gita as a replacement source.
3. Do not silently correct the supplied Telugu source.
4. Do not judge based on personal preference.
5. Do not require word-for-word translation when natural target-language grammar
   requires a different structure.
6. Meaning, philosophical intent, relationships between ideas, and important
   qualifications must be preserved.
7. Detect omitted information.
8. Detect information added by the translator that is not present in the source.
9. Detect meaning changes.
10. Detect mistranslation of important spiritual/philosophical terminology.
11. Detect untranslated Telugu text where translation is expected.
12. Detect inappropriate language mixing.
13. Titles must accurately represent the source titles.
14. The Sanskrit verse must remain exactly unchanged.
15. Do not treat normal grammatical restructuring as an error.
16. Do not demand literal translation when literal translation would sound
    unnatural in the target language.
17. Do not reward or penalize literary style unless it changes meaning.
18. A translation must not summarize the source.
19. A translation must not expand the source with explanations that were not
    present.
20. A translation must not remove explanations present in the source.

The validation must be conservative.

Only report an issue when there is meaningful evidence that the translation
does not faithfully represent the supplied source.

The target language is: ${language}

Return ONLY the requested JSON object.
`;

  const userPrompt = `
Validate these Bhagavad Gita translations.

TARGET LANGUAGE:
${language}

IMPORTANT TERMINOLOGY GUIDANCE:
${JSON.stringify(glossary, null, 2)}

SOURCE ENTRIES:
${JSON.stringify(sourceBatch, null, 2)}

TRANSLATED ENTRIES:
${JSON.stringify(translatedBatch, null, 2)}

For every detected issue, identify the exact entry id.

Use:
- critical = major meaning failure, missing substantial content, fabricated content,
  changed Sanskrit verse, or serious philosophical mistranslation.
- major = significant meaning distortion or important omission/addition.
- minor = small terminology or wording issue that does not substantially alter meaning.

Set overallPass to false if there is any critical or major issue.

A minor issue alone does not necessarily require rejection.

Score the semantic fidelity from 0 to 100.
`;

  let lastError = null;

  for (let attempt = 1; attempt <= config.project.maxRetries; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_completion_tokens: 8000,
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
              name: "gita_translation_validation",
              strict: true,
              schema
            }
          }
        })
      });

      if (response.status === 429) {
        const retryAfter =
          Number(response.headers.get("retry-after")) || 10;

        console.log(
          `Rate limit reached. Waiting ${retryAfter} seconds...`
        );

        await sleep(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();

        throw new Error(
          `Groq API ${response.status}: ${body}`
        );
      }

      const result = await response.json();

      const content =
        result &&
        result.choices &&
        result.choices[0] &&
        result.choices[0].message &&
        result.choices[0].message.content;

      if (!content) {
        throw new Error("Groq returned empty validation response.");
      }

      const parsed = JSON.parse(content);

      if (
        typeof parsed.overallPass !== "boolean" ||
        !Number.isInteger(parsed.score) ||
        !Array.isArray(parsed.issues)
      ) {
        throw new Error(
          "Groq returned invalid validation structure."
        );
      }

      return parsed;
    } catch (error) {
      lastError = error;

      console.error(
        `Validation attempt ${attempt} failed: ${error.message}`
      );

      if (attempt < config.project.maxRetries) {
        const delay = Math.min(
          30000,
          2000 * Math.pow(2, attempt - 1)
        );

        await sleep(delay);
      }
    }
  }

  throw lastError || new Error("Validation failed.");
}

async function validateLanguage(languageConfig) {
  const language = languageConfig.name;
  const filePath = path.join(
    __dirname,
    languageConfig.file
  );

  console.log("");
  console.log("========================================");
  console.log(`Validating: ${language}`);
  console.log(`File: ${languageConfig.file}`);
  console.log("========================================");

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `${language}: file does not exist: ${languageConfig.file}`
    );
  }

  let translated;

  try {
    translated = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch (error) {
    throw new Error(
      `${language}: invalid JSON: ${error.message}`
    );
  }

  const structuralErrors = validateBasicStructure(
    translated,
    language
  );

  if (structuralErrors.length > 0) {
    console.error("");
    console.error("STRUCTURAL VALIDATION FAILED:");

    for (const error of structuralErrors) {
      console.error(`- ${error}`);
    }

    return {
      language,
      passed: false,
      structuralErrors,
      semanticResult: null
    };
  }

  const sanskritErrors = validateSanskrit(
    source,
    translated,
    language
  );

  if (sanskritErrors.length > 0) {
    console.error("");
    console.error("SANSKRIT VALIDATION FAILED:");

    for (const error of sanskritErrors) {
      console.error(`- ${error}`);
    }

    return {
      language,
      passed: false,
      structuralErrors: [],
      sanskritErrors,
      semanticResult: null
    };
  }

  const batchSize = config.project.batchSize;
  const semanticResults = [];

  for (
    let start = 0;
    start < source.length;
    start += batchSize
  ) {
    const end = Math.min(
      start + batchSize,
      source.length
    );

    const sourceBatch = source.slice(start, end);
    const translatedBatch = translated.slice(start, end);

    console.log(
      `Semantic validation: ${start + 1}-${end} / ${source.length}`
    );

    const result = await validateWithGroq(
      language,
      sourceBatch,
      translatedBatch
    );

    semanticResults.push({
      start: start + 1,
      end,
      result
    });

    await sleep(
      config.rateLimit.minimumDelayBetweenRequestsMs
    );
  }

  const allIssues = [];

  let minimumScore = 100;
  let allPassed = true;

  for (const batch of semanticResults) {
    const result = batch.result;

    minimumScore = Math.min(
      minimumScore,
      result.score
    );

    if (!result.overallPass) {
      allPassed = false;
    }

    for (const issue of result.issues) {
      allIssues.push({
        ...issue,
        batchStart: batch.start,
        batchEnd: batch.end
      });

      if (
        issue.severity === "critical" ||
        issue.severity === "major"
      ) {
        allPassed = false;
      }
    }
  }

  const criticalIssues = allIssues.filter(
    issue => issue.severity === "critical"
  );

  const majorIssues = allIssues.filter(
    issue => issue.severity === "major"
  );

  console.log("");
  console.log(`Language: ${language}`);
  console.log(`Minimum batch score: ${minimumScore}`);
  console.log(`Total issues: ${allIssues.length}`);
  console.log(`Critical issues: ${criticalIssues.length}`);
  console.log(`Major issues: ${majorIssues.length}`);
  console.log(
    `Semantic validation: ${allPassed ? "PASS" : "FAIL"}`
  );

  const report = {
    language,
    file: languageConfig.file,
    model: MODEL,
    totalEntries: translated.length,
    minimumBatchScore: minimumScore,
    passed: allPassed,
    structuralErrors: [],
    sanskritErrors: [],
    issues: allIssues,
    batches: semanticResults
  };

  const reportPath = path.join(
    __dirname,
    `${path.basename(
      languageConfig.file,
      ".json"
    )}.validation.json`
  );

  fs.writeFileSync(
    reportPath,
    JSON.stringify(report, null, 2),
    "utf8"
  );

  console.log(
    `Validation report written: ${path.basename(reportPath)}`
  );

  return report;
}

async function main() {
  console.log("Vidhwaan Bhagavad Gita Translation Validator");
  console.log("--------------------------------------------");
  console.log(`Model: ${MODEL}`);
  console.log(`Source: ${config.project.sourceFile}`);
  console.log(`Entries: ${source.length}`);

  const requestedLanguage =
    process.argv[2] || null;

  let languages = config.languages;

  if (requestedLanguage) {
    languages = config.languages.filter(
      language =>
        language.code === requestedLanguage ||
        language.name.toLowerCase() ===
          requestedLanguage.toLowerCase() ||
        language.file === requestedLanguage
    );

    if (languages.length === 0) {
      console.error(
        `ERROR: Language not found: ${requestedLanguage}`
      );
      process.exit(1);
    }
  }

  let failed = false;

  for (const languageConfig of languages) {
    const result = await validateLanguage(
      languageConfig
    );

    if (!result.passed) {
      failed = true;
    }
  }

  console.log("");
  console.log("========================================");

  if (failed) {
    console.error(
      "VALIDATION FAILED."
    );
    console.error(
      "Do not commit failed translations."
    );

    process.exit(1);
  }

  console.log(
    "ALL REQUESTED TRANSLATIONS PASSED."
  );
  console.log("========================================");
}

main().catch(error => {
  console.error("");
  console.error("FATAL ERROR:");
  console.error(error.stack || error.message);
  process.exit(1);
});
