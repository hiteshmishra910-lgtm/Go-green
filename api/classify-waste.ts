import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleWasteClassification } from '../server/classifyWaste.ts';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '7mb',
    },
  },
};

interface VercelRequest extends IncomingMessage {
  method?: string;
  body?: unknown;
}

interface VercelResponse extends ServerResponse {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      success: false,
      category: 'Other / Unrecognized',
      confidence: 0,
      description: '',
      recyclable: false,
      points: 0,
      error: 'Method not allowed. Use POST.',
      code: 'METHOD_NOT_ALLOWED',
    });
  }

  try {
    let parsedBody = req.body;
    if (typeof parsedBody === 'string') {
      parsedBody = JSON.parse(parsedBody);
    }
    const result = await handleWasteClassification(parsedBody);
    if (typeof result.data.retryAfterSeconds === 'number') {
      res.setHeader('Retry-After', String(result.data.retryAfterSeconds));
    }
    return res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[api/classify-waste] Unhandled serverless error:', err);
    return res.status(500).json({
      success: false,
      category: 'Other / Unrecognized',
      confidence: 0,
      description: '',
      recyclable: false,
      points: 0,
      error: 'Unexpected server error during waste classification.',
      code: 'INTERNAL_ERROR',
    });
  }
}
