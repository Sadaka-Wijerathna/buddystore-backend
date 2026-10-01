// src/routes/importer.routes.ts
// Proxy routes between BuddyStore frontend and the Python video-importer microservice.
// Auth stays here (Node.js). The Python service is never directly exposed to the browser.

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';
import type { AuthRequest } from '../middleware/auth.middleware';

const router = Router();

// All importer routes require an authenticated admin
router.use(authenticate, requireAdmin);

const IMPORTER_URL = process.env.VIDEO_IMPORTER_URL!;         // https://video-importer.onrender.com
const IMPORTER_SECRET = process.env.IMPORTER_API_SECRET!;     // shared secret
const BACKEND_URL = process.env.BACKEND_URL!;                 // https://buddystore-backend.onrender.com

// ── Startup validation: warn if BACKEND_URL looks like local dev ─────────────
if (IMPORTER_URL && BACKEND_URL && (BACKEND_URL.includes('localhost') || BACKEND_URL.includes('127.0.0.1'))) {
  console.warn(
    `[importer] ⚠️  BACKEND_URL is "${BACKEND_URL}" — webhook callbacks from the Python ` +
    `service won't work! Set BACKEND_URL=https://buddystore-backend.onrender.com in Render.`
  );
}

const importerHeaders = {
  'Content-Type': 'application/json',
  'x-api-secret': IMPORTER_SECRET,
};

// ── Helper: get active Hydrogram session string for an admin ─────────────────
async function getHydrogramSession(adminId: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({
    where: { key: `hydrogram_session_${adminId}` },
  });
  return setting?.value || null;
}

// ── Helper: parse Telegram message link → message ID ────────────────────────
function parseTelegramMessageId(link: string | undefined): number | undefined {
  if (!link) return undefined;
  const m = link.trim().match(/t\.me\/(?:c\/\d+\/|[^/]+\/)(\d+)/);
  if (m) return parseInt(m[1], 10);
  if (/^\d+$/.test(link.trim())) return parseInt(link.trim(), 10);
  return undefined;
}

// ── Helper: get checkpoint watermark for a source→target pair ────────────────
async function getCheckpointMsgId(sourceChat: string, targetBot: string): Promise<number | null> {
  const key = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
  const setting = await prisma.setting.findUnique({ where: { key } });
  return setting?.value ? parseInt(setting.value, 10) : null;
}

// ── Helper: persist checkpoint watermark ─────────────────────────────────────
async function saveCheckpointMsgId(sourceChat: string, targetBot: string, msgId: number) {
  const key = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
  await prisma.setting.upsert({
    where: { key },
    update: { value: String(msgId) },
    create: { key, value: String(msgId) },
  });
}

// ── POST /api/v1/admin/importer/start ────────────────────────────────────────
// Creates a job record in DB, then delegates everything (scan + download/upload) to Python.
router.post('/start', async (req: AuthRequest, res: Response) => {
  try {
    const {
      sourceChat, targetBot, limitCount, skipExisting,
      startLink, endLink,
    } = req.body;
    const adminId = req.user?.id || 'admin';

    if (!sourceChat || !targetBot) {
      res.status(400).json({ success: false, message: 'sourceChat and targetBot are required.' });
      return;
    }

    // Get Hydrogram session string from DB
    const sessionString = await getHydrogramSession(adminId);
    if (!sessionString) {
      res.status(400).json({
        success: false,
        message: 'No Hydrogram session found. Please re-login using the "Connect Hydrogram" flow.',
      });
      return;
    }

    const startMessageId = parseTelegramMessageId(startLink);
    const endMessageId = parseTelegramMessageId(endLink);
    const shouldSkipExisting = skipExisting !== undefined ? Boolean(skipExisting) : true;

    // Get the stored checkpoint watermark so the Python service knows where to stop scanning
    const lastMsgId = shouldSkipExisting
      ? await getCheckpointMsgId(sourceChat, targetBot)
      : null;

    // Resolve the target bot DB record so Python can check for duplicates
    const botHandle = targetBot.replace(/^@+/, '');
    const botRecord = await prisma.bot.findUnique({ where: { name: botHandle } });

    // Create job record in BuddyStore DB
    const job = await prisma.telegramImportJob.create({
      data: {
        adminId,
        sourceChat,
        targetBot,
        status: 'RUNNING',
        progress: 0,
        total: 0,
        message: 'Delegating to importer service...',
        limitCount: limitCount ? parseInt(String(limitCount), 10) : null,
        skipExisting: shouldSkipExisting,
        startMessageId: startMessageId ?? null,
        endMessageId: endMessageId ?? null,
        logs: JSON.stringify([`[${new Date().toLocaleTimeString()}] Initializing...`]),
      },
    });

    const webhookUrl    = `${BACKEND_URL}/api/v1/admin/importer/webhook`;
    const dupCheckUrl   = `${BACKEND_URL}/api/v1/admin/importer/check-duplicate`;

    // Delegate to Python — Python now does the scan AND import
    const response = await fetch(`${IMPORTER_URL}/start-job`, {
      method: 'POST',
      headers: importerHeaders,
      body: JSON.stringify({
        job_id: job.id,                              // Prisma DB ID → Python uses this in webhook callbacks
        admin_id: adminId,
        session_string: sessionString,
        source_chat: sourceChat,
        target_chat: targetBot,
        msg_ids: [],                                 // empty → Python scans
        webhook_url: webhookUrl,
        target_bot_db_id: botRecord?.id ?? null,
        skip_existing: shouldSkipExisting,
        last_msg_id: lastMsgId ?? null,
        start_message_id: startMessageId ?? null,
        end_message_id: endMessageId ?? null,
        limit_count: limitCount ? parseInt(String(limitCount), 10) : null,
        duplicate_check_url: botRecord ? dupCheckUrl : null,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      await prisma.telegramImportJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', message: `Importer service error: ${err}` },
      });
      res.status(500).json({ success: false, message: `Importer service error: ${err}` });
      return;
    }

    res.json({ success: true, data: { jobId: job.id, status: 'started' } });
  } catch (error: any) {
    console.error('[importer.start]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to start import.' });
  }
});

