import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { sessionsDb } from '@/modules/database/index.js';
import type {
  StageLogMcpConfig,
  StageLogRecorded,
} from '@/shared/index.js';

import type { StageLogService } from './stage-log.service.js';

/** One authenticated MCP caller: identity comes from the token, never from tool arguments. */
export type StageLogOwner = {
  sessionId: string;
  provider: 'codex' | 'dsh';
  projectPath: string;
  userId: string | number | null;
};

type StageLogMcpDependencies = {
  logs: StageLogService;
  resolveMcpUrl: () => string;
  /** Gate: the scheduler plugin switch. Recovery/login do not require the plugin process. */
  isEnabled: () => boolean;
};

function readBearer(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '');
  return match ? match[1].trim() : null;
}

/**
 * The host's stage-log MCP transport.
 *
 * A temporary token is issued per adapter runtime instance + application session and is bound to
 * the real session, provider and project. Tool calls derive the resident binding (and therefore
 * task/session/execution ids) from that token; the tool schema accepts no target ids or source.
 * The capability is independent of the Worker plugin and does not require the scheduler plugin
 * process to be up, only its enable switch.
 */
export function createStageLogMcpService(dependencies: StageLogMcpDependencies) {
  const owners = new Map<string, StageLogOwner>();
  const tokenByKey = new Map<string, string>();

  function authorize(authorization: string | undefined): StageLogOwner | null {
    if (!dependencies.isEnabled()) return null;
    const token = readBearer(authorization);
    return token ? owners.get(token) ?? null : null;
  }

  return {
    /** MCP route authentication: token → real session/provider/project. */
    authorize,

    /**
     * Idempotent per `runtimeInstanceId` + session: the same adapter instance keeps its token, so a
     * session adopted later is recognized by the token already injected into it.
     */
    async prepareSession(input: {
      sessionId: string;
      projectPath: string;
      provider: 'codex' | 'dsh';
      userId?: string | number | null;
      runtimeInstanceId?: string;
    }): Promise<StageLogMcpConfig | null> {
      if (!dependencies.isEnabled()) return null;
      const session = sessionsDb.getSessionById(input.sessionId);
      if (!session || session.provider !== input.provider) return null;
      const sessionPath = (session.project_path ?? '').trim();
      const requestedPath = (input.projectPath ?? '').trim();
      if (sessionPath && requestedPath && sessionPath !== requestedPath) return null;

      const key = `${input.runtimeInstanceId ?? ''}:${input.sessionId}`;
      let token = tokenByKey.get(key);
      if (!token) {
        token = randomUUID();
        tokenByKey.set(key, token);
        owners.set(token, {
          sessionId: input.sessionId,
          provider: input.provider,
          projectPath: sessionPath,
          userId: input.userId ?? null,
        });
      }
      return {
        url: dependencies.resolveMcpUrl(),
        headers: { Authorization: `Bearer ${token}` },
      };
    },

    /** Releases every token issued to one adapter runtime instance. */
    closeRuntime(runtimeInstanceId: string): void {
      const prefix = `${runtimeInstanceId}:`;
      for (const [key, token] of tokenByKey) {
        if (!key.startsWith(prefix)) continue;
        tokenByKey.delete(key);
        owners.delete(token);
      }
    },

    record(owner: StageLogOwner, input: {
      content: string;
      status: string;
      occurredAt?: string;
      phase?: string;
      data?: Record<string, unknown>;
    }): StageLogRecorded {
      return dependencies.logs.recordAgent(owner.sessionId, input);
    },
  };
}

export type StageLogMcpService = ReturnType<typeof createStageLogMcpService>;

/** Result envelope used by the MCP tool, matching the host's REST error shape. */
function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }] };
}

/**
 * One stateless MCP server bound to an authenticated owner. Tool identity rules (task/session/
 * execution/source) are server-derived, so the schema is strict and rejects unknown keys.
 */
export function createStageLogMcpServer(
  service: StageLogMcpService,
  owner: StageLogOwner,
): McpServer {
  const server = new McpServer({ name: 'cloudcli-stage-log', version: '0.1.0' });

  server.registerTool(
    'stage_log',
    {
      description: [
        '记录当前常驻任务的关键阶段日志，供插件在最近 7 天内查看；只写日志，不改变任务状态、告警或运行。',
        '默认规则：在阶段开始或完成、得到重要结果、失败并说明原因、跳过并说明原因、等待或准备重试时各记一条；不要为每个工具调用都记录，也不要记录与任务无关的闲聊。',
        '任务、会话、执行实例和来源都由服务端按当前绑定推导，不要传入任何目标 id；status 用自由文本（如 success/failed/skipped/waiting），content 写清楚发生了什么。',
        '响应 recorded=false、reason=not_resident 表示当前会话还没有常驻绑定：本次不要重试，但后续关键阶段仍应调用本工具，以便任务被设为常驻后自动归属。',
        'occurredAt 可省略（默认服务端当前时间），也可传 ISO-8601；data 可选小型 JSON 对象。',
      ].join('\n'),
      inputSchema: {
        content: z.string().refine((value) => value.trim().length > 0, 'content 不能为空'),
        status: z.string().refine((value) => value.trim().length > 0, 'status 不能为空'),
        occurredAt: z.string().optional(),
        phase: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => {
      try {
        return toolResult(service.record(owner, input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}
