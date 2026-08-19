import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
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
  enabled?: boolean;
}

interface AgentDefinition {
  name?: string;
  description?: string;
  modelInvocationDisabled: boolean;
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
          if (child.enabled === false) continue;
          const definition = await readDefinition(child.uri);
          const agentDefinition = child.type === 'agent' ? parseAgentDefinition(definition?.content) : undefined;
          if (agentDefinition?.modelInvocationDisabled) continue;
          const name = text(child.name) ?? agentDefinition?.name;
          if (!name) continue;
          const description = text(child.description) ?? agentDefinition?.description ?? '';
          if (child.type === 'agent') {
            agents.set(name, {
              name,
              description,
              path: definition?.path,
              sizeChars: definition?.content.length
            });
          }
          if (child.type === 'skill') {
            skills.set(name, {
              name,
              description,
              sizeChars: definition?.content.length
            });
          }
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

function parseAgentDefinition(content: string | undefined): AgentDefinition | undefined {
  if (!content) return undefined;
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return undefined;
  const document = parseDocument(frontmatter[1]);
  if (document.errors.length > 0) return undefined;
  const value = document.toJS();
  if (!isRecord(value)) return undefined;
  const disabled = value['disable-model-invocation'] ?? value.disableModelInvocation;
  return {
    name: text(value.name),
    description: text(value.description),
    modelInvocationDisabled: disabled === true || (typeof disabled === 'string' && disabled.trim().toLowerCase() === 'true')
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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