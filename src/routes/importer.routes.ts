// src/routes/importer.routes.ts
// Proxy routes between BuddyStore frontend and the Python video-importer microservice.
// Auth stays here (Node.js). The Python service is never directly exposed to the browser.

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';
import type { AuthRequest } from '../middleware/auth.middleware';

const router = Router();

const IMPORTER_URL = process.env.VIDEO_IMPORTER_URL!;         // https://video-importer.onrender.com
const IMPORTER_SECRET = process.env.IMPORTER_API_SECRET!;     // shared secret
const BACKEND_URL = process.env.BACKEND_URL!;                 // https://buddystore-backend.onrender.com

// ── Helper: persist checkpoint watermark ─────────────────────────────────────
async function saveCheckpointMsgId(sourceChat: string, targetBot: string, msgId: number) {
  const key = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
  await prisma.setting.upsert({
    where: { key },
    update: { value: String(msgId) },
    create: { key, value: String(msgId) },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Service-to-service routes (Python → Node). Validated via x-api-secret,
// NOT JWT. These MUST be defined BEFORE router.use(authenticate, requireAdmin).
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/v1/admin/importer/webhook ──────────────────────────────────────
// Receives progress callbacks FROM the Python service.
// Updates the job in BuddyStore DB so the frontend can poll it via /status.
router.post('/webhook', async (req: Request, res: Response) => {
  // Validate shared secret (Python sends x-api-secret, not a JWT)
  const secret = req.headers['x-api-secret'] as string;
  if (IMPORTER_SECRET && secret !== IMPORTER_SECRET) {
    res.sendStatus(401); return;
  }

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

    if (!existingJob) {
      console.warn(`[importer.webhook] Job not found in DB: "${jobId}" (adminId: ${adminId})`);
    }

    await prisma.telegramImportJob.update({
      where: { id: jobId },
      data: {
        status: dbStatus,
        progress: progress ?? undefined,
        total: total ?? undefined,
        message: message ?? undefined,
        logs: logs ? JSON.stringify(logs) : undefined,
      },
    }).catch((err: any) => {
      console.warn(`[importer.webhook] DB update failed for job "${jobId}":`, err?.message);
    });

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

// ── POST /api/v1/admin/importer/auto-resume ──────────────────────────────────
// Called by Python service on startup via x-api-secret (NOT JWT).
// Finds any jobs that were RUNNING or recently STOPPED due to a server restart
// and re-triggers them automatically.
router.post('/auto-resume', async (req: Request, res: Response) => {
  const secret = req.headers['x-api-secret'] as string;
  if (IMPORTER_SECRET && secret !== IMPORTER_SECRET) {
    res.sendStatus(401); return;
  }

  try {
    // Look for jobs that were interrupted: RUNNING (shouldn't exist after server.ts
    // cleanup) OR STOPPED with the specific restart message set by server.ts.
    const interruptedJobs = await prisma.telegramImportJob.findMany({
      where: {
        OR: [
          { status: 'RUNNING' },
          {
            status: 'STOPPED',
            message: { contains: 'Interrupted by server restart' },
          },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 10, // safety cap — never resume more than 10 jobs at once
    });

    if (interruptedJobs.length === 0) {
      res.json({ resumed: 0 }); return;
    }

    console.log(`[importer.auto-resume] Python service restarted. Attempting to resume ${interruptedJobs.length} interrupted jobs...`);

    let resumedCount = 0;
    for (const job of interruptedJobs) {
      try {
        await resumeJob(job.id, job.adminId);
        resumedCount++;
        console.log(`[importer.auto-resume] Resumed job ${job.id}`);
      } catch (err: any) {
        console.error(`[importer.auto-resume] Failed to resume job ${job.id}:`, err.message);
      }
    }

    res.json({ resumed: resumedCount });
  } catch (error: any) {
    console.error('[importer.auto-resume]', error);
    res.sendStatus(500);
  }
});

// ── GET /api/v1/admin/importer/check-duplicate ───────────────────────────────
// Called by Python service to check if a video already exists in BuddyStore DB.
router.get('/check-duplicate', async (req: Request, res: Response) => {
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

// ══════════════════════════════════════════════════════════════════════════════
// Admin-facing routes (browser → Node). Require JWT auth.
// ══════════════════════════════════════════════════════════════════════════════
router.use(authenticate, requireAdmin);

// (IMPORTER_URL, IMPORTER_SECRET, BACKEND_URL declared above auth middleware)

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

// ── Helper: get active phone number for an admin (mirrors mtproto.service logic) ─
async function getActivePhone(adminId: string): Promise<string | null> {
  const activeSetting = await prisma.setting.findUnique({
    where: { key: `telegram_active_account_${adminId}` },
  });
  if (activeSetting?.value) return activeSetting.value;
  // Fallback: first account in accounts list
  const accountsSetting = await prisma.setting.findUnique({
    where: { key: `telegram_accounts_${adminId}` },
  });
  const accounts: { phoneNumber: string }[] = accountsSetting?.value
    ? JSON.parse(accountsSetting.value)
    : [];
  return accounts[0]?.phoneNumber || null;
}

// ── Helper: build Hydrogram session DB key for an admin + phone ───────────────
function hydrogramKey(adminId: string, phone: string | null): string {
  // Per-account key: hydrogram_session_<adminId>_<phone>
  // Falls back to legacy key (hydrogram_session_<adminId>) when phone is unknown
  return phone ? `hydrogram_session_${adminId}_${phone}` : `hydrogram_session_${adminId}`;
}

// ── Helper: get active Hydrogram session string for an admin ─────────────────
// Looks up the session for the currently active Telegram phone number first,
// then falls back to the legacy single-key session for backward compatibility.
async function getHydrogramSession(adminId: string): Promise<string | null> {
  const phone = await getActivePhone(adminId);

  // Try per-account key first
  if (phone) {
    const perAccount = await prisma.setting.findUnique({
      where: { key: hydrogramKey(adminId, phone) },
    });
    if (perAccount?.value) return perAccount.value;
  }

  // Fall back to legacy key (sessions saved before this update)
  const legacy = await prisma.setting.findUnique({
    where: { key: `hydrogram_session_${adminId}` },
  });
  return legacy?.value || null;
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

// (saveCheckpointMsgId declared above auth middleware)

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
        admin_id: adminId,
        job_db_id: job.id,                           // ← DB job ID so Python uses it in webhook callbacks
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

// ── Helper: Resume Job ────────────────────────────────────────────────────────
async function resumeJob(jobId: string, adminId: string) {
  const job = await prisma.telegramImportJob.findUnique({
    where: { id: jobId }
  });

  if (!job) throw new Error('Job not found.');
  if (job.status === 'COMPLETED') throw new Error('Job already completed.');

  const sessionString = await getHydrogramSession(adminId);
  if (!sessionString) {
    throw new Error('No Hydrogram session found. Please re-login using the "Connect Hydrogram" flow.');
  }

  const shouldSkipExisting = job.skipExisting !== undefined ? Boolean(job.skipExisting) : true;
  const lastMsgId = shouldSkipExisting
    ? await getCheckpointMsgId(job.sourceChat, job.targetBot)
    : null;

  const botHandle = job.targetBot.replace(/^@+/, '');
  const botRecord = await prisma.bot.findUnique({ where: { name: botHandle } });

  const webhookUrl    = `${BACKEND_URL}/api/v1/admin/importer/webhook`;
  const dupCheckUrl   = `${BACKEND_URL}/api/v1/admin/importer/check-duplicate`;

  const response = await fetch(`${IMPORTER_URL}/start-job`, {
    method: 'POST',
    headers: importerHeaders,
    body: JSON.stringify({
      admin_id: adminId,
      job_db_id: job.id,
      session_string: sessionString,
      source_chat: job.sourceChat,
      target_chat: job.targetBot,
      msg_ids: [],
      webhook_url: webhookUrl,
      target_bot_db_id: botRecord?.id ?? null,
      skip_existing: shouldSkipExisting,
      last_msg_id: lastMsgId ?? null,
      start_message_id: job.startMessageId ?? null,
      end_message_id: job.endMessageId ?? null,
      limit_count: job.limitCount ?? null,
      duplicate_check_url: botRecord ? dupCheckUrl : null,
      initial_progress: job.progress || 0,
      original_total: job.total || 0,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Importer service error: ${err}`);
  }

  await prisma.telegramImportJob.update({
    where: { id: job.id },
    data: { status: 'RUNNING', message: 'Resumed via importer service...' },
  });
}

// ── POST /api/v1/admin/importer/resume ───────────────────────────────────────
router.post('/resume', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.body;
    const adminId = req.user?.id || 'admin';

    if (!jobId) {
      res.status(400).json({ success: false, message: 'jobId is required to resume.' });
      return;
    }

    await resumeJob(jobId, adminId);
    res.json({ success: true, message: 'Job resumed successfully.' });
  } catch (error: any) {
    console.error('[importer.resume]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to resume import.' });
  }
});

// (auto-resume is defined above the auth middleware — see top of this file)

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

// (webhook and check-duplicate routes are defined above auth middleware)

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

    // Store Hydrogram session string in BuddyStore DB (per active phone number)
    const phone = await getActivePhone(adminId);
    const key = hydrogramKey(adminId, phone);
    await prisma.setting.upsert({
      where: { key },
      update: { value: data.session_string },
      create: { key, value: data.session_string },
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

    const phone2fa = await getActivePhone(adminId);
    const key2fa = hydrogramKey(adminId, phone2fa);
    await prisma.setting.upsert({
      where: { key: key2fa },
      update: { value: data.session_string },
      create: { key: key2fa, value: data.session_string },
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

export default router;
