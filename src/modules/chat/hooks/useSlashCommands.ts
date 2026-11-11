import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { safeLocalStorage } from '@/modules/chat/utils/chatStorage';
import { useProjectSlashCommands } from '@/shared/hooks/useProjectSlashCommands';
import type { LLMProvider, Project, SlashCommand } from '@/shared/types';
import { isSkillCommand } from '@/shared/utils';

const COMMAND_QUERY_DEBOUNCE_MS = 150;


type UseSlashCommandsOptions = {
  selectedProject: Project | null;
  provider: LLMProvider;
  goalsEnabled?: boolean;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onExecuteCommand: (command: SlashCommand, rawInput?: string) => void | Promise<void>;
};

const getCommandHistoryKey = (projectName: string) => `command_history_${projectName}`;

const readCommandHistory = (projectName: string): Record<string, number> => {
  const history = safeLocalStorage.getItem(getCommandHistoryKey(projectName));
  if (!history) {
    return {};
  }

  try {
    return JSON.parse(history);
  } catch (error) {
    console.error('Error parsing command history:', error);
    return {};
  }
};

const saveCommandHistory = (projectName: string, history: Record<string, number>) => {
  safeLocalStorage.setItem(getCommandHistoryKey(projectName), JSON.stringify(history));
};

const isPromiseLike = (value: unknown): value is Promise<unknown> =>
  Boolean(value) && typeof (value as Promise<unknown>).then === 'function';

/**
 * Local application commands injected by the frontend itself, as opposed to
 * provider/project commands fetched from the server. They open UI instead of
 * running a provider turn, so the completion menu only ever inserts them.
 */
const isApplicationCommand = (command: SlashCommand): boolean =>
  command.type === 'application' || command.metadata?.application === true;

/** Completion inserts these into the input instead of executing them. */
const isInsertOnlyCommand = (command: SlashCommand): boolean =>
  isSkillCommand(command) || Boolean(command.metadata?.nativeControl) || isApplicationCommand(command);

const filterSlashCommands = (
  commands: SlashCommand[],
  query: string,
): SlashCommand[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }

  const commandPrefix = normalizedQuery.startsWith('/')
    ? normalizedQuery
    : `/${normalizedQuery}`;
  const namePrefixMatches = commands.filter((command) =>
    command.name.toLowerCase().startsWith(commandPrefix),
  );

  // Namespaced commands should behave like path completion. Once a provider
  // namespace is typed, only exact command-prefix matches should stay visible.
  if (normalizedQuery.includes(':') || namePrefixMatches.length > 0) {
    return namePrefixMatches;
  }

  const nameSubstringMatches = commands.filter((command) =>
    command.name.toLowerCase().includes(normalizedQuery),
  );
  if (nameSubstringMatches.length > 0) {
    return nameSubstringMatches;
  }

  return commands.filter((command) =>
    command.description?.toLowerCase().includes(normalizedQuery),
  );
};

