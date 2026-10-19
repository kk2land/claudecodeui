import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { readObjectRecord, readStringArray, readStringRecord, AppError } from '@/shared/utils.js';

/** Manages CloudCLI-owned DSH MCP declarations, leaving native profile files untouched. */
export class DshMcpProvider extends McpProvider {
  constructor(private readonly configuration: DshConfigurationProvider) { super('dsh', ['user', 'project'], ['stdio', 'http']); }

  private file(scope: McpScope, workspace: string): string {
    return path.join(scope === 'user' ? this.configuration.read().home : path.join(workspace, '.dsh'), 'cloudcli-mcp.json');
  }

  protected async readScopedServers(scope: McpScope, workspace: string): Promise<Record<string, unknown>> {
    try { return Object.assign(Object.create(null), readObjectRecord(JSON.parse(await readFile(this.file(scope, workspace), 'utf8'))) ?? {}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null); throw error; }
  }

  protected async writeScopedServers(scope: McpScope, workspace: string, servers: Record<string, unknown>): Promise<void> {
    const file = this.file(scope, workspace), temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(servers, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(input.name.trim())) throw new AppError('DSH MCP names must contain 1-32 letters, digits, underscores, or hyphens.', { code: 'MCP_NAME_INVALID', statusCode: 400 });
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new AppError('An MCP command is required.', { code: 'MCP_COMMAND_REQUIRED', statusCode: 400 });
      return { command: input.command, args: input.args ?? [], env: input.env ?? {} };
    }
    if (!input.url || !/^https?:\/\//.test(input.url)) throw new AppError('An HTTP(S) MCP URL is required.', { code: 'MCP_URL_REQUIRED', statusCode: 400 });
    return { url: input.url, headers: input.headers ?? {} };
  }

  protected normalizeServerConfig(scope: McpScope, name: string, raw: unknown): ProviderMcpServer | null {
    const config = readObjectRecord(raw);
    if (typeof config?.command === 'string') return { provider: 'dsh', scope, name, transport: 'stdio', command: config.command, args: readStringArray(config.args), env: readStringRecord(config.env) };
    if (typeof config?.url === 'string') return { provider: 'dsh', scope, name, transport: 'http', url: config.url, headers: readStringRecord(config.headers) };
    return null;
  }
}
