import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import crypto from 'node:crypto';

export const WASTE_CATEGORIES = [
  'Plastic',
  'Paper',
  'Metal',
  'Glass',
  'Organic',
  'E-waste',
  'Other / Unrecognized',
] as const;

export type WasteCategory = (typeof WASTE_CATEGORIES)[number];
export type SubjectType = 'waste' | 'human' | 'non_waste' | 'unclear';
export type QuotaCategory =
  | 'rate_limit_rpm_tpm'
  | 'daily_quota'
  | 'billing_or_spend_cap'
  | 'model_overload'
  | 'auth_error'
  | 'timeout'
  | 'invalid_input'
  | 'unknown';

export const CATEGORY_POINTS: Record<WasteCategory, number> = {
  Plastic: 15,
  Paper: 10,
  Metal: 15,
  Glass: 15,
  Organic: 10,
  'E-waste': 20,
  'Other / Unrecognized': 0,
};

export interface WasteClassificationResult {
  success: boolean;
  category: WasteCategory;
  confidence: number;
  description: string;
  recyclable: boolean;
  points: number;
  error?: string;
  subjectType: SubjectType;
  humanDetected: boolean;
  detectedSubject: string;
  explanation: string;
  disposalSuggestion: string;
  disclaimer: string;
  cached?: boolean;
}

interface ParsedGeminiError {
  httpStatus?: number;
  grpcStatus?: string;
  quotaCategory: QuotaCategory;
  retryDelaySeconds?: number;
  quotaViolations: string[];
  diagnosticDetail: string;
  retryable: boolean;
}

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const AI_TIMEOUT_MS = 22000;
const MAX_RETRIES = 3;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;

const classificationCache = new Map<
  string,
  { result: WasteClassificationResult; expiresAt: number }
>();

const SYSTEM_INSTRUCTION = `You are EcoVerify's Waste Classification Vision Engine.
Analyze the provided image carefully and determine FIRST what the primary subject is:

1. If a PERSON, HUMAN FACE, SELFIE, BODY, or PROMINENT HUMAN PORTRAIT is the main subject (and not just a hand holding an obvious waste item):
   - Set "subjectType": "human"
   - Set "humanDetected": true
   - Set "detectedSubject": "Human / Person"
   - Set "category": "Other / Unrecognized"
   - Set "recyclable": false
   - Set "description": clearly state that a person was detected instead of waste.
   - Set "disposalSuggestion": "No waste detected. Please scan an actual waste or recyclable item."

2. If a NON-WASTE OBJECT (such as a wall, desk, empty floor, car, or pet) is shown with no waste item:
   - Set "subjectType": "non_waste"
   - Set "humanDetected": false
   - Set "detectedSubject": short 2-4 word name of the object
   - Set "category": "Other / Unrecognized"
   - Set "recyclable": false

3. If the image is too blurry, dark, or unrecognizable to classify reliably:
   - Set "subjectType": "unclear"
   - Set "humanDetected": false
   - Set "detectedSubject": "Unclear Image"
   - Set "category": "Other / Unrecognized"
   - Set "recyclable": false

4. If GARBAGE / WASTE is clearly visible:
   - Set "subjectType": "waste"
   - Set "humanDetected": false
   - Set "detectedSubject": short 2-5 word name of the waste item (e.g., "Crushed Plastic Water Bottle", "Corrugated Cardboard Box", "Aluminum Soda Can", "Glass Jar", "Banana Peels", "Old Circuit Board")
   - Choose the single best "category" strictly from:
     - "Plastic" (PET bottles, HDPE jugs, plastic containers, polythene bags/wrappers, rigid plastic packaging)
     - "Paper" (cardboard boxes, newspapers, magazines, office paper, paper bags, clean cartons)
     - "Metal" (aluminum cans, tin cans, scrap metal, foil trays, steel lids)
     - "Glass" (glass bottles, jars, glass containers)
     - "Organic" (food scraps, fruit/vegetable peels, wet kitchen waste, yard trimmings, coffee grounds)
     - "E-waste" (batteries, old phones, circuit boards, cables, chargers, small electronics)
     - "Other / Unrecognized" (hazardous mixed debris or items that cannot be reliably identified)
   - Set "recyclable" accurately (true for clean Plastic, Paper, Metal, Glass, and E-waste; false for Organic or Other / Unrecognized).

Confidence must be an honest visual estimate between 0 and 95 (never claim 100%).
Keep description and disposalSuggestion concise (1-2 sentences each).`;

function redactSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
}

function errorResult(
  status: number,
  error: string,
  code: string,
  extra?: {
    quotaCategory?: QuotaCategory;
    upstreamStatus?: number;
    upstreamErrorStatus?: string;
    retryAfterSeconds?: number;
    diagnosticDetail?: string;
    retryable?: boolean;
  }
): { status: number; data: Record<string, unknown> } {
  return {
    status,
    data: {
      success: false,
      category: 'Other / Unrecognized',
      confidence: 0,
      description: '',
      recyclable: false,
      points: 0,
      error,
      code,
      quotaCategory: extra?.quotaCategory ?? 'unknown',
      retryable: extra?.retryable ?? false,
      ...(extra?.upstreamStatus !== undefined
        ? { upstreamStatus: extra.upstreamStatus }
        : {}),
      ...(extra?.upstreamErrorStatus
        ? { upstreamErrorStatus: extra.upstreamErrorStatus }
        : {}),
      ...(extra?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: extra.retryAfterSeconds }
        : {}),
      ...(extra?.diagnosticDetail
        ? { diagnosticDetail: extra.diagnosticDetail }
        : {}),
    },
  };
}

function getCachedClassification(imageHash: string): WasteClassificationResult | null {
  const entry = classificationCache.get(imageHash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    classificationCache.delete(imageHash);
    return null;
  }
  return entry.result;
}

