import { AppError } from '@/shared/utils.js';

/**
 * Offset-preserving TOML editing for the Codex `[[skills.config]]` entries.
 *
 * The Codex skills provider must flip one `enabled` boolean while leaving every
 * other byte — comments, indentation, blank lines, quoting style and line
 * endings — exactly as the user wrote it. Serializing the parsed document would
 * discard all of that, so this module scans the raw text and rewrites only the
 * boolean token.
 *
 * The scanner understands the subset of TOML needed for that job: table headers,
 * dotted/quoted keys and value spans. It skips comments and every string form
 * (basic, literal, multiline), so `[[skills.config]]` or `enabled =` text inside
 * a string can never be mistaken for syntax. Layouts it cannot locate safely
 * (an inline `skills.config = [...]` array, for example) raise
 * `CODEX_SKILLS_CONFIG_UNSAFE`; there is deliberately no reserialization
 * fallback.
 */

type TomlAssignment = {
  keyPath: string[];
  valueStart: number;
  valueEnd: number;
};

type TomlTable = {
  isArrayOfTables: boolean;
  keyPath: string[];
  assignments: TomlAssignment[];
};

type LocatedSkillEntry = {
  path?: string;
  enabled?: boolean;
  enabledStart?: number;
  enabledEnd?: number;
};

const SKILLS_CONFIG_KEY_PATH = ['skills', 'config'];

const unsafeConfig = (message: string): AppError => new AppError(message, {
  code: 'CODEX_SKILLS_CONFIG_UNSAFE',
  statusCode: 400,
});

const isBareKeyCharacter = (character: string): boolean => (
  (character >= 'a' && character <= 'z')
  || (character >= 'A' && character <= 'Z')
  || (character >= '0' && character <= '9')
  || character === '_'
  || character === '-'
);

const skipSpaces = (raw: string, start: number): number => {
  let index = start;
  while (index < raw.length && (raw[index] === ' ' || raw[index] === '\t')) {
    index++;
  }
  return index;
};

const skipWhitespace = (raw: string, start: number): number => {
  let index = start;
  while (index < raw.length) {
    const character = raw[index];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      index++;
      continue;
    }
    break;
  }
  return index;
};

const skipComment = (raw: string, start: number): number => {
  let index = start;
  while (index < raw.length && raw[index] !== '\n') {
    index++;
  }
  return index;
};

/** Skips the whitespace that continues a line after a trailing backslash. */
const skipLineContinuation = (raw: string, start: number): number => {
  let index = start;
  while (index < raw.length && (raw[index] === ' ' || raw[index] === '\t' || raw[index] === '\r' || raw[index] === '\n')) {
    index++;
  }
  return index;
};

/** Decodes one backslash escape; unknown escapes keep their literal character. */
const scanEscape = (raw: string, start: number): { value: string; end: number } => {
  const next = raw[start + 1];
  if (next === undefined) {
    throw unsafeConfig('Codex config contains an unterminated string escape.');
  }

  if (next === '\n' || (next === '\r' && raw[start + 2] === '\n')) {
    return { value: '', end: skipLineContinuation(raw, start + 2) };
  }

  const simple: Record<string, string> = {
    b: '\b',
    t: '\t',
    n: '\n',
    f: '\f',
    r: '\r',
    '"': '"',
    '\\': '\\',
  };
  if (Object.hasOwn(simple, next)) {
    return { value: simple[next], end: start + 2 };
  }
  if (next === 'u' || next === 'U') {
    const digits = next === 'u' ? 4 : 8;
    const hex = raw.slice(start + 2, start + 2 + digits);
    if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw unsafeConfig('Codex config contains an invalid unicode escape.');
    }
    return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: start + 2 + digits };
  }

  return { value: next, end: start + 2 };
};

