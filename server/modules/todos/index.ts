import { todosService } from './todos.service.js';

// Todos router mounted at /api/projects by server/index.ts.
export { default as todosRoutes } from './todos.routes.js';
// todoRetentionService: started/closed by server/index.ts to purge expired submitted/deleted todos hourly.
export { todoRetentionService } from './todos.service.js';
// setTodosBroadcastSink: wired once by server/index.ts to publish todos_changed without a feature cycle.
export { setTodosBroadcastSink } from './todos.service.js';
// deleteProjectTodos: used by project hard deletion before the project row is removed.
export const deleteProjectTodos = todosService.deleteProjectTodos;
// markTodosSubmitted: used by chat acceptance adapters once a real provider receives a todo-sourced turn.
export const markTodosSubmitted = todosService.markSubmitted;
