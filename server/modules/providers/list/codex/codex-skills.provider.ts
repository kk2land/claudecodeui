import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { rewriteCodexSkillEnabled } from '@/modules/providers/list/codex/codex-skills-config-editor.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type {
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillSetEnabledInput,
  ProviderSkillSetEnabledResult,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  AppError,
  findTopmostGitRoot,
  readObjectRecord,
  readProviderSkillMarkdownDefinition,
} from '@/shared/utils.js';

/**
 * Codex home directory: an explicit `CODEX_HOME` wins, otherwise `~/.codex`.
 * Read on every call so tests and embedding hosts can point Codex at an
 * isolated directory without restarting the server.
 */
const resolveCodexHome = (): string => (
  path.resolve(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'))
);

const resolveCodexConfigPath = (): string => path.join(resolveCodexHome(), 'config.toml');

type ParsedCodexConfig = {
  /** Verbatim file contents; the toggle edits these bytes instead of reserializing. */
  raw: string;
  config: Record<string, unknown>;
};

/** Serializes read-modify-write cycles so concurrent toggles cannot drop entries. */
let codexConfigWriteQueue: Promise<unknown> = Promise.resolve();

const invalidCodexConfig = (message: string): AppError => new AppError(message, {
  code: 'CODEX_SKILLS_CONFIG_INVALID',
  statusCode: 400,
});

/** Raised when a raw edit cannot be proven safe; the original file is kept. */
const safeRewriteFailure = (): AppError => new AppError(
  'Codex skills.config cannot be edited safely; config.toml was left unchanged.',
  {
    code: 'CODEX_SKILLS_CONFIG_UNSAFE',
    statusCode: 400,
  },
);

/**
 * Parses an edited document with the same reader used for the original, mapping
 * any syntax or shape failure to a safe-edit error so the caller never writes
 * text the TOML parser would reject.
 */
const parseRewrittenCodexConfig = async (
  raw: string,
  configPath: string,
): Promise<Array<Record<string, unknown>>> => {
  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(raw) as Record<string, unknown>;
  } catch {
    throw safeRewriteFailure();
  }

  try {
    return readSkillConfigEntries(parsed, configPath);
  } catch {
    throw safeRewriteFailure();
  }
};

/** Reads `config.toml`, returning empty config for a missing file and failing on malformed TOML. */
const readCodexConfig = async (configPath: string): Promise<ParsedCodexConfig> => {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: '', config: {} };
    }
    throw error;
  }

  try {
    return { raw, config: TOML.parse(raw) as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidCodexConfig(`Codex config ${configPath} is not valid TOML: ${message}`);
  }
};

/**
 * Reads the `[[skills.config]]` array from a parsed config.
 *
 * Path-selected entries must carry a boolean `enabled`, matching Codex's own
 * schema: rewriting a file Codex would reject must fail instead of silently
 * replacing it.
 */
const readSkillConfigEntries = (
  config: Record<string, unknown>,
  configPath: string,
): Array<Record<string, unknown>> => {
  const skills = config.skills;
  if (skills === undefined) {
    return [];
  }

  const skillsRecord = readObjectRecord(skills);
  if (!skillsRecord) {
    throw invalidCodexConfig(`Codex config ${configPath} has an invalid "skills" table.`);
  }

  const entries = skillsRecord.config;
  if (entries === undefined) {
    return [];
  }
  if (!Array.isArray(entries)) {
    throw invalidCodexConfig(`Codex config ${configPath} has an invalid "skills.config" list.`);
  }

  return entries.map((entry, index) => {
    const record = readObjectRecord(entry);
    if (!record) {
      throw invalidCodexConfig(`Codex config ${configPath} skill entry ${index + 1} is not a table.`);
    }

    if (record.path !== undefined) {
      if (typeof record.path !== 'string' || !record.path.trim()) {
        throw invalidCodexConfig(`Codex config ${configPath} skill entry ${index + 1} has an invalid path.`);
      }
      if (typeof record.enabled !== 'boolean') {
        throw invalidCodexConfig(`Codex config ${configPath} skill entry ${index + 1} requires a boolean enabled value.`);
      }
    }

    return record;
  });
};

/** Case-normalizes path keys on Windows, where filesystem lookups ignore case. */
const normalizePathKey = (value: string): string => (
  process.platform === 'win32' ? value.toLowerCase() : value
);

/**
 * Builds every key a stored path may match under.
 *
 * Codex resolves symlinks before comparing, so a config entry may use either
 * the symlinked path or its target. Both forms are accepted here, which keeps
 * the read and write paths consistent for symlinked skill folders.
 */