/** Scans a basic (`"` / `"""`) string, returning its decoded value and end offset. */
const scanBasicString = (raw: string, start: number): { value: string; end: number } => {
  const multiline = raw.startsWith('"""', start);
  let index = start + (multiline ? 3 : 1);
  // TOML trims the first newline directly after a multiline delimiter.
  if (multiline && raw[index] === '\n') {
    index++;
  } else if (multiline && raw[index] === '\r' && raw[index + 1] === '\n') {
    index += 2;
  }
  let value = '';

  while (index < raw.length) {
    const character = raw[index];
    if (character === '\\') {
      const escape = scanEscape(raw, index);
      value += escape.value;
      index = escape.end;
      continue;
    }

    if (multiline && raw.startsWith('"""', index)) {
      let runEnd = index;
      while (raw[runEnd] === '"') {
        runEnd++;
      }
      // Up to two quotes immediately before the delimiter are content.
      value += '"'.repeat(Math.max(0, runEnd - index - 3));
      return { value, end: Math.max(runEnd, index + 3) };
    }

    if (!multiline && character === '"') {
      return { value, end: index + 1 };
    }
    if (!multiline && (character === '\n' || character === '\r')) {
      throw unsafeConfig('Codex config contains an unterminated basic string.');
    }

    value += character;
    index++;
  }

  throw unsafeConfig('Codex config contains an unterminated basic string.');
};

/** Scans a literal (`'` / `'''`) string, returning its value and end offset. */
const scanLiteralString = (raw: string, start: number): { value: string; end: number } => {
  const multiline = raw.startsWith("'''", start);
  let index = start + (multiline ? 3 : 1);
  // TOML trims the first newline directly after a multiline delimiter.
  if (multiline && raw[index] === '\n') {
    index++;
  } else if (multiline && raw[index] === '\r' && raw[index + 1] === '\n') {
    index += 2;
  }
  let value = '';

  while (index < raw.length) {
    if (multiline && raw.startsWith("'''", index)) {
      let runEnd = index;
      while (raw[runEnd] === "'") {
        runEnd++;
      }
      value += "'".repeat(Math.max(0, runEnd - index - 3));
      return { value, end: Math.max(runEnd, index + 3) };
    }

    if (!multiline && raw[index] === "'") {
      return { value, end: index + 1 };
    }
    if (!multiline && raw[index] === '\n') {
      throw unsafeConfig('Codex config contains an unterminated literal string.');
    }

    value += raw[index];
    index++;
  }

  throw unsafeConfig('Codex config contains an unterminated literal string.');
};

const scanString = (raw: string, start: number): { value: string; end: number } => (
  raw[start] === '"' ? scanBasicString(raw, start) : scanLiteralString(raw, start)
);

/** Scans an array or inline table, skipping nested strings, comments and brackets. */
const scanCompositeValue = (raw: string, start: number): number => {
  const stack: string[] = [];
  let index = start;

  while (index < raw.length) {
    const character = raw[index];
    if (character === '"' || character === "'") {
      index = scanString(raw, index).end;
      continue;
    }
    if (character === '#') {
      index = skipComment(raw, index);
      continue;
    }
    if (character === '[' || character === '{') {
      stack.push(character);
      index++;
      continue;
    }
    if (character === ']' || character === '}') {
      const expected = character === ']' ? '[' : '{';
      if (stack.at(-1) !== expected) {
        throw unsafeConfig('Codex config contains an unbalanced array or inline table.');
      }
      stack.pop();
      index++;
      if (stack.length === 0) {
        return index;
      }
      continue;
    }
    index++;
  }

  throw unsafeConfig('Codex config contains an unterminated array or inline table.');
};

/** Returns the exclusive end offset of one TOML value starting at `start`. */
const scanValue = (raw: string, start: number): number => {
  const character = raw[start];
  if (character === undefined) {
    throw unsafeConfig('Codex config contains a missing value.');
  }
  if (character === '"' || character === "'") {
    return scanString(raw, start).end;
  }
  if (character === '[' || character === '{') {
    return scanCompositeValue(raw, start);
  }

  let index = start;
  while (index < raw.length && raw[index] !== '\n' && raw[index] !== '#') {
    index++;
  }
  let end = index;
  while (end > start && (raw[end - 1] === ' ' || raw[end - 1] === '\t' || raw[end - 1] === '\r')) {
    end--;
  }
  if (end === start) {
    throw unsafeConfig('Codex config contains an empty value.');
  }
  return end;
};