export function useSlashCommands({
  selectedProject,
  provider,
  goalsEnabled = false,
  input,
  setInput,
  textareaRef,
  onExecuteCommand,
}: UseSlashCommandsOptions) {
  const { t } = useTranslation('chat');
  const { commands: projectCommands } = useProjectSlashCommands(selectedProject, provider);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [slashPosition, setSlashPosition] = useState(-1);

  const commandQueryTimerRef = useRef<number | null>(null);

  const clearCommandQueryTimer = useCallback(() => {
    if (commandQueryTimerRef.current !== null) {
      window.clearTimeout(commandQueryTimerRef.current);
      commandQueryTimerRef.current = null;
    }
  }, []);

  const resetCommandMenuState = useCallback(() => {
    setShowCommandMenu(false);
    setSlashPosition(-1);
    setCommandQuery('');
    setSelectedCommandIndex(-1);
    clearCommandQueryTimer();
  }, [clearCommandQueryTimer]);

  // The shared list ordered by this project's usage history, most-used first,
  // so the menu surfaces what the user actually reaches for.
  const slashCommands = useMemo<SlashCommand[]>(() => {
    if (!selectedProject) {
      return [];
    }

    const parsedHistory = readCommandHistory(selectedProject.projectId);
    const nativeCommands: SlashCommand[] = provider === 'codex' ? [
      { name: '/plan', description: t('codex.planCommand'), type: 'built-in', metadata: { nativeControl: true } },
      ...(goalsEnabled ? [{ name: '/goal', description: t('codex.goalCommand'), type: 'built-in', metadata: { nativeControl: true } }] : []),
    ] : [];
    // `/todo` is a local application command: it is available as soon as a
    // project is selected, without waiting for the provider command API or
    // model list. It wins the dedupe below over a provider command of the same
    // name, because the local command opens the project todo dialog.
    const applicationCommands: SlashCommand[] = [{
      name: '/todo',
      description: t('projectTodo.commandDescription'),
      type: 'application',
      metadata: { application: true, local: true, opensProjectTodoDialog: true },
    }];
    const mergedCommands: SlashCommand[] = [];
    const seenCommandNames = new Set<string>();
    for (const command of [
      ...nativeCommands,
      ...applicationCommands,
      ...projectCommands.filter((command) => !(provider === 'codex' && !goalsEnabled && command.name === '/goal')),
    ]) {
      if (seenCommandNames.has(command.name)) {
        continue;
      }
      seenCommandNames.add(command.name);
      mergedCommands.push(command);
    }
    return mergedCommands.sort((commandA, commandB) => {
      const commandAUsage = parsedHistory[commandA.name] || 0;
      const commandBUsage = parsedHistory[commandB.name] || 0;
      return commandBUsage - commandAUsage;
    });
  }, [projectCommands, selectedProject, provider, goalsEnabled, t]);

  useEffect(() => {
    if (!showCommandMenu) {
      setSelectedCommandIndex(-1);
    }
  }, [showCommandMenu]);

  useEffect(() => {
    setFilteredCommands(filterSlashCommands(slashCommands, commandQuery));
  }, [commandQuery, slashCommands]);

  const frequentCommands = useMemo(() => {
    if (!selectedProject || slashCommands.length === 0) {
      return [];
    }

    const parsedHistory = readCommandHistory(selectedProject.projectId);

    return slashCommands
      .map((command) => ({
        ...command,
        usageCount: parsedHistory[command.name] || 0,
      }))
      .filter((command) => command.usageCount > 0)
      .sort((commandA, commandB) => commandB.usageCount - commandA.usageCount)
      .slice(0, 5);
  }, [selectedProject, slashCommands]);

  const trackCommandUsage = useCallback(
    (command: SlashCommand) => {
      if (!selectedProject) {
        return;
      }

      const parsedHistory = readCommandHistory(selectedProject.projectId);
      parsedHistory[command.name] = (parsedHistory[command.name] || 0) + 1;
      saveCommandHistory(selectedProject.projectId, parsedHistory);
    },
    [selectedProject],
  );

  const insertCommandIntoInput = useCallback(
    (command: SlashCommand) => {
      const currentTextarea = textareaRef.current;
      const insertionStart = slashPosition >= 0
        ? slashPosition
        : currentTextarea?.selectionStart ?? input.length;
      const textBeforeCommand = input.slice(0, insertionStart);
      const textAfterCommandStart = input.slice(insertionStart);
      const spaceIndex = textAfterCommandStart.indexOf(' ');
      const textAfterCommand = slashPosition >= 0 && spaceIndex !== -1
        ? textAfterCommandStart.slice(spaceIndex).trimStart()
        : input.slice(currentTextarea?.selectionEnd ?? insertionStart);
      const separator = textBeforeCommand && !/\s$/.test(textBeforeCommand) ? ' ' : '';
      const newInput = `${textBeforeCommand}${separator}${command.name}${textAfterCommand ? ` ${textAfterCommand}` : ' '}`;

      setInput(newInput);
      resetCommandMenuState();

      window.requestAnimationFrame(() => {
        currentTextarea?.focus();
        const nextCursorPosition = `${textBeforeCommand}${separator}${command.name} `.length;
        currentTextarea?.setSelectionRange(nextCursorPosition, nextCursorPosition);
      });
    },
    [input, resetCommandMenuState, setInput, slashPosition, textareaRef],
  );

  const executeNonSkillCommand = useCallback(
    (command: SlashCommand) => {
      const executionResult = onExecuteCommand(command);
      if (isPromiseLike(executionResult)) {
        executionResult.then(
          () => {
            resetCommandMenuState();
          },
          () => {
            resetCommandMenuState();
            // Keep behavior silent; execution errors are handled by caller.
          },
        );
      } else {
        resetCommandMenuState();
      }
    },
    [onExecuteCommand, resetCommandMenuState],
  );

  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand) => {
      if (isInsertOnlyCommand(command)) {
        insertCommandIntoInput(command);
        return;
      }

      executeNonSkillCommand(command);
    },
    [executeNonSkillCommand, insertCommandIntoInput],
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand | null, index: number, isHover: boolean) => {
      if (!command || !selectedProject) {
        return;
      }

      if (isHover) {
        setSelectedCommandIndex(index);
        return;
      }

      trackCommandUsage(command);
      if (isInsertOnlyCommand(command)) {
        insertCommandIntoInput(command);
        return;
      }

      executeNonSkillCommand(command);
    },
    [selectedProject, trackCommandUsage, insertCommandIntoInput, executeNonSkillCommand],
  );

  const handleToggleCommandMenu = useCallback(() => {
    const isOpening = !showCommandMenu;
    setShowCommandMenu(isOpening);
    setCommandQuery('');
    setSelectedCommandIndex(-1);

    if (isOpening) {
      setFilteredCommands(slashCommands);
    }

    textareaRef.current?.focus();
  }, [showCommandMenu, slashCommands, textareaRef]);

  const handleCommandInputChange = useCallback(
    (newValue: string, cursorPos: number) => {
      if (!newValue.trim()) {
        resetCommandMenuState();
        return;
      }

      const textBeforeCursor = newValue.slice(0, cursorPos);
      const backticksBefore = (textBeforeCursor.match(/```/g) || []).length;
      const inCodeBlock = backticksBefore % 2 === 1;

      if (inCodeBlock) {
        resetCommandMenuState();
        return;
      }

      // Match / at start of input OR after whitespace, capturing the /word up to cursor.
      const slashPattern = /(?:^|\s)(\/\S*)$/;
      const match = textBeforeCursor.match(slashPattern);

      if (!match) {
        resetCommandMenuState();
        return;
      }

      // Compute actual position of / in the full input string.
      const slashPos = match.index! + (match[0].length - match[1].length);
      const query = match[1].slice(1); // strip leading /

      setSlashPosition(slashPos);
      setShowCommandMenu(true);
      setSelectedCommandIndex(-1);

      clearCommandQueryTimer();
      commandQueryTimerRef.current = window.setTimeout(() => {
        setCommandQuery(query);
      }, COMMAND_QUERY_DEBOUNCE_MS);
    },
    [resetCommandMenuState, clearCommandQueryTimer],
  );

  const handleCommandMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showCommandMenu) {
        return false;
      }

      // `filteredCommands` lags the typed text by the query debounce, so a fast
      // Enter could act on the previous query's first row. Resolve the slash
      // word at the caret against the live list instead; only an explicit
      // Arrow selection is read from the rendered menu.
      const typedSlashToken = slashPosition >= 0
        ? input.slice(slashPosition).match(/^\/\S*/)?.[0] ?? ''
        : '';
      const menuCommands = typedSlashToken
        ? filterSlashCommands(slashCommands, typedSlashToken)
        : filteredCommands;

      if (!menuCommands.length) {
        if (event.key === 'Escape') {
          event.preventDefault();
          resetCommandMenuState();
          return true;
        }
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) =>
          previousIndex < menuCommands.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : menuCommands.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        // Until the user arrows through the menu nothing is highlighted, so both
        // keys act on the first live match — what the menu shows once the query
        // debounce catches up.
        const targetCommand = menuCommands[selectedCommandIndex >= 0 ? selectedCommandIndex : 0]
          ?? menuCommands[0];
        if (!targetCommand) {
          event.preventDefault();
          return true;
        }

        // An exact local command (`/todo` on its own, with or without a draft
        // line around it) is a real send, not a completion: let the composer's
        // own Enter handler run it once instead of consuming the key here.
        if (
          event.key === 'Enter'
          && isApplicationCommand(targetCommand)
          && typedSlashToken === targetCommand.name
        ) {
          resetCommandMenuState();
          return false;
        }

        event.preventDefault();
        // Tab is completion, not submission: it only writes "<name> " into the
        // input and closes the menu, so an argument can still be typed before
        // Enter runs the command. Enter keeps executing the highlighted entry.
        if (event.key === 'Tab') {
          insertCommandIntoInput(targetCommand);
        } else {
          selectCommandFromKeyboard(targetCommand);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        resetCommandMenuState();
        return true;
      }

      return false;
    },
    [
      showCommandMenu,
      filteredCommands,
      input,
      insertCommandIntoInput,
      resetCommandMenuState,
      selectCommandFromKeyboard,
      selectedCommandIndex,
      slashCommands,
      slashPosition,
    ],
  );

  useEffect(
    () => () => {
      clearCommandQueryTimer();
    },
    [clearCommandQueryTimer],
  );

  return {
    slashCommands,
    slashCommandsCount: slashCommands.length,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  };
}
