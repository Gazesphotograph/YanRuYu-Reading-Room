import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { hasIpc, invoke, onEvent } from '../services/ipc';
import type { TaskKind, TaskRecord, TaskStatus } from '../types/tasks';

export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'queued',
  'running',
  'cancelling',
]);

export const FAILURE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'failed',
  'completed-with-errors',
  'interrupted',
]);

export function isTaskActive(task: Pick<TaskRecord, 'status'>): boolean {
  return ACTIVE_TASK_STATUSES.has(task.status);
}

export function isTaskFailed(task: Pick<TaskRecord, 'status' | 'errorCount'>): boolean {
  return FAILURE_TASK_STATUSES.has(task.status) || task.errorCount > 0;
}

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref<TaskRecord[]>([]);
  const loading = ref(false);
  const pendingIds = ref<Set<string>>(new Set());
  const error = ref<string | null>(null);

  let unsubscribeTasksChanged: (() => void) | null = null;

  const activeTasks = computed(() => tasks.value.filter(isTaskActive));
  const activeCount = computed(() => activeTasks.value.length);
  const hasFailures = computed(() => tasks.value.some(isTaskFailed));

  function applySnapshot(nextTasks: unknown): void {
    tasks.value = Array.isArray(nextTasks) ? (nextTasks as TaskRecord[]) : [];
  }

  function subscribe(): () => void {
    if (!unsubscribeTasksChanged) {
      unsubscribeTasksChanged = onEvent('tasks-changed', payload => {
        applySnapshot(payload?.tasks);
      });
    }
    return () => {
      unsubscribeTasksChanged?.();
      unsubscribeTasksChanged = null;
    };
  }

  async function load(): Promise<TaskRecord[]> {
    error.value = null;
    if (!hasIpc()) return tasks.value;
    subscribe();
    loading.value = true;
    try {
      const list = await invoke('task-list');
      applySnapshot(list);
      return tasks.value;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function start(
    kind: TaskKind,
    options: Record<string, unknown> = {}
  ): Promise<TaskRecord> {
    error.value = null;
    subscribe();
    const created = await invoke('task-start', kind, options);
    await load();
    return created;
  }

  async function runTaskAction(id: string, action: () => Promise<unknown>): Promise<void> {
    const nextPending = new Set(pendingIds.value);
    nextPending.add(id);
    pendingIds.value = nextPending;
    error.value = null;
    try {
      await action();
      await load();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const cleaned = new Set(pendingIds.value);
      cleaned.delete(id);
      pendingIds.value = cleaned;
    }
  }

  async function cancel(id: string): Promise<void> {
    await runTaskAction(id, () => invoke('task-cancel', id));
  }

  async function retry(id: string): Promise<void> {
    await runTaskAction(id, () => invoke('task-retry', id));
  }

  async function dismiss(id: string): Promise<void> {
    await runTaskAction(id, () => invoke('task-dismiss', id));
  }

  return {
    tasks,
    loading,
    pendingIds,
    error,
    activeTasks,
    activeCount,
    hasFailures,
    applySnapshot,
    subscribe,
    load,
    start,
    cancel,
    retry,
    dismiss,
  };
});