/** Parses a bare or quoted key path (dotted keys included) and returns its end offset. */
const scanKeyPath = (raw: string, start: number): { keyPath: string[]; end: number } => {
  const keyPath: string[] = [];
  let index = start;

  for (;;) {
    index = skipSpaces(raw, index);
    const character = raw[index];
    if (character === '"' || character === "'") {
      const scanned = scanString(raw, index);
      keyPath.push(scanned.value);
      index = scanned.end;
    } else {
      const keyStart = index;
      while (index < raw.length && isBareKeyCharacter(raw[index])) {
        index++;
      }
      if (index === keyStart) {
        throw unsafeConfig('Codex config contains a key this server cannot read.');
      }
      keyPath.push(raw.slice(keyStart, index));
    }

    index = skipSpaces(raw, index);
    if (raw[index] === '.') {
      index++;
      continue;
    }
    return { keyPath, end: index };
  }
};

/** Parses a `[...]` or `[[...]]` table header at a statement boundary. */
const scanTableHeader = (
  raw: string,
  start: number,
): { isArrayOfTables: boolean; keyPath: string[]; end: number } => {
  const isArrayOfTables = raw.startsWith('[[', start);
  const parsed = scanKeyPath(raw, start + (isArrayOfTables ? 2 : 1));
  let index = parsed.end;
  const closing = isArrayOfTables ? ']]' : ']';
  if (!raw.startsWith(closing, index)) {
    throw unsafeConfig('Codex config contains a malformed table header.');
  }
  index += closing.length;

  return { isArrayOfTables, keyPath: parsed.keyPath, end: index };
};

/** Walks the document and returns every table with its top-level assignments. */
const scanTomlTables = (raw: string): TomlTable[] => {
  const tables: TomlTable[] = [];
  let currentTable: TomlTable | null = null;
  let index = 0;

  while (index < raw.length) {
    index = skipWhitespace(raw, index);
    if (index >= raw.length) {
      break;
    }
    if (raw[index] === '#') {
      index = skipComment(raw, index);
      continue;
    }

    if (raw[index] === '[') {
      const header = scanTableHeader(raw, index);
      currentTable = {
        isArrayOfTables: header.isArrayOfTables,
        keyPath: header.keyPath,
        assignments: [],
      };
      tables.push(currentTable);
      index = header.end;
      continue;
    }

    const parsedKey = scanKeyPath(raw, index);
    let valueStart = skipWhitespace(raw, parsedKey.end);
    if (raw[valueStart] !== '=') {
      throw unsafeConfig('Codex config contains a key/value pair this server cannot read.');
    }
    valueStart = skipWhitespace(raw, valueStart + 1);
    const valueEnd = scanValue(raw, valueStart);
    currentTable?.assignments.push({
      keyPath: parsedKey.keyPath,
      valueStart,
      valueEnd,
    });
    index = valueEnd;
  }

  return tables;
};

const isSkillsConfigKeyPath = (keyPath: string[]): boolean => (
  keyPath.length === SKILLS_CONFIG_KEY_PATH.length
  && keyPath.every((segment, index) => segment === SKILLS_CONFIG_KEY_PATH[index])
);