const buildPathMatchKeys = async (value: string): Promise<Set<string>> => {
  const resolvedPath = path.resolve(value);
  const keys = new Set<string>([normalizePathKey(resolvedPath)]);

  try {
    keys.add(normalizePathKey(await realpath(resolvedPath)));
  } catch {
    // A missing path simply has no resolved alias; the lexical path still matches.
  }

  return keys;
};

const pathsOverlap = (left: Set<string>, right: Set<string>): boolean => (
  [...left].some((key) => right.has(key))
);

/**
 * Permission bits to carry onto a rewritten config.
 *
 * Codex stores credentials beside this file and users commonly keep it at
 * 0600. A missing config starts at 0600 so the app never widens permissions
 * that the user never set.
 */
const readConfigMode = async (configPath: string): Promise<number> => {
  try {
    return (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0o600;
    }
    throw error;
  }
};

/**
 * Resolves the file that must actually be replaced.
 *
 * `config.toml` is frequently a symlink into a dotfiles repository. Replacing
 * the link path with `rename` would silently detach the user's link and leave
 * the real file stale, so the link target is resolved first and written
 * instead. A dangling link is refused: the correct target is unknowable and
 * writing through it would create a file at an unexpected location.
 */
const resolveConfigWriteTarget = async (configPath: string): Promise<string> => {
  let linkStats;
  try {
    linkStats = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return configPath;
    }
    throw error;
  }

  if (!linkStats.isSymbolicLink()) {
    return configPath;
  }

  try {
    return await realpath(configPath);
  } catch {
    throw safeRewriteFailure();
  }
};

