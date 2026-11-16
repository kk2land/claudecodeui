import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ProjectTodo, ProjectTodosState } from '@/shared/types';

type UseProjectTodosOptions = {
  projectId: string;
  /** Keep the list current while the project's chat is active, including with the dialog closed. */
  enabled: boolean;
};

/**
 * Loads one project's todos and refreshes them from `todos_changed` websocket
 * frames; used by chat's ChatInterface for both the count and ProjectTodoDialog.
 *
 * The server list is the single source of truth for all three tabs: every
 * mutation reloads it rather than patching local rows, so a pending row that
 * the server moved to another state can never linger in the wrong tab.
 */
export function useProjectTodos({ projectId, enabled }: UseProjectTodosOptions): ProjectTodosState {
  // The fetched list backing all three tabs; kept in state because it arrives
  // asynchronously when a project's chat becomes active.
  const [todos, setTodos] = useState<ProjectTodo[]>([]);
  // Distinguishes the initial load (spinner) from a silent background refresh.
  const [isLoading, setIsLoading] = useState(false);
  // Set when the list request failed, so the dialog can offer a retry rather
  // than misleading the user with an empty state.
  const [hasError, setHasError] = useState(false);
  // Monotonic request id: only the newest request may write state, so a slow
  // response cannot overwrite a newer list, and disabling the hook cannot be
  // undone by an in-flight response.
  const requestIdRef = useRef(0);
  const { subscribe } = useWebSocket();

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setHasError(false);

    try {
      const data = await readApiJson<{ todos: ProjectTodo[] }>(await api.todos.list(projectId));
      if (requestId !== requestIdRef.current) {
        return;
      }
      setTodos(Array.isArray(data.todos) ? data.todos : []);
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      console.error('Failed to load project todos:', error);
      setHasError(true);
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (!enabled) {
      // Invalidate any in-flight request and clear the list, so enabling on
      // another project never flashes the previous project's todos.
      requestIdRef.current += 1;
      setTodos([]);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    setTodos([]);
    void reload();
  }, [enabled, projectId, reload]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    return subscribe((event) => {
      // Every `todos_changed` frame names its project; only this chat's
      // project reloads.
      if (event.kind !== 'todos_changed' || event.projectId !== projectId) {
        return;
      }
      void reload();
    });
  }, [enabled, projectId, reload, subscribe]);

  const removeTodo = useCallback(async (todoId: string) => {
    await readApiJson<{ success: true }>(await api.todos.remove(projectId, todoId));
    await reload();
  }, [projectId, reload]);

  const restoreTodo = useCallback(async (todoId: string) => {
    await readApiJson<{ todo: ProjectTodo }>(await api.todos.restore(projectId, todoId));
    await reload();
  }, [projectId, reload]);

  return { todos, isLoading, hasError, reload, removeTodo, restoreTodo };
}
