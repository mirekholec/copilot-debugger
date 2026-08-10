import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { McpServerInfo } from './SessionSource.js';

const INITIALIZATION_WINDOW_MS = 15_000;

interface SessionMarker {
  timestamp: number;
  lineIndex: number;
}

export class AgentHostProcessLogReader {
  private readonly cache = new Map<string, Promise<McpServerInfo[]>>();

  constructor(private readonly logRoot: string) {}

  readMcpServers(sessionId: string): Promise<McpServerInfo[]> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const promise = this.findMcpServers(sessionId).catch(() => []);
    this.cache.set(sessionId, promise);
    return promise;
  }

  private async findMcpServers(sessionId: string): Promise<McpServerInfo[]> {
    const pattern = path.join(this.logRoot, 'process-*.log').replace(/\\/g, '/');
    const files = await fg(pattern, { onlyFiles: true, suppressErrors: true });
    let selected: { lines: string[]; marker: SessionMarker } | undefined;

    for (const filePath of files) {
      const raw = await fs.readFile(filePath, 'utf8');
      if (!raw.includes(sessionId)) continue;
      const lines = raw.split(/\r?\n/);
      const marker = findEarliestMarker(lines, sessionId);
      if (!marker || (selected && selected.marker.timestamp <= marker.timestamp)) continue;
      selected = { lines, marker };
    }

    if (!selected) return [];
    const servers = new Map<string, McpServerInfo>();
    for (let index = selected.marker.lineIndex + 1; index < selected.lines.length; index += 1) {
      const line = selected.lines[index];
      const timestamp = timestampValue(line);
      if (timestamp !== undefined && timestamp - selected.marker.timestamp > INITIALIZATION_WINDOW_MS) break;
      if (!line.includes('Service initialized as client')) continue;
      const server = parseServer(line);
      if (server) servers.set(server.name, server);
    }
    return [...servers.values()].sort((left, right) => (left.title ?? left.name).localeCompare(right.title ?? right.name));
  }
}

function findEarliestMarker(lines: string[], sessionId: string): SessionMarker | undefined {
  const markers = [`Created session: ${sessionId}`, `Resumed session: ${sessionId}`, `Workspace initialized: ${sessionId}`];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!markers.some((marker) => lines[lineIndex].includes(marker))) continue;
    const timestamp = timestampValue(lines[lineIndex]);
    if (timestamp !== undefined) return { timestamp, lineIndex };
  }
  return undefined;
}

function parseServer(line: string): McpServerInfo | undefined {
  const name = firstMatch(line, /server_info: Implementation \{ name: \\"([^"\\]+)\\"/);
  if (!name) return undefined;
  const title = firstMatch(line, /title: Some\(\\"([^"\\]+)\\"\)/);
  const encodedInstructions = firstMatch(line, /instructions: Some\(\\"((?:\\.|[^"\\])*)\\"\), meta:/);
  const instructions = encodedInstructions
    ?.replace(/\\\\r/g, '\r')
    .replace(/\\\\n/g, '\n')
    ?.replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\') ?? '';
  const documentedTools = [...instructions.matchAll(/^###\s+([A-Za-z][A-Za-z0-9_.:-]*)\s*$/gm)]
    .map((match) => match[1])
    .filter((value) => !['tools', 'examples'].includes(value.toLowerCase()));
  return {
    name,
    title,
    instructionBytes: Buffer.byteLength(instructions, 'utf8'),
    instructions,
    documentedTools: [...new Set(documentedTools)].sort()
  };
}

function firstMatch(value: string, expression: RegExp): string | undefined {
  return value.match(expression)?.[1];
}

function timestampValue(line: string): number | undefined {
  const value = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)/)?.[1];
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}