// ── POST /api/v1/admin/importer/stop ─────────────────────────────────────────
router.post('/stop', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';

    await fetch(`${IMPORTER_URL}/stop-job`, {
      method: 'POST',
      headers: importerHeaders,
      body: JSON.stringify({ admin_id: adminId }),
    });

    // Also mark all RUNNING jobs in DB as STOPPED immediately
    await prisma.telegramImportJob.updateMany({
      where: { adminId, status: 'RUNNING' },
      data: { status: 'STOPPED', message: 'Stopped by admin.' },
    });

    res.json({ success: true, status: 'stop_requested' });
  } catch (error: any) {
    console.error('[importer.stop]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to stop import.' });
  }
});

// ── POST /api/v1/admin/importer/webhook ──────────────────────────────────────
// Receives progress callbacks FROM the Python service (no auth — internal only).
// Updates the job in BuddyStore DB so the frontend can poll it via /status.
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const {
      jobId, adminId, status, progress, total,
      message, logs, checkpointMsgId,
    } = req.body;

    if (!jobId) { res.sendStatus(400); return; }

    const dbStatus =
      status === 'running'   ? 'RUNNING'   :
      status === 'completed' ? 'COMPLETED' :
      status === 'stopped'   ? 'STOPPED'   :
      'FAILED';

    // Get the job first so we know sourceChat/targetBot for checkpoint saving
    const existingJob = await prisma.telegramImportJob.findUnique({ where: { id: jobId } });

    await prisma.telegramImportJob.update({
      where: { id: jobId },
      data: {
        status: dbStatus,
        progress: progress ?? undefined,
        total: total ?? undefined,
        message: message ?? undefined,
        logs: logs ? JSON.stringify(logs) : undefined,
      },
    }).catch(() => {}); // ignore if job was already deleted

    // Save checkpoint watermark — enables "skip existing" resume on next run
    if (checkpointMsgId && existingJob) {
      await saveCheckpointMsgId(
        existingJob.sourceChat,
        existingJob.targetBot,
        checkpointMsgId,
      ).catch(() => {});
    }

    res.sendStatus(200);
  } catch (error: any) {
    console.error('[importer.webhook]', error);
    res.sendStatus(500);
  }
});

// ── GET /api/v1/admin/importer/check-duplicate ───────────────────────────────
// Called by Python service to check if a video already exists in BuddyStore DB.
// Python passes x-api-secret, not a user JWT, so this route bypasses auth middleware.
// IMPORTANT: add this BEFORE router.use(authenticate, requireAdmin) — done below via sub-router.
// We handle it separately at the end of the file with a raw express handler.
router.get('/check-duplicate', async (req: Request, res: Response) => {
  // Validate API secret instead of user JWT
  const secret = req.headers['x-api-secret'] as string;
  if (IMPORTER_SECRET && secret !== IMPORTER_SECRET) {
    res.status(401).json({ isDuplicate: false }); return;
  }

  try {
    const { botId, telegramUniqueId, fileSize, duration } = req.query as Record<string, string>;
    if (!botId) { res.json({ isDuplicate: false }); return; }

    let existing = null;

    if (telegramUniqueId) {
      existing = await prisma.videos.findFirst({
        where: { botId, telegramUniqueId },
      });
    } else if (fileSize && duration) {
      existing = await prisma.videos.findFirst({
        where: { botId, fileSize, duration: parseInt(duration, 10) },
      });
    }

    res.json({ isDuplicate: !!existing });
  } catch (error: any) {
    console.error('[importer.checkDuplicate]', error);
    res.json({ isDuplicate: false }); // fail open — don't block import
  }
});

