import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  port: number;
  agentHostRoot: string;
  customizationsRoot?: string;
  pollIntervalMs: number;
}

function defaultCustomizationsRoot(): string | undefined {
  const home = os.homedir();
  switch (os.platform()) {
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'agentHostCustomizations');
    case 'linux':
      return path.join(home, '.config', 'Code', 'User', 'agentHostCustomizations');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'agentHostCustomizations');
    default:
      return undefined;
  }
}

export function loadConfig(): ServerConfig {
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  return {
    port,
    agentHostRoot: process.env.COPILOT_DEBUGGER_AGENT_ROOT ?? path.join(os.homedir(), '.copilot'),
    customizationsRoot: process.env.COPILOT_DEBUGGER_CUSTOMIZATIONS_ROOT ?? defaultCustomizationsRoot(),
    pollIntervalMs: Number(process.env.SESSION_POLL_INTERVAL_MS ?? 30_000)
  };
}
