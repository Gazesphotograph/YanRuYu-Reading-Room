<script setup lang="ts">
import { ref } from 'vue';

export interface YrTabItem {
  id: string;
  label: string;
  count?: number;
  disabled?: boolean;
}

export interface YrTabsProps {
  modelValue: string;
  items: readonly YrTabItem[];
  ariaLabel?: string;
}

const props = withDefaults(defineProps<YrTabsProps>(), {
  ariaLabel: '视图切换',
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const tabRefs = ref<HTMLButtonElement[]>([]);

function selectTab(item: YrTabItem): void {
  if (item.disabled || item.id === props.modelValue) return;
  emit('update:modelValue', item.id);
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const enabledIndices = props.items
    .map((item, idx) => (item.disabled ? -1 : idx))
    .filter(idx => idx >= 0);
  if (enabledIndices.length === 0) return;

  const currentPos = enabledIndices.indexOf(index);
  let targetIdx: number | null = null;

  if (event.key === 'ArrowRight') {
    targetIdx = enabledIndices[(currentPos + 1) % enabledIndices.length];
  } else if (event.key === 'ArrowLeft') {
    targetIdx = enabledIndices[(currentPos - 1 + enabledIndices.length) % enabledIndices.length];
  } else if (event.key === 'Home') {
    targetIdx = enabledIndices[0];
  } else if (event.key === 'End') {
    targetIdx = enabledIndices[enabledIndices.length - 1];
  }

  if (targetIdx !== null) {
    event.preventDefault();
    const targetItem = props.items[targetIdx];
    if (targetItem) {
      selectTab(targetItem);
      tabRefs.value[targetIdx]?.focus();
    }
  }
}
</script>

<template>
  <div class="yr-tabs" role="tablist" :aria-label="ariaLabel">
    <button
      v-for="(item, index) in items"
      :key="item.id"
      ref="tabRefs"
      type="button"
      role="tab"
      class="yr-tabs__tab"
      :class="{ 'yr-tabs__tab--active': item.id === modelValue }"
      :aria-selected="item.id === modelValue"
      :tabindex="item.id === modelValue ? 0 : -1"
      :disabled="item.disabled"
      @click="selectTab(item)"
      @keydown="onKeydown($event, index)"
    >
      <span>{{ item.label }}</span>
      <span v-if="item.count !== undefined" class="yr-tabs__count">{{ item.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.yr-tabs {
  display: inline-flex;
  align-items: center;
  gap: var(--yr-space-1);
  padding: var(--yr-space-1);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-control);
  background: var(--yr-surface-subtle);
}

.yr-tabs__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--yr-space-2);
  min-height: 30px;
  padding: 0 var(--yr-space-3);
  border: 1px solid transparent;
  border-radius: calc(var(--yr-radius-control) - 2px);
  background: transparent;
  color: var(--yr-text-muted);
  font-family: var(--yr-font-sans);
  font-size: var(--yr-text-sm);
  font-weight: var(--yr-weight-medium);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--yr-duration-fast) var(--yr-ease-standard),
    color var(--yr-duration-fast) var(--yr-ease-standard),
    border-color var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-tabs__tab:hover:not(:disabled):not(.yr-tabs__tab--active) {
  color: var(--yr-text);
  background: var(--yr-surface-hover);
}

.yr-tabs__tab--active {
  background: var(--yr-surface);
  border-color: var(--yr-border);
  color: var(--yr-text);
  box-shadow: var(--yr-shadow-sm);
}

.yr-tabs__tab:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: 1px;
}

.yr-tabs__tab:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.yr-tabs__count {
  padding: 1px 6px;
  border-radius: var(--yr-radius-pill);
  background: var(--yr-surface-subtle);
  color: var(--yr-text-muted);
  font-size: var(--yr-text-xs);
  font-variant-numeric: tabular-nums;
}

.yr-tabs__tab--active .yr-tabs__count {
  background: var(--yr-accent-soft);
  color: var(--yr-text);
}
</style>
