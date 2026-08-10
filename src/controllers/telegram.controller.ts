import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import * as mtprotoService from '../services/mtproto.service';
import prisma from '../lib/prisma';

// ─── Session info cache ───────────────────────────────────────────────────────
// The status endpoint is polled every 1.5 s while an import is running.
// Fetching getMe() and profile photo via MTProto on every tick wastes API calls and causes timeouts.
// Cache it for 10 minutes; it rarely changes.
const sessionInfoCache: Record<string, { data: any; fetchedAt: number }> = {};
const SESSION_INFO_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Request a login verification code from Telegram.
 * POST /api/v1/admin/telegram/send-code
 */
export const sendCodeController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      res.status(400).json({ success: false, message: 'phoneNumber is required.' });
      return;
    }

    const adminId = req.user?.id || 'admin';
    const result = await mtprotoService.sendCode(adminId, phoneNumber);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('[telegram.sendCode]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to send code.' });
  }
};

/**
 * Submit code and optional password to complete authentication.
 * POST /api/v1/admin/telegram/login
 */
export const loginController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { code, password } = req.body;
    if (!code) {
      res.status(400).json({ success: false, message: 'Verification code is required.' });
      return;
    }

    const adminId = req.user?.id || 'admin';
    const result = await mtprotoService.login(adminId, code, password);
    
    // Invalidate cache after successful login
    delete sessionInfoCache[adminId];

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('[telegram.login]', error);
    res.status(500).json({ success: false, message: error.message || 'Login failed.' });
  }
};

/**
 * Parse a Telegram message link like https://t.me/channelname/123 or
 * https://t.me/c/1234567890/123 and return the numeric message ID.
 * Returns undefined if the link is invalid.
 */
function parseTelegramMessageId(link: string | undefined): number | undefined {
  if (!link) return undefined;
  const clean = link.trim();
  // Matches https://t.me/username/123 or https://t.me/c/channel_id/123
  const m = clean.match(/t\.me\/(?:c\/\d+\/|[^/]+\/)(\d+)/);
  if (m) return parseInt(m[1], 10);
  // Plain numeric string fallback
  if (/^\d+$/.test(clean)) return parseInt(clean, 10);
  return undefined;
}

/**
 * Start the background importing process.
 * POST /api/v1/admin/telegram/start-import
 */
export const startImportController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { sourceChat, targetBot, delayMs, limitCount, skipExisting, startLink, endLink } = req.body;
    if (!sourceChat || !targetBot) {
      res.status(400).json({ success: false, message: 'sourceChat and targetBot are required.' });
      return;
    }

    const adminId = req.user?.id || 'admin';
    const delay = delayMs ? parseInt(String(delayMs), 10) : 2000;
    const parsedLimit = limitCount ? parseInt(String(limitCount), 10) : undefined;
    const parsedSkip = skipExisting !== undefined ? Boolean(skipExisting) : true;
    const startMessageId = parseTelegramMessageId(startLink);
    const endMessageId   = parseTelegramMessageId(endLink);
    
    const progress = await mtprotoService.startImport(
      adminId,
      sourceChat,
      targetBot,
      delay,
      undefined,
      parsedLimit,
      parsedSkip,
      startMessageId,
      endMessageId
    );

    res.json({
      success: true,
      data: progress,
    });
  } catch (error: any) {
    console.error('[telegram.startImport]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to start import.' });
  }
};

/**
 * Cancel the active import process.
 * POST /api/v1/admin/telegram/stop-import
 */
export const stopImportController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.id || 'admin';
    mtprotoService.stopImport(adminId);
    res.json({
      success: true,
      message: 'Import stopped.',
    });
  } catch (error: any) {
    console.error('[telegram.stopImport]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to stop import.' });
  }
};

/**
 * Get current Telegram authorization and active import progress.
 * GET /api/v1/admin/telegram/status
 */
export const statusController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.id || 'admin';
    const client = await mtprotoService.getConnectedClient(adminId);
    const authorized = !!client;
    const importStatus = mtprotoService.getStatus(adminId);

    let sessionInfo = null;
    if (client) {
      try {
        const now = Date.now();
        const cached = sessionInfoCache[adminId];
        if (cached && now - cached.fetchedAt < SESSION_INFO_TTL_MS) {
          sessionInfo = cached.data;
        } else {
          const me: any = await client.getMe();
          let profilePhoto = null;
          try {
            const photoBuffer = await client.downloadProfilePhoto('me');
            if (photoBuffer && photoBuffer.length > 0) {
              profilePhoto = `data:image/jpeg;base64,${photoBuffer.toString('base64')}`;
            }
          } catch (photoErr) {
            console.warn('Failed to download profile photo:', photoErr);
          }

          sessionInfo = {
            id: me?.id?.toString() || '',
            name: [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.username || 'Telegram User',
            username: me?.username ? `@${me?.username}` : null,
            phone: me?.phone ? `+${me?.phone}` : null,
            profilePhoto,
          };
          
          sessionInfoCache[adminId] = { data: sessionInfo, fetchedAt: now };
        }
      } catch (meErr) {
        console.error('Failed to retrieve session info:', meErr);
      }
    }

    res.json({
      success: true,
      data: {
        authorized,
        sessionInfo,
        importStatus,
      },
    });
  } catch (error: any) {
    console.error('[telegram.status]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to retrieve status.' });
  }
};