function saveCachedClassification(
  imageHash: string,
  result: WasteClassificationResult
): void {
  if (classificationCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = classificationCache.keys().next().value;
    if (oldestKey) classificationCache.delete(oldestKey);
  }
  classificationCache.set(imageHash, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function hasValidMagicBytes(buf: Buffer, mimeType: string): boolean {
  if (buf.length < 12) return false;
  if (mimeType === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    return buf.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('AI_REQUEST_TIMEOUT'));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function normalizeCategory(raw: unknown): WasteCategory {
  if (typeof raw !== 'string') return 'Other / Unrecognized';
  const cleaned = raw.trim().toLowerCase();
  const found = WASTE_CATEGORIES.find((c) => c.toLowerCase() === cleaned);
  if (found) return found;
  if (cleaned === 'wet waste' || cleaned === 'compost' || cleaned === 'food waste') {
    return 'Organic';
  }
  if (cleaned === 'polythene') {
    return 'Plastic';
  }
  return 'Other / Unrecognized';
}

function normalizeSubjectType(raw: unknown, humanDetected: boolean): SubjectType {
  if (humanDetected) return 'human';
  if (raw === 'waste' || raw === 'human' || raw === 'non_waste' || raw === 'unclear') {
    return raw;
  }
  return 'unclear';
}

function parseRetryDelaySeconds(text: string): number | undefined {
  const retryDelayMatch = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryDelayMatch) {
    return Math.max(1, Math.ceil(Number(retryDelayMatch[1])));
  }
  const retryInMatch = text.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (retryInMatch) {
    return Math.max(1, Math.ceil(Number(retryInMatch[1])));
  }
  return undefined;
}

export function parseGeminiErrorDetails(err: unknown): ParsedGeminiError {
  const errObj = (err && typeof err === 'object' ? err : {}) as {
    status?: unknown;
    message?: unknown;
    error?: unknown;
    details?: unknown;
  };

  let httpStatus = typeof errObj.status === 'number' ? errObj.status : undefined;
  const rawMessage = redactSecrets(
    err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
  );

  let grpcStatus: string | undefined;
  let embeddedMessage = rawMessage;
  const quotaViolations: string[] = [];
  let retryDelaySeconds = parseRetryDelaySeconds(rawMessage);

  // @google/genai often embeds the JSON API response inside err.message
  const jsonStart = rawMessage.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(rawMessage.slice(jsonStart)) as {
        error?: {
          code?: number;
          message?: string;
          status?: string;
          details?: Array<{
            '@type'?: string;
            retryDelay?: string;
            violations?: Array<{
              quotaMetric?: string;
              quotaId?: string;
              quotaValue?: string;
            }>;
          }>;
        };
      };
      if (parsed?.error) {
        if (!httpStatus && typeof parsed.error.code === 'number') {
          httpStatus = parsed.error.code;
        }
        if (typeof parsed.error.status === 'string') {
          grpcStatus = parsed.error.status;
        }
        if (typeof parsed.error.message === 'string') {
          embeddedMessage = redactSecrets(parsed.error.message);
        }
        if (Array.isArray(parsed.error.details)) {
          for (const d of parsed.error.details) {
            if (typeof d.retryDelay === 'string') {
              const sec = Number(d.retryDelay.replace(/s$/i, ''));
              if (Number.isFinite(sec) && sec > 0) {
                retryDelaySeconds = Math.max(1, Math.ceil(sec));
              }
            }
            if (Array.isArray(d.violations)) {
              for (const v of d.violations) {
                const desc = [v.quotaId, v.quotaMetric, v.quotaValue ? `limit=${v.quotaValue}` : '']
                  .filter(Boolean)
                  .join(' ');
                if (desc) quotaViolations.push(desc);
              }
            }
          }
        }
      }
    } catch {
      // Fall back to regex inspection on rawMessage
    }
  }

  const violationsText = quotaViolations.join(' ').toLowerCase();
  const combinedText = `${grpcStatus ?? ''} ${embeddedMessage} ${violationsText}`.toLowerCase();
  const fullDiagnostic = [
    quotaViolations.length > 0 ? `Quota: ${quotaViolations.join('; ')}` : '',
    embeddedMessage,
  ]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 600);

  if (rawMessage === 'AI_REQUEST_TIMEOUT') {
    return {
      httpStatus: 504,
      grpcStatus: 'DEADLINE_EXCEEDED',
      quotaCategory: 'timeout',
      quotaViolations,
      diagnosticDetail: 'Request timed out after 22s waiting for Gemini API.',
      retryable: true,
    };
  }

  if (
    httpStatus === 401 ||
    (httpStatus === 403 && !combinedText.includes('billing') && !combinedText.includes('spend')) ||
    combinedText.includes('api_key_invalid') ||
    combinedText.includes('api key not valid') ||
    combinedText.includes('permission_denied')
  ) {
    return {
      httpStatus,
      grpcStatus: grpcStatus || 'PERMISSION_DENIED',
      quotaCategory: 'auth_error',
      quotaViolations,
      diagnosticDetail: fullDiagnostic,
      retryable: false,
    };
  }

  // Check PerMinute / TPM rate limits before generic boilerplate text
  if (
    violationsText.includes('perminute') ||
    violationsText.includes('per_minute') ||
    violationsText.includes('tokensperminute') ||
    violationsText.includes('requestsperminute') ||
    combinedText.includes('requests per minute') ||
    combinedText.includes('tokens per minute')
  ) {
    // Unless quotaValue is explicitly 0 (meaning model/tier disabled with limit=0)
    if (!violationsText.includes('limit=0')) {
      return {
        httpStatus: httpStatus ?? 429,
        grpcStatus: grpcStatus || 'RESOURCE_EXHAUSTED',
        quotaCategory: 'rate_limit_rpm_tpm',
        retryDelaySeconds: retryDelaySeconds ?? 10,
        quotaViolations,
        diagnosticDetail: fullDiagnostic,
        retryable: true,
      };
    }
  }

  // Check Daily Quota (RPD)
  if (
    violationsText.includes('perday') ||
    violationsText.includes('per_day') ||
    violationsText.includes('requestsperday') ||
    combinedText.includes('requests per day') ||
    combinedText.includes('daily limit') ||
    combinedText.includes('daily quota')
  ) {
    if (!violationsText.includes('limit=0')) {
      return {
        httpStatus: httpStatus ?? 429,
        grpcStatus: grpcStatus || 'RESOURCE_EXHAUSTED',
        quotaCategory: 'daily_quota',
        retryDelaySeconds,
        quotaViolations,
        diagnosticDetail: fullDiagnostic,
        retryable: false,
      };
    }
  }

  // Check explicit Billing / Spend Cap / limit=0 restriction (avoid matching generic "check your plan and billing details" boilerplate when a real RPM/RPD limit exists)
  if (
    violationsText.includes('limit=0') ||
    combinedText.includes('limit: 0') ||
    combinedText.includes('spend cap') ||
    combinedText.includes('spend_cap') ||
    combinedText.includes('billing account') ||
    combinedText.includes('enable billing') ||
    combinedText.includes('payment') ||
    combinedText.includes('account is not active')
  ) {
    return {
      httpStatus: httpStatus ?? 429,
      grpcStatus: grpcStatus || 'RESOURCE_EXHAUSTED',
      quotaCategory: 'billing_or_spend_cap',
      quotaViolations,
      diagnosticDetail: fullDiagnostic,
      retryable: false,
    };
  }

  if (
    httpStatus === 429 ||
    grpcStatus === 'RESOURCE_EXHAUSTED' ||
    combinedText.includes('resource_exhausted') ||
    combinedText.includes('quota') ||
    combinedText.includes('rate limit')
  ) {
    return {
      httpStatus: httpStatus ?? 429,
      grpcStatus: grpcStatus || 'RESOURCE_EXHAUSTED',
      quotaCategory: 'rate_limit_rpm_tpm',
      retryDelaySeconds: retryDelaySeconds ?? 10,
      quotaViolations,
      diagnosticDetail: fullDiagnostic,
      retryable: true,
    };
  }

  if (
    httpStatus === 503 ||
    grpcStatus === 'UNAVAILABLE' ||
    combinedText.includes('unavailable') ||
    combinedText.includes('high demand') ||
    combinedText.includes('overloaded')
  ) {
    return {
      httpStatus: httpStatus ?? 503,
      grpcStatus: grpcStatus || 'UNAVAILABLE',
      quotaCategory: 'model_overload',
      retryDelaySeconds: retryDelaySeconds ?? 5,
      quotaViolations,
      diagnosticDetail: fullDiagnostic,
      retryable: true,
    };
  }

  return {
    httpStatus,
    grpcStatus,
    quotaCategory: 'unknown',
    quotaViolations,
    diagnosticDetail: fullDiagnostic,
    retryable: combinedText.includes('fetch') || combinedText.includes('network'),
  };
}

