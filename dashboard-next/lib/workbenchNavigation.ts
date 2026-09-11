export type WorkbenchView = 'chat' | 'activity' | 'artifacts' | 'apps' | 'automations' | 'sponsors' | 'brain'

const WORKBENCH_VIEWS = new Set<WorkbenchView>(['chat', 'activity', 'artifacts', 'apps', 'automations', 'sponsors', 'brain'])

export type WorkbenchDestination =
  | { view: WorkbenchView; contextEntryId?: string; settings?: never }
  | { settings: WorkbenchSettingsSection; view?: never }
  | Record<string, never>

export type WorkbenchSettingsSection =
  | 'runtime' | 'model' | 'coding' | 'appearance' | 'skills' | 'capabilities'
  | 'apps' | 'automations' | 'pro' | 'updates' | 'support' | 'about' | 'privacy' | 'legal'

const SETTINGS_SECTIONS = new Set<WorkbenchSettingsSection>([
  'runtime', 'model', 'coding', 'appearance', 'skills', 'capabilities',
  'apps', 'automations', 'pro', 'updates', 'support', 'about', 'privacy', 'legal',
])

export function parseWorkbenchDestination(search: string): WorkbenchDestination {
  const params = new URLSearchParams(search)
  const view = params.get('view')
  if (view && WORKBENCH_VIEWS.has(view as WorkbenchView)) return { view: view as WorkbenchView }
  const settings = params.get('settings')
  if (settings && SETTINGS_SECTIONS.has(settings as WorkbenchSettingsSection)) return { settings: settings as WorkbenchSettingsSection }
  return {}
}

export function applyWorkbenchDestination(url: string, destination: WorkbenchDestination): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
  const next = new URL(url, 'http://aiden.local')
  next.searchParams.delete('view')
  next.searchParams.delete('settings')
  next.searchParams.delete('context')
  if ('settings' in destination && destination.settings) next.searchParams.set('settings', destination.settings)
  if ('view' in destination && destination.view) next.searchParams.set('view', destination.view)
  if (destination.view === 'brain' && destination.contextEntryId) next.searchParams.set('context', destination.contextEntryId)
  return absolute ? next.toString() : `${next.pathname}${next.search}${next.hash}`
}

const RUNTIME_SELECTION_KEYS = ['session', 'job', 'attempt', 'run'] as const

/** Reconcile durable run identity without discarding an explicit product
 * destination. User-initiated chat selection passes preserveDestination=false
 * so Apps/Settings close intentionally; background restore and reload pass true. */
export function applyWorkbenchSelection(
  url: string,
  selectionSearch: string,
  preserveDestination: boolean,
): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
  const next = new URL(url, 'http://aiden.local')
  const destination = preserveDestination ? parseWorkbenchDestination(next.search) : {}
  const previousJob = next.searchParams.get('job')
  for (const key of RUNTIME_SELECTION_KEYS) next.searchParams.delete(key)
  const selection = new URLSearchParams(selectionSearch.startsWith('?') ? selectionSearch.slice(1) : selectionSearch)
  for (const key of RUNTIME_SELECTION_KEYS) {
    const value = selection.get(key)
    if (value !== null) next.searchParams.set(key, value)
  }
  next.searchParams.delete('view')
  next.searchParams.delete('settings')
  if ('settings' in destination && destination.settings) next.searchParams.set('settings', destination.settings)
  if (destination.view !== 'brain' || previousJob !== next.searchParams.get('job')) next.searchParams.delete('context')
  if ('view' in destination && destination.view) next.searchParams.set('view', destination.view)
  return absolute ? next.toString() : `${next.pathname}${next.search}${next.hash}`
}