/** Atomically replaces the config file so an interrupted write cannot truncate it. */
const writeCodexConfig = async (configPath: string, raw: string): Promise<void> => {
  const writeTarget = await resolveConfigWriteTarget(configPath);
  await mkdir(path.dirname(writeTarget), { recursive: true });
  const mode = await readConfigMode(writeTarget);
  // The temp file lives beside the resolved target so `rename` stays on one
  // filesystem and the original symlink keeps pointing at the rewritten file.
  const temporaryPath = `${writeTarget}.${process.pid}.${Date.now()}.tmp`;
  try {
    // `mode` on writeFile only applies at creation; chmod makes the final
    // permissions explicit even if the temp path somehow already existed.
    await writeFile(temporaryPath, raw, { encoding: 'utf8', mode });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, writeTarget);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

/**
 * Runs one config mutation while holding the module-level write lock.
 *
 * The lock covers the whole read-modify-write cycle, which is what prevents a
 * concurrent toggle from resurrecting a removed entry or dropping a new one.
 */
const withCodexConfigWriteLock = <T>(task: () => Promise<T>): Promise<T> => {
  const result = codexConfigWriteQueue.then(task, task);
  codexConfigWriteQueue = result.then(() => undefined, () => undefined);
  return result;
};

/** Validates that the caller named a real, readable `SKILL.md` file. */
const assertValidSkillFilePath = async (sourcePath: string): Promise<string> => {
  if (!sourcePath.trim()) {
    throw new AppError('sourcePath is required.', {
      code: 'PROVIDER_SKILL_SOURCE_REQUIRED',
      statusCode: 400,
    });
  }

  const resolvedPath = path.resolve(sourcePath);
  if (!path.isAbsolute(sourcePath) || path.basename(resolvedPath).toLowerCase() !== 'skill.md') {
    throw new AppError('sourcePath must be an absolute path to a SKILL.md file.', {
      code: 'PROVIDER_SKILL_SOURCE_INVALID',
      statusCode: 400,
    });
  }

  const stats = await stat(resolvedPath).catch(() => null);
  if (!stats?.isFile()) {
    throw new AppError(`Skill file ${resolvedPath} does not exist.`, {
      code: 'PROVIDER_SKILL_SOURCE_INVALID',
      statusCode: 400,
    });
  }

  // Reading the front matter proves the file is a readable skill definition and
  // not just any file renamed to SKILL.md.
  await readProviderSkillMarkdownDefinition(resolvedPath).catch(() => {
    throw new AppError(`Skill file ${resolvedPath} is not a readable skill definition.`, {
      code: 'PROVIDER_SKILL_SOURCE_INVALID',
      statusCode: 400,
    });
  });

  return resolvedPath;
};

/** Codex skill adapter: discovery plus per-skill enablement in `config.toml`. */
export class CodexSkillsProvider extends SkillsProvider {
  constructor() {
    super('codex');
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const skills = await super.listSkills(options);
    const configPath = resolveCodexConfigPath();
    const { config } = await readCodexConfig(configPath);
    const entries = readSkillConfigEntries(config, configPath);

    // Resolve every entry once; skill lists are small and this keeps the
    // per-skill loop from repeating filesystem work.
    const entriesWithKeys = await Promise.all(entries
      .filter((entry) => typeof entry.path === 'string')
      .map(async (entry) => ({
        enabled: entry.enabled as boolean,
        keys: await buildPathMatchKeys(entry.path as string),
      })));

    return Promise.all(skills.map(async (skill) => {
      const skillKeys = await buildPathMatchKeys(skill.sourcePath);
      // Codex applies later entries over earlier ones, so the last match wins.
      const matched = entriesWithKeys.filter((entry) => pathsOverlap(entry.keys, skillKeys)).at(-1);
      return { ...skill, enabled: matched?.enabled ?? true };
    }));
  }

  async setSkillEnabled(input: ProviderSkillSetEnabledInput): Promise<ProviderSkillSetEnabledResult> {
    if (typeof input.enabled !== 'boolean') {
      throw new AppError('enabled must be a boolean.', {
        code: 'PROVIDER_SKILL_ENABLED_INVALID',
        statusCode: 400,
      });
    }

    const sourcePath = await assertValidSkillFilePath(input.sourcePath);

    return withCodexConfigWriteLock(async () => {
      const configPath = resolveCodexConfigPath();
      const { raw, config } = await readCodexConfig(configPath);
      // Validates the parsed shape (and rejects entries Codex itself would
      // refuse) before any byte is touched.
      const parsedEntries = readSkillConfigEntries(config, configPath);
      const targetKeys = await buildPathMatchKeys(sourcePath);

      const rewritten = await rewriteCodexSkillEnabled(raw, {
        enabled: input.enabled,
        appendPath: sourcePath,
        matchesPath: async (candidatePath) => (
          pathsOverlap(await buildPathMatchKeys(candidatePath), targetKeys)
        ),
      });

      // Every entry the scanner located must correspond to a parsed entry, in
      // order; otherwise the raw edit is not describing the document we read.
      const locatedPaths = rewritten.locatedPaths.filter(
        (locatedPath): locatedPath is string => locatedPath !== undefined,
      );
      const parsedPaths = parsedEntries
        .map((entry) => entry.path)
        .filter((entryPath): entryPath is string => typeof entryPath === 'string');
      if (
        locatedPaths.length !== parsedPaths.length
        || locatedPaths.some((locatedPath, index) => locatedPath !== parsedPaths[index])
      ) {
        throw new AppError('Codex skills.config entries cannot be located safely in config.toml.', {
          code: 'CODEX_SKILLS_CONFIG_UNSAFE',
          statusCode: 400,
        });
      }

      if (rewritten.changed) {
        // Verify the edited document before touching the file. Appending a
        // `[[skills.config]]` after an inline `skills = {}` (or a closed
        // `config = []`) parses as valid input but produces text the TOML
        // parser rejects as "can't extend an inline table/array", so a bad
        // rewrite must fail here rather than corrupt the user's config.
        const rewrittenEntries = await parseRewrittenCodexConfig(rewritten.raw, configPath);
        let targetEntryCount = 0;
        for (const entry of rewrittenEntries) {
          if (typeof entry.path !== 'string') {
            continue;
          }
          if (!pathsOverlap(await buildPathMatchKeys(entry.path), targetKeys)) {
            continue;
          }
          targetEntryCount++;
          if (entry.enabled !== input.enabled) {
            throw safeRewriteFailure();
          }
        }
        if (targetEntryCount === 0) {
          throw safeRewriteFailure();
        }

        await writeCodexConfig(configPath, rewritten.raw);
      }

      return { provider: 'codex', sourcePath, enabled: input.enabled };
    });
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);
    const codexHome = resolveCodexHome();

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.agents', 'skills'),
      commandPrefix: '$',
    });

    if (repoRoot) {
      // Codex checks repository skills at the launch folder, one folder above it,
      // and the topmost git root; these can collapse to the same directory.
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(path.dirname(workspacePath), '.agents', 'skills'),
        commandPrefix: '$',
      });
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.agents', 'skills'),
        commandPrefix: '$',
      });
    }

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(codexHome, 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'admin',
      rootDir: path.join('/etc', 'codex', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'system',
      rootDir: path.join(codexHome, 'skills', '.system'),
      commandPrefix: '$',
    });

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    };
  }
}