export async function handleWasteClassification(
  body: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    console.error('[classify-waste] GEMINI_API_KEY is not configured.');
    return errorResult(
      503,
      'AI classification service is not configured. Set GEMINI_API_KEY in Settings > Secrets and restart.',
      'MISSING_API_KEY',
      { quotaCategory: 'auth_error', retryable: false }
    );
  }

  if (!body || typeof body !== 'object') {
    return errorResult(400, 'Invalid JSON request payload.', 'INVALID_BODY', {
      quotaCategory: 'invalid_input',
      retryable: false,
    });
  }

  const { imageBase64, mimeType } = body as {
    imageBase64?: unknown;
    mimeType?: unknown;
  };

  if (typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(mimeType)) {
    return errorResult(
      400,
      'Unsupported or missing image format. Please provide JPEG, PNG, WebP, or HEIC images.',
      'UNSUPPORTED_FORMAT',
      { quotaCategory: 'invalid_input', retryable: false }
    );
  }

  if (typeof imageBase64 !== 'string' || imageBase64.trim().length < 32) {
    return errorResult(400, 'Image data is missing or invalid.', 'INVALID_IMAGE', {
      quotaCategory: 'invalid_input',
      retryable: false,
    });
  }

  const cleanBase64 = imageBase64
    .replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
    .replace(/\s+/g, '');

  if (!/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
    return errorResult(400, 'Malformed base64 image data.', 'INVALID_BASE64', {
      quotaCategory: 'invalid_input',
      retryable: false,
    });
  }

  const decodedBuffer = Buffer.from(cleanBase64, 'base64');
  if (decodedBuffer.byteLength === 0 || decodedBuffer.byteLength > MAX_IMAGE_BYTES) {
    return errorResult(
      413,
      'Image exceeds the 5 MB size limit. Please capture or upload a smaller image.',
      'IMAGE_TOO_LARGE',
      { quotaCategory: 'invalid_input', retryable: false }
    );
  }

  if (!hasValidMagicBytes(decodedBuffer, mimeType)) {
    return errorResult(
      400,
      'Uploaded file is corrupted or does not match the declared image format.',
      'INVALID_IMAGE_DATA',
      { quotaCategory: 'invalid_input', retryable: false }
    );
  }

  // Return saved classification immediately if this exact image was already analyzed recently
  const imageHash = crypto.createHash('sha256').update(decodedBuffer).digest('hex');
  const cached = getCachedClassification(imageHash);
  if (cached) {
    return {
      status: 200,
      data: { ...cached, cached: true },
    };
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const callGemini = async (modelName: string) => {
    const config: Record<string, unknown> = {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          subjectType: {
            type: Type.STRING,
            enum: ['waste', 'human', 'non_waste', 'unclear'],
            description:
              'Whether the image shows waste, a human, a non-waste object, or is unclear.',
          },
          humanDetected: {
            type: Type.BOOLEAN,
            description: 'True if a human face/person is the main subject in the image.',
          },
          detectedSubject: {
            type: Type.STRING,
            description: 'Short 2-5 word label of what was detected in the image.',
          },
          category: {
            type: Type.STRING,
            enum: [...WASTE_CATEGORIES],
            description: 'Matched waste category, or Other / Unrecognized when not waste.',
          },
          confidence: {
            type: Type.NUMBER,
            description: 'Visual confidence estimate between 0 and 95.',
          },
          description: {
            type: Type.STRING,
            description: 'Short description of what was visually observed in the image.',
          },
          recyclable: {
            type: Type.BOOLEAN,
            description:
              'Whether the detected waste item is recyclable (false if organic, human, or unrecognized).',
          },
          disposalSuggestion: {
            type: Type.STRING,
            description: 'Practical sorting instruction or prompt to scan actual waste.',
          },
        },
        required: [
          'subjectType',
          'humanDetected',
          'detectedSubject',
          'category',
          'confidence',
          'description',
          'recyclable',
          'disposalSuggestion',
        ],
      },
    };

    if (modelName === 'gemini-4-hydrogen') {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    }

    return withTimeout(
      ai.models.generateContent({
        model: modelName,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: cleanBase64,
              },
            },
            {
              text: 'Classify the waste item in this image into Plastic, Paper, Metal, Glass, Organic, E-waste, or Other / Unrecognized. If a human or non-waste object is the primary subject, return Other / Unrecognized.',
            },
          ],
        },
        config,
      }),
      AI_TIMEOUT_MS
    );
  };

  // Primary vision model + 1 fallback vision-capable Flash model.
  // Up to 1 initial attempt + MAX_RETRIES (3) retries on temporary 429/503 only.
  const attemptModels = [
    'gemini-4-hydrogen',
    'gemini-3.1-flash-lite',
    'gemini-4-hydrogen',
    'gemini-3.1-flash-lite',
  ];

  let response;
  let lastParsedErr: ParsedGeminiError | null = null;
  let triedFallbackModel = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const modelName = attemptModels[attempt] || 'gemini-4-hydrogen';
    if (modelName !== 'gemini-4-hydrogen') triedFallbackModel = true;

    try {
      response = await callGemini(modelName);
      lastParsedErr = null;
      break;
    } catch (err: unknown) {
      const parsedErr = parseGeminiErrorDetails(err);
      lastParsedErr = parsedErr;

      console.error(
        `[classify-waste] Gemini API error on attempt ${attempt + 1}/${MAX_RETRIES + 1} (${modelName}):`,
        JSON.stringify({
          httpStatus: parsedErr.httpStatus,
          grpcStatus: parsedErr.grpcStatus,
          quotaCategory: parsedErr.quotaCategory,
          retryDelaySeconds: parsedErr.retryDelaySeconds,
          quotaViolations: parsedErr.quotaViolations,
          detail: parsedErr.diagnosticDetail,
        })
      );

      // If primary model hit daily quota or billing/model-level limit=0, allow ONE check on the fallback model before aborting
      const canTrySingleFallback =
        !triedFallbackModel &&
        attempt === 0 &&
        (parsedErr.quotaCategory === 'daily_quota' ||
          parsedErr.quotaCategory === 'billing_or_spend_cap' ||
          parsedErr.httpStatus === 404);

      if (canTrySingleFallback) {
        continue;
      }

      // Never retry daily quota exhaustion, billing/spend cap, auth, or non-retryable errors
      if (!parsedErr.retryable || attempt === MAX_RETRIES) {
        return formatMappedError(parsedErr);
      }

      // If Google returned a retryDelay > 6s, return 429/503 immediately so UI shows the exact countdown
      if (parsedErr.retryDelaySeconds && parsedErr.retryDelaySeconds > 6) {
        return formatMappedError(parsedErr);
      }

      const backoffMs = Math.min(6000, 1000 * Math.pow(2, attempt));
      const delayMs = parsedErr.retryDelaySeconds
        ? Math.max(backoffMs, parsedErr.retryDelaySeconds * 1000)
        : backoffMs;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (lastParsedErr || !response) {
    return formatMappedError(
      lastParsedErr ?? {
        quotaCategory: 'unknown',
        quotaViolations: [],
        diagnosticDetail: 'No response returned from Gemini.',
        retryable: true,
      }
    );
  }

  const rawText = response.text?.trim();
  if (!rawText) {
    console.error('[classify-waste] Empty response from Gemini.');
    return errorResult(
      502,
      'AI returned an empty analysis. Please retry with a clearer photo.',
      'EMPTY_RESPONSE',
      { quotaCategory: 'unknown', retryable: true }
    );
  }

  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const humanDetected =
      Boolean(parsed.humanDetected) || parsed.subjectType === 'human';
    const subjectType = normalizeSubjectType(parsed.subjectType, humanDetected);
    const category: WasteCategory =
      subjectType === 'waste'
        ? normalizeCategory(parsed.category)
        : 'Other / Unrecognized';

    const recognizedWaste =
      subjectType === 'waste' && category !== 'Other / Unrecognized';

    const rawConf = typeof parsed.confidence === 'number' ? parsed.confidence : 50;
    const clampedConfidence = Math.min(95, Math.max(0, Math.round(rawConf)));

    const detectedSubject =
      typeof parsed.detectedSubject === 'string' &&
      parsed.detectedSubject.trim().length > 0
        ? parsed.detectedSubject.trim().slice(0, 80)
        : humanDetected
          ? 'Human / Person'
          : category;

    const descriptionText =
      typeof parsed.description === 'string' && parsed.description.trim().length > 0
        ? parsed.description.trim().slice(0, 450)
        : humanDetected
          ? 'A person was detected in the frame instead of waste.'
          : 'Visual inspection completed.';

    const recyclable = recognizedWaste ? Boolean(parsed.recyclable) : false;
    const points = recognizedWaste ? (CATEGORY_POINTS[category] ?? 0) : 0;

    const disposalSuggestion =
      typeof parsed.disposalSuggestion === 'string' &&
      parsed.disposalSuggestion.trim().length > 0
        ? parsed.disposalSuggestion.trim().slice(0, 450)
        : humanDetected
          ? 'No waste points awarded. Please scan actual waste items.'
          : 'Confirm material separation according to municipal sorting rules.';

    const errorMessage = recognizedWaste
      ? undefined
      : humanDetected
        ? 'Human detected instead of waste. No points awarded.'
        : subjectType === 'non_waste'
          ? `Non-waste object detected (${detectedSubject}). No points awarded.`
          : 'Unable to recognize a supported waste category. No points awarded.';

    const result: WasteClassificationResult = {
      success: recognizedWaste,
      category,
      confidence: clampedConfidence,
      description: descriptionText,
      recyclable,
      points,
      ...(errorMessage ? { error: errorMessage } : {}),
      subjectType,
      humanDetected,
      detectedSubject,
      explanation: descriptionText,
      disposalSuggestion,
      disclaimer:
        'AI estimate only — not guaranteed 100% accurate. Collector confirmation applies.',
    };

    saveCachedClassification(imageHash, result);
    return { status: 200, data: { ...result, cached: false } };
  } catch (parseErr) {
    console.error('[classify-waste] Failed to parse Gemini JSON:', parseErr);
    return errorResult(
      502,
      'AI returned a malformed classification response. Please retry.',
      'MALFORMED_JSON',
      { quotaCategory: 'unknown', retryable: true }
    );
  }
}