/** Locates every `[[skills.config]]` entry, including its boolean `enabled` offsets. */
const locateSkillEntries = (raw: string): LocatedSkillEntry[] => (
  scanTomlTables(raw)
    .filter((table) => table.isArrayOfTables && isSkillsConfigKeyPath(table.keyPath))
    .map((table) => {
      const entry: LocatedSkillEntry = {};
      for (const assignment of table.assignments) {
        if (assignment.keyPath.length !== 1) {
          continue;
        }

        const key = assignment.keyPath[0];
        const token = raw.slice(assignment.valueStart, assignment.valueEnd);
        if (key === 'path') {
          if (token[0] !== '"' && token[0] !== "'") {
            throw unsafeConfig('A skills.config path must be a quoted string.');
          }
          entry.path = scanString(raw, assignment.valueStart).value;
          continue;
        }

        if (key === 'enabled') {
          if (token !== 'true' && token !== 'false') {
            throw unsafeConfig('A skills.config enabled value must be a boolean literal.');
          }
          entry.enabled = token === 'true';
          entry.enabledStart = assignment.valueStart;
          entry.enabledEnd = assignment.valueEnd;
        }
      }
      return entry;
    })
);

/** Detects the document's newline style from its first line break. */
const detectNewline = (raw: string): '\n' | '\r\n' => {
  const lineFeed = raw.indexOf('\n');
  return lineFeed > 0 && raw[lineFeed - 1] === '\r' ? '\r\n' : '\n';
};

/**
 * Appends a `[[skills.config]]` entry after the untouched original text.
 *
 * The existing prefix survives byte for byte; only a missing final newline is
 * added so the new table starts on its own line. `path` is encoded as a JSON
 * string, a valid TOML basic string.
 */
const appendSkillEntry = (raw: string, skillPath: string, enabled: boolean): string => {
  const newline = detectNewline(raw);
  const block = [
    '[[skills.config]]',
    `path = ${JSON.stringify(skillPath)}`,
    `enabled = ${enabled ? 'true' : 'false'}`,
    '',
  ].join(newline);

  if (!raw) {
    return block;
  }

  // The existing prefix is never altered: only a missing final newline is added
  // so the appended table starts on its own line.
  const prefix = raw.endsWith('\n') ? raw : `${raw}${newline}`;
  return prefix + block;
};

/**
 * Rewrites the `enabled` booleans of the skill entries selected by
 * `matchesPath`, or appends one entry when none matches.
 *
 * Used by the Codex skills provider (`codex-skills.provider.ts`) when a user
 * toggles a skill. Returns the new text, whether anything changed (callers skip
 * the file write when it did not) and the paths the scanner located, so the
 * caller can verify the scan aligns with the parsed document before writing.
 * Throws `CODEX_SKILLS_CONFIG_UNSAFE` when an entry cannot be located or
 * expressed safely; the original text is never returned in that case.
 */
export async function rewriteCodexSkillEnabled(
  raw: string,
  options: {
    enabled: boolean;
    appendPath: string;
    matchesPath: (candidatePath: string) => Promise<boolean>;
  },
): Promise<{ raw: string; changed: boolean; matchedCount: number; locatedPaths: Array<string | undefined> }> {
  const entries = locateSkillEntries(raw);
  const matched: LocatedSkillEntry[] = [];
  for (const entry of entries) {
    if (entry.path !== undefined && await options.matchesPath(entry.path)) {
      matched.push(entry);
    }
  }

  if (matched.length === 0) {
    return {
      raw: appendSkillEntry(raw, options.appendPath, options.enabled),
      changed: true,
      matchedCount: 0,
      locatedPaths: entries.map((entry) => entry.path),
    };
  }

  const replacements: Array<{ start: number; end: number; enabled: boolean }> = [];
  for (const entry of matched) {
    if (entry.enabledStart === undefined || entry.enabledEnd === undefined) {
      throw unsafeConfig('A matching skills.config entry has no readable enabled value.');
    }
    if (entry.enabled !== options.enabled) {
      replacements.push({
        start: entry.enabledStart,
        end: entry.enabledEnd,
        enabled: options.enabled,
      });
    }
  }

  // Apply from the end so earlier offsets stay valid; only the boolean token
  // bytes are touched.
  let next = raw;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    next = `${next.slice(0, replacement.start)}${replacement.enabled ? 'true' : 'false'}${next.slice(replacement.end)}`;
  }

  return {
    raw: next,
    changed: replacements.length > 0,
    matchedCount: matched.length,
    locatedPaths: entries.map((entry) => entry.path),
  };
}
