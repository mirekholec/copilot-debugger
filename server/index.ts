#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { CopilotAgentHostSource } from './sources/CopilotAgentHostSource.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDistRoot = path.resolve(currentDir, '..', 'client');
const clientIndexPath = path.join(clientDistRoot, 'index.html');
const pidFilePath = process.env.COPILOT_DEBUGGER_PID_FILE ?? path.resolve(process.cwd(), '.copilot-debugger.pid');

const config = loadConfig();
const app = express();
const source = new CopilotAgentHostSource({
  agentHostRoot: config.agentHostRoot,
  customizationsRoot: config.customizationsRoot,
  pollIntervalMs: config.pollIntervalMs
});

app.disable('x-powered-by');

// Guard against DNS rebinding: only accept requests addressed to loopback hosts.
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
app.use((request, response, next) => {
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(host)) {
    response.status(403).json({ error: 'Forbidden host' });
    return;
  }
  next();
});

app.get('/api/health', (_request, response) => {
  const snapshot = source.listSessions();
  response.json({ ok: true, ready: snapshot.lastRefreshAt !== undefined, lastRefreshAt: snapshot.lastRefreshAt });
});

app.get('/api/sessions', (request, response) => {
  const snapshot = source.listSessions();
  const q = typeof request.query.q === 'string' ? request.query.q.toLowerCase() : undefined;
  const agent = typeof request.query.agent === 'string' ? request.query.agent.toLowerCase() : undefined;

  const sessions = snapshot.sessions.filter((session) => {
    const matchesQuery = q
      ? [session.id, session.workspaceStorageId, session.firstUserMessage, session.producer, session.clientName, session.repository]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(q))
      : true;
    const matchesAgent = agent ? session.agents.some((value) => value.toLowerCase() === agent) : true;
    return matchesQuery && matchesAgent;
  });

  response.json({ ...snapshot, sessions, total: sessions.length });
});

app.get('/api/sessions/:id', (request, response) => {
  const session = source.getSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  response.json(session);
});

app.get('/api/sessions/:id/overview', async (request, response) => {
  const session = source.getSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  const overview = await source.getSessionOverview(request.params.id);
  if (!overview) {
    response.status(404).json({ error: 'No overview data available' });
    return;
  }

  response.json(overview);
});

app.get('/api/sessions/:id/turns', async (request, response) => {
  const session = source.getSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  const turns = await source.getSessionTurns(request.params.id);
  response.json({ turns, total: turns.length });
});

if (fs.existsSync(clientIndexPath)) {
  app.use(express.static(clientDistRoot));
  app.get('*', (_request, response) => {
    response.sendFile(clientIndexPath);
  });
}

const server = app.listen(config.port, '127.0.0.1', () => {
  fs.writeFileSync(pidFilePath, `${process.pid}\n`, 'utf8');
  const url = `http://127.0.0.1:${config.port}`;
  console.log(`Copilot Debugger listening on ${url}`);
  if (process.env.COPILOT_DEBUGGER_OPEN === '1') {
    openBrowser(url);
  }
});

source.start().catch((error) => {
  console.error('Session source failed to start', error);
});

async function shutdown(): Promise<void> {
  await source.stop();
  server.close(() => {
    try {
      if (fs.readFileSync(pidFilePath, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(pidFilePath);
      }
    } catch {
      // The PID file may already have been removed by npm stop.
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => {
    console.warn(`Could not open browser automatically: ${error.message}`);
  });
  child.unref();
}