export function formatMappedError(parsed: ParsedGeminiError): {
  status: number;
  data: Record<string, unknown>;
} {
  if (parsed.quotaCategory === 'daily_quota') {
    return errorResult(
      429,
      'Daily AI classification limit reached.',
      'DAILY_QUOTA_EXHAUSTED',
      {
        quotaCategory: 'daily_quota',
        upstreamStatus: parsed.httpStatus ?? 429,
        upstreamErrorStatus: parsed.grpcStatus ?? 'RESOURCE_EXHAUSTED',
        retryAfterSeconds: parsed.retryDelaySeconds,
        diagnosticDetail: parsed.diagnosticDetail,
        retryable: false,
      }
    );
  }

  if (parsed.quotaCategory === 'billing_or_spend_cap') {
    return errorResult(
      402,
      'Please check Gemini API billing configuration.',
      'BILLING_ISSUE',
      {
        quotaCategory: 'billing_or_spend_cap',
        upstreamStatus: parsed.httpStatus ?? 429,
        upstreamErrorStatus: parsed.grpcStatus ?? 'RESOURCE_EXHAUSTED',
        diagnosticDetail: parsed.diagnosticDetail,
        retryable: false,
      }
    );
  }

  if (parsed.quotaCategory === 'rate_limit_rpm_tpm') {
    return errorResult(
      429,
      'Temporary rate limit: Please wait and retry.',
      'RATE_LIMITED',
      {
        quotaCategory: 'rate_limit_rpm_tpm',
        upstreamStatus: parsed.httpStatus ?? 429,
        upstreamErrorStatus: parsed.grpcStatus ?? 'RESOURCE_EXHAUSTED',
        retryAfterSeconds: parsed.retryDelaySeconds ?? 10,
        diagnosticDetail: parsed.diagnosticDetail,
        retryable: true,
      }
    );
  }

  if (parsed.quotaCategory === 'model_overload') {
    return errorResult(
      503,
      'AI service is busy. Try again shortly.',
      'MODEL_BUSY',
      {
        quotaCategory: 'model_overload',
        upstreamStatus: parsed.httpStatus ?? 503,
        upstreamErrorStatus: parsed.grpcStatus ?? 'UNAVAILABLE',
        retryAfterSeconds: parsed.retryDelaySeconds ?? 5,
        diagnosticDetail: parsed.diagnosticDetail,
        retryable: true,
      }
    );
  }

  if (parsed.quotaCategory === 'auth_error') {
    return errorResult(
      502,
      'Gemini API authentication failed. Please verify GEMINI_API_KEY in Settings > Secrets.',
      'INVALID_API_KEY',
      {
        quotaCategory: 'auth_error',
        upstreamStatus: parsed.httpStatus ?? 403,
        upstreamErrorStatus: parsed.grpcStatus ?? 'PERMISSION_DENIED',
        diagnosticDetail: parsed.diagnosticDetail,
        retryable: false,
      }
    );
  }

  if (parsed.quotaCategory === 'timeout') {
    return errorResult(
      504,
      'AI waste analysis timed out. Please retry with a clearer or smaller image.',
      'TIMEOUT',
      {
        quotaCategory: 'timeout',
        upstreamStatus: 504,
        upstreamErrorStatus: 'DEADLINE_EXCEEDED',
        retryAfterSeconds: 3,
        diagnosticDetail: parsed.diagnosticDetail,
        retryable: true,
      }
    );
  }

  if (parsed.httpStatus === 404 || parsed.grpcStatus === 'NOT_FOUND') {
    return errorResult(
      502,
      'Configured Gemini vision model was not found on the provider.',
      'MODEL_NOT_FOUND',
      {
        quotaCategory: 'unknown',
        upstreamStatus: 404,
        upstreamErrorStatus: parsed.grpcStatus ?? 'NOT_FOUND',
        diagnosticDetail: parsed.diagnosticDetail,
        retryable: false,
      }
    );
  }

  return errorResult(
    502,
    `AI classification failed (${parsed.httpStatus ? `HTTP ${parsed.httpStatus}` : 'upstream error'} ${parsed.grpcStatus ?? ''}).`.trim(),
    'AI_UPSTREAM_ERROR',
    {
      quotaCategory: 'unknown',
      upstreamStatus: parsed.httpStatus,
      upstreamErrorStatus: parsed.grpcStatus,
      diagnosticDetail: parsed.diagnosticDetail,
      retryable: parsed.retryable,
    }
  );
}