/**
 * Log out and clear current Telegram session.
 * POST /api/v1/admin/telegram/logout
 */
export const logoutController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.id || 'admin';
    await mtprotoService.logoutClient(adminId);
    delete sessionInfoCache[adminId]; // Invalidate cached session on logout
    res.json({
      success: true,
      message: 'Logged out successfully.',
    });
  } catch (error: any) {
    console.error('[telegram.logout]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to log out.' });
  }
};

/**
 * Count how many videos exist in a given source chat.
 * GET /api/v1/admin/telegram/count-videos?chat=@username
 */
export const countVideosController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const chat = req.query.chat as string;
    if (!chat) {
      res.status(400).json({ success: false, message: 'chat query param is required.' });
      return;
    }

    const adminId = req.user?.id || 'admin';
    const count = await mtprotoService.countVideos(adminId, chat);
    res.json({ success: true, data: { count } });
  } catch (error: any) {
    console.error('[telegram.countVideos]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to count videos.' });
  }
};

/**
 * List historical import jobs and logs.
 * GET /api/v1/admin/telegram/jobs
 */
export const listJobsController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const jobs = await prisma.telegramImportJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    
    const formattedJobs = jobs.map((j) => {
      let logsArr = [];
      if (j.logs) {
        try {
          logsArr = typeof j.logs === 'string' ? JSON.parse(j.logs) : j.logs;
        } catch (_) {}
      }
      return { ...j, logs: logsArr };
    });

    res.json({ success: true, data: formattedJobs });
  } catch (error: any) {
    console.error('[telegram.listJobs]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to retrieve jobs.' });
  }
};

/**
 * List all chats/channels for the authenticated session.
 * GET /api/v1/admin/telegram/chats
 */
export const listChatsController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.id || 'admin';
    const chats = await mtprotoService.listChats(adminId);
    res.json({ success: true, data: chats });
  } catch (error: any) {
    console.error('[telegram.listChats]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to retrieve chats.' });
  }
};

/**
 * Resume a stopped or failed import job.
 * POST /api/v1/admin/telegram/resume-import
 */
export const resumeImportController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { jobId, delayMs } = req.body;
    if (!jobId) {
      res.status(400).json({ success: false, message: 'jobId is required to resume.' });
      return;
    }

    const adminId = req.user?.id || 'admin';

    // Find the job in database
    const job = await prisma.telegramImportJob.findUnique({
      where: { id: jobId }
    });

    if (!job) {
      res.status(404).json({ success: false, message: 'Import job not found.' });
      return;
    }

    if (job.status === 'COMPLETED') {
      res.status(400).json({ success: false, message: 'Job is already completed.' });
      return;
    }

    const delay = delayMs ? parseInt(String(delayMs), 10) : 2000;
    const progress = await mtprotoService.startImport(
      adminId,
      job.sourceChat,
      job.targetBot,
      delay,
      jobId,
      job.limitCount || undefined,
      job.skipExisting
    );

    res.json({
      success: true,
      data: progress,
    });
  } catch (error: any) {
    console.error('[telegram.resumeImport]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to resume import.' });
  }
};
/**
 * Get checkpoint info for a source→target pair.
 * GET /api/v1/admin/telegram/checkpoint?sourceChat=X&targetBot=Y
 */
export const checkpointController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sourceChat = req.query.sourceChat as string;
    const targetBot = req.query.targetBot as string;
    if (!sourceChat || !targetBot) {
      res.status(400).json({ success: false, message: 'sourceChat and targetBot query params are required.' });
      return;
    }

    const data = await mtprotoService.getCheckpoint(sourceChat, targetBot);
    res.json({ success: true, data });
  } catch (error: any) {
    console.error('[telegram.checkpoint]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to get checkpoint.' });
  }
};
/**
 * Delete a single import job record.
 * DELETE /api/v1/admin/telegram/jobs/:id
 */
export const deleteJobController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ success: false, message: 'Job id is required.' });
      return;
    }

    await prisma.telegramImportJob.delete({ where: { id } });

    res.json({ success: true, message: 'Job deleted.' });
  } catch (error: any) {
    console.error('[telegram.deleteJob]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete job.' });
  }
};

/**
 * Delete ALL import job records (clear history).
 * DELETE /api/v1/admin/telegram/jobs
 */
export const clearAllJobsController = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { count } = await prisma.telegramImportJob.deleteMany({});
    res.json({ success: true, message: `Cleared ${count} job(s).`, count });
  } catch (error: any) {
    console.error('[telegram.clearAllJobs]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to clear jobs.' });
  }
};
