<script setup lang="ts">
import { computed } from 'vue';

export interface YrTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  width?: string;
  sortable?: boolean;
}

export type YrTableRow = Record<string, unknown>;

export interface YrDataTableProps {
  columns: readonly YrTableColumn[];
  rows: readonly YrTableRow[];
  rowKey?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  selectable?: boolean;
  selectedKeys?: readonly string[];
  compact?: boolean;
  emptyText?: string;
}

const props = withDefaults(defineProps<YrDataTableProps>(), {
  rowKey: 'id',
  sortKey: undefined,
  sortDir: 'asc',
  selectable: false,
  selectedKeys: () => [],
  compact: false,
  emptyText: '暂无数据',
});

const emit = defineEmits<{
  'update:sortKey': [key: string];
  'update:sortDir': [dir: 'asc' | 'desc'];
  'update:selectedKeys': [keys: string[]];
  rowClick: [row: YrTableRow];
}>();

const selectedSet = computed(() => new Set(props.selectedKeys));
const allKeys = computed(() => props.rows.map((row, idx) => getRowId(row, idx)));
const allSelected = computed(
  () => allKeys.value.length > 0 && allKeys.value.every(key => selectedSet.value.has(key)),
);

function getRowId(row: YrTableRow, index: number): string {
  const raw = row[props.rowKey];
  return raw === undefined || raw === null ? String(index) : String(raw);
}

function toggleSort(column: YrTableColumn): void {
  if (!column.sortable) return;
  if (props.sortKey === column.key) {
    emit('update:sortDir', props.sortDir === 'asc' ? 'desc' : 'asc');
  } else {
    emit('update:sortKey', column.key);
    emit('update:sortDir', 'asc');
  }
}

function toggleAll(): void {
  if (allSelected.value) {
    emit('update:selectedKeys', []);
  } else {
    emit('update:selectedKeys', [...allKeys.value]);
  }
}

function toggleRow(id: string): void {
  const next = new Set(props.selectedKeys);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  emit('update:selectedKeys', [...next]);
}

function ariaSortFor(column: YrTableColumn): 'ascending' | 'descending' | 'none' | undefined {
  if (!column.sortable) return undefined;
  if (props.sortKey !== column.key) return 'none';
  return props.sortDir === 'asc' ? 'ascending' : 'descending';
}
</script>

<template>
  <div class="yr-table-wrap">
    <table class="yr-table" :class="{ 'yr-table--compact': compact }">
      <thead>
        <tr>
          <th v-if="selectable" class="yr-table__check-col" scope="col">
            <input
              type="checkbox"
              class="yr-table__checkbox"
              :checked="allSelected"
              aria-label="全选行"
              @change="toggleAll"
            />
          </th>
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            :style="column.width ? { width: column.width } : undefined"
            :class="`yr-table__align-${column.align ?? 'left'}`"
            :aria-sort="ariaSortFor(column)"
          >
            <button
              v-if="column.sortable"
              type="button"
              class="yr-table__sort-btn"
              @click="toggleSort(column)"
            >
              <span>{{ column.label }}</span>
              <span class="yr-table__sort-indicator" aria-hidden="true">
                {{ sortKey === column.key ? (sortDir === 'asc' ? '▲' : '▼') : '⇅' }}
              </span>
            </button>
            <span v-else>{{ column.label }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="rows.length === 0">
          <td :colspan="columns.length + (selectable ? 1 : 0)" class="yr-table__empty">
            <slot name="empty">{{ emptyText }}</slot>
          </td>
        </tr>
        <tr
          v-for="(row, index) in rows"
          :key="getRowId(row, index)"
          class="yr-table__row"
          :class="{ 'yr-table__row--selected': selectedSet.has(getRowId(row, index)) }"
          @click="emit('rowClick', row)"
        >
          <td v-if="selectable" class="yr-table__check-col" @click.stop>
            <input
              type="checkbox"
              class="yr-table__checkbox"
              :checked="selectedSet.has(getRowId(row, index))"
              :aria-label="`选择第 ${index + 1} 行`"
              @change="toggleRow(getRowId(row, index))"
            />
          </td>
          <td
            v-for="column in columns"
            :key="column.key"
            :class="`yr-table__align-${column.align ?? 'left'}`"
          >
            <slot :name="`cell-${column.key}`" :row="row" :value="row[column.key]">
              {{ row[column.key] ?? '' }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.yr-table-wrap {
  width: 100%;
  overflow-x: auto;
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-panel);
  background: var(--yr-surface);
}

.yr-table {
  width: 100%;
  border-collapse: collapse;
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  font-size: var(--yr-text-sm);
  font-variant-numeric: tabular-nums;
}

.yr-table thead th {
  position: sticky;
  top: 0;
  z-index: var(--yr-z-sticky);
  padding: var(--yr-space-3) var(--yr-space-4);
  border-bottom: 1px solid var(--yr-border);
  background: var(--yr-surface-subtle);
  color: var(--yr-text-muted);
  font-weight: var(--yr-weight-semibold);
  text-align: left;
  white-space: nowrap;
}

.yr-table tbody td {
  padding: var(--yr-space-3) var(--yr-space-4);
  border-bottom: 1px solid var(--yr-border);
  background: var(--yr-surface);
  color: var(--yr-text);
  vertical-align: middle;
}

.yr-table--compact thead th,
.yr-table--compact tbody td {
  padding: var(--yr-space-2) var(--yr-space-3);
}

.yr-table tbody tr:last-child td {
  border-bottom: 0;
}

.yr-table__row {
  cursor: pointer;
}

.yr-table__row:hover td {
  background: var(--yr-surface-hover);
}

.yr-table__row--selected td {
  background: var(--yr-accent-soft);
}

.yr-table__check-col {
  width: 40px;
  text-align: center;
}

.yr-table__checkbox {
  width: 15px;
  height: 15px;
  accent-color: var(--yr-accent);
  cursor: pointer;
}

.yr-table__align-left {
  text-align: left;
}

.yr-table__align-center {
  text-align: center;
}

.yr-table__align-right {
  text-align: right;
}

.yr-table__sort-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--yr-space-1);
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.yr-table__sort-btn:hover {
  color: var(--yr-text);
}

.yr-table__sort-btn:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: 2px;
  border-radius: var(--yr-radius-xs);
}

.yr-table__sort-indicator {
  font-size: 10px;
  opacity: 0.75;
}

.yr-table__empty {
  padding: var(--yr-space-8) var(--yr-space-4);
  color: var(--yr-text-muted);
  text-align: center;
}
</style>