// ── POST /api/v1/admin/importer/send-code ────────────────────────────────────
router.post('/send-code', async (req: AuthRequest, res: Response) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      res.status(400).json({ success: false, message: 'phoneNumber is required.' });
      return;
    }

    const response = await fetch(`${IMPORTER_URL}/send-code`, {
      method: 'POST',
      headers: importerHeaders,
      body: JSON.stringify({ phone: phoneNumber }),
    });

    const data = await response.json() as any;
    if (!response.ok) {
      res.status(response.status).json({ success: false, message: data?.detail || 'Failed to send code.' });
      return;
    }

    res.json({ success: true, data });
  } catch (error: any) {
    console.error('[importer.sendCode]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to send code.' });
  }
});

// ── POST /api/v1/admin/importer/generate-session ─────────────────────────────
router.post('/generate-session', async (req: AuthRequest, res: Response) => {
  try {
    const { phoneNumber, code, phoneHash } = req.body;
    const adminId = req.user?.id || 'admin';

    if (!phoneNumber || !code || !phoneHash) {
      res.status(400).json({ success: false, message: 'phoneNumber, code, and phoneHash are required.' });
      return;
    }

    const response = await fetch(`${IMPORTER_URL}/generate-session`, {
      method: 'POST',
      headers: importerHeaders,
      body: JSON.stringify({ phone: phoneNumber, code, phone_hash: phoneHash }),
    });

    const data = await response.json() as any;

    if (!response.ok) {
      if (response.status === 422) {
        res.status(422).json({ success: false, message: '2FA required', needs2FA: true });
        return;
      }
      res.status(response.status).json({ success: false, message: data?.detail || 'Login failed.' });
      return;
    }

    // Store Hydrogram session string in BuddyStore DB
    await prisma.setting.upsert({
      where: { key: `hydrogram_session_${adminId}` },
      update: { value: data.session_string },
      create: { key: `hydrogram_session_${adminId}`, value: data.session_string },
    });

    res.json({ success: true, message: 'Hydrogram session created and saved.' });
  } catch (error: any) {
    console.error('[importer.generateSession]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate session.' });
  }
});

// ── POST /api/v1/admin/importer/generate-session-2fa ─────────────────────────
router.post('/generate-session-2fa', async (req: AuthRequest, res: Response) => {
  try {
    const { phoneNumber, password } = req.body;
    const adminId = req.user?.id || 'admin';

    if (!phoneNumber || !password) {
      res.status(400).json({ success: false, message: 'phoneNumber and password are required.' });
      return;
    }

    const response = await fetch(`${IMPORTER_URL}/generate-session-2fa`, {
      method: 'POST',
      headers: importerHeaders,
      body: JSON.stringify({ phone: phoneNumber, password }),
    });

    const data = await response.json() as any;
    if (!response.ok) {
      res.status(response.status).json({ success: false, message: data?.detail || '2FA login failed.' });
      return;
    }

    await prisma.setting.upsert({
      where: { key: `hydrogram_session_${adminId}` },
      update: { value: data.session_string },
      create: { key: `hydrogram_session_${adminId}`, value: data.session_string },
    });

    res.json({ success: true, message: 'Hydrogram session (2FA) created and saved.' });
  } catch (error: any) {
    console.error('[importer.generateSession2FA]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to complete 2FA.' });
  }
});

// ── GET /api/v1/admin/importer/session-status ─────────────────────────────────
router.get('/session-status', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const session = await getHydrogramSession(adminId);
    res.json({ success: true, data: { hasSession: !!session } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET /api/v1/admin/importer/status ─────────────────────────────────────────
// Replaces the old mtcute /telegram/status. Returns auth state and running job.
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const session = await getHydrogramSession(adminId);
    
    // Find active job in DB
    const activeJob = await prisma.telegramImportJob.findFirst({
      where: { adminId, status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
    });

    const importStatus = activeJob ? {
      status: 'running',
      progress: activeJob.progress || 0,
      total: activeJob.total || 0,
      message: activeJob.message || '',
      logs: activeJob.logs ? JSON.parse(activeJob.logs) : [],
    } : {
      status: 'idle',
      progress: 0,
      total: 0,
      message: '',
      logs: [],
    };

    res.json({
      success: true,
      data: {
        authorized: !!session,
        sessionInfo: session ? { id: adminId, firstName: 'Hydrogram Admin', username: 'connected' } : null,
        importStatus
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
