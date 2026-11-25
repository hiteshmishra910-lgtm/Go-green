import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleWasteClassification } from './server/classifyWaste.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '7mb' }));

  app.get('/api/health', (_req, res) => {
    const hasKey = Boolean(
      process.env.GEMINI_API_KEY?.trim() &&
        process.env.GEMINI_API_KEY.trim() !== 'MY_GEMINI_API_KEY'
    );
    res.json({
      status: 'ok',
      aiConfigured: hasKey,
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/api/classify-waste', async (req, res) => {
    try {
      const result = await handleWasteClassification(req.body);
      if (typeof result.data.retryAfterSeconds === 'number') {
        res.setHeader('Retry-After', String(result.data.retryAfterSeconds));
      }
      res.status(result.status).json(result.data);
    } catch (err) {
      console.error('[server] /api/classify-waste error:', err);
      res.status(500).json({
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
  });

  // Ensure JSON error responses for malformed JSON or oversized payloads on /api/*
  app.use(
    '/api',
    (
      err: { status?: number; type?: string; message?: string },
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (!err) return next();
      const status =
        err.type === 'entity.too.large'
          ? 413
          : typeof err.status === 'number' && err.status >= 400 && err.status < 600
            ? err.status
            : 400;
      const message =
        err.type === 'entity.too.large'
          ? 'Image payload exceeds the server size limit. Please capture or upload a smaller photo.'
          : 'Malformed JSON request payload.';
      return res.status(status).json({
        success: false,
        category: 'Other / Unrecognized',
        confidence: 0,
        description: '',
        recyclable: false,
        points: 0,
        error: message,
        code: err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'BAD_JSON',
      });
    }
  );

  app.all('/api/*', (_req, res) => {
    res.status(404).json({
      success: false,
      category: 'Other / Unrecognized',
      confidence: 0,
      description: '',
      recyclable: false,
      points: 0,
      error: 'API endpoint not found.',
      code: 'API_NOT_FOUND',
    });
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EcoVerify server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start EcoVerify server:', err);
  process.exit(1);
});
