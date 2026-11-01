/**
 * Plugins allowed on a non-super instance. Worker is always available; the
 * scheduler is checked separately because its own switch applies to every role.
 */
const NORMAL_ROLE_PLUGINS = new Set(['worker']);

/**
 * Used by the plugin service to decide whether management routes are available.
 * Only an exact `CLOUDCLI_ROLE=super` grants management; unset, empty, unknown
 * and differently-cased values keep the normal role.
 */
export function isSuperPluginRole(): boolean {
  return process.env.CLOUDCLI_ROLE === 'super';
}

/**
 * Used by the plugin registry and process adapter to scope plugins to the
 * instance role. The scheduler must be switched on explicitly, even for the
 * super role, so an installed copy of it cannot bypass the switch. The super
 * role keeps the rest of the full catalog; the normal role only admits Worker.
 */
export function isPluginAllowedForRole(pluginName: string): boolean {
  if (pluginName === 'project-scheduler') {
    return process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER === 'true';
  }
  return isSuperPluginRole() || NORMAL_ROLE_PLUGINS.has(pluginName);
}
