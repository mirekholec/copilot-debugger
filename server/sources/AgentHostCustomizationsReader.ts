import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentInfo, SkillInfo } from './SessionSource.js';

interface CustomizationContainer {
  enabled?: boolean;
  children?: CustomizationItem[];
}

interface CustomizationItem {
  type?: string;
  name?: string;
  description?: string;
  uri?: string;
}

export interface AgentHostInstruction {
  name: string;
  path: string;
  content: string;
}

export interface AgentHostCustomizations {
  agents: AgentInfo[];
  skills: SkillInfo[];
  instructions: AgentHostInstruction[];
  sourcePath?: string;
}

export class AgentHostCustomizationsReader {
  constructor(private readonly root: string | undefined) {}

  async read(sessionId: string): Promise<AgentHostCustomizations> {
    if (!this.root) return { agents: [], skills: [], instructions: [] };
    const sourcePath = path.join(this.root, `${sessionId}.json`);
    try {
      const parsed = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return { agents: [], skills: [], instructions: [] };
      const agents = new Map<string, AgentInfo>();
      const skills = new Map<string, SkillInfo>();
      const instructions: AgentHostInstruction[] = [];
      for (const value of parsed) {
        if (!isContainer(value) || value.enabled === false) continue;
        for (const child of value.children ?? []) {
          const name = text(child.name);
          if (!name) continue;
          const definition = await readDefinition(child.uri);
          const item = {
            name,
            description: text(child.description) ?? '',
            sizeChars: definition?.content.length
          };
          if (child.type === 'agent') agents.set(name, item);
          if (child.type === 'skill') skills.set(name, item);
          if (child.type === 'rule' && definition) instructions.push({ name, ...definition });
        }
      }
      return {
        agents: [...agents.values()].sort(byName),
        skills: [...skills.values()].sort(byName),
        instructions,
        sourcePath
      };
    } catch {
      return { agents: [], skills: [], instructions: [] };
    }
  }
}

function isContainer(value: unknown): value is CustomizationContainer {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function readDefinition(uri: string | undefined): Promise<{ path: string; content: string } | undefined> {
  if (!uri?.startsWith('file://')) return undefined;
  try {
    const filePath = fileURLToPath(uri);
    return { path: filePath, content: await fs.readFile(filePath, 'utf8') };
  } catch {
    return undefined;
  }
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}