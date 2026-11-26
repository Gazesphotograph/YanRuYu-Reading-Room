<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';

export interface YrMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  dividerBefore?: boolean;
}

export interface YrMenuProps {
  items: readonly YrMenuItem[];
  label?: string;
  align?: 'start' | 'end';
  disabled?: boolean;
}

const props = withDefaults(defineProps<YrMenuProps>(), {
  label: '更多操作',
  align: 'start',
  disabled: false,
});

const emit = defineEmits<{
  select: [id: string];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const itemRefs = ref<HTMLButtonElement[]>([]);
const menuId = `yr-menu-${useId()}`;

function close(): void {
  open.value = false;
}

async function toggle(): Promise<void> {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    const firstEnabled = itemRefs.value.find(button => !button.disabled);
    firstEnabled?.focus();
  }
}

function selectItem(item: YrMenuItem): void {
  if (item.disabled) return;
  emit('select', item.id);
  close();
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }

  const enabled = itemRefs.value.filter(button => !button.disabled);
  if (enabled.length === 0) return;

  const activeIndex = enabled.findIndex(button => button === document.activeElement);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    enabled[(activeIndex + 1) % enabled.length]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    enabled[(activeIndex - 1 + enabled.length) % enabled.length]?.focus();
  } else if (event.key === 'Home') {
    event.preventDefault();
    enabled[0]?.focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    enabled[enabled.length - 1]?.focus();
  }
}

function onDocumentPointerDown(event: MouseEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && rootRef.value && !rootRef.value.contains(target)) {
    close();
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown);
});
</script>

<template>
  <div ref="rootRef" class="yr-menu">
    <div class="yr-menu__trigger-wrap" @click="toggle">
      <slot name="trigger" :open="open">
        <button
          type="button"
          class="yr-menu__default-trigger"
          :disabled="disabled"
          aria-haspopup="menu"
          :aria-expanded="open"
          :aria-controls="menuId"
        >
          <span>{{ label }}</span>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </slot>
    </div>

    <div
      v-if="open"
      :id="menuId"
      role="menu"
      class="yr-menu__popover"
      :class="`yr-menu__popover--${align}`"
      @keydown="onMenuKeydown"
    >
      <template v-for="item in items" :key="item.id">
        <div v-if="item.dividerBefore" role="separator" class="yr-menu__divider"></div>
        <button
          ref="itemRefs"
          type="button"
          role="menuitem"
          class="yr-menu__item"
          :class="{ 'yr-menu__item--danger': item.danger }"
          :disabled="item.disabled"
          @click="selectItem(item)"
        >
          <span class="yr-menu__item-label">{{ item.label }}</span>
          <span v-if="item.shortcut" class="yr-menu__shortcut">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.yr-menu {
  position: relative;
  display: inline-flex;
}

.yr-menu__trigger-wrap {
  display: inline-flex;
}

.yr-menu__default-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--yr-space-2);
  min-height: 36px;
  padding: 0 var(--yr-space-3);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-control);
  background: var(--yr-surface);
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  font-size: var(--yr-text-md);
  font-weight: var(--yr-weight-medium);
  cursor: pointer;
  transition:
    background-color var(--yr-duration-fast) var(--yr-ease-standard),
    border-color var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-menu__default-trigger:hover:not(:disabled) {
  background: var(--yr-surface-hover);
  border-color: var(--yr-border-strong);
}

.yr-menu__default-trigger:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: var(--yr-focus-ring-offset);
}

.yr-menu__default-trigger svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.yr-menu__popover {
  position: absolute;
  top: calc(100% + var(--yr-space-1));
  z-index: var(--yr-z-popover);
  display: flex;
  flex-direction: column;
  min-width: 196px;
  padding: var(--yr-space-1);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-panel);
  background: var(--yr-surface-raised);
  box-shadow: var(--yr-shadow-md);
}

.yr-menu__popover--start {
  left: 0;
}

.yr-menu__popover--end {
  right: 0;
}

.yr-menu__divider {
  height: 1px;
  margin: var(--yr-space-1) 0;
  background: var(--yr-border);
}

.yr-menu__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yr-space-4);
  width: 100%;
  min-height: 32px;
  padding: 0 var(--yr-space-3);
  border: 0;
  border-radius: calc(var(--yr-radius-control) - 2px);
  background: transparent;
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  font-size: var(--yr-text-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-menu__item:hover:not(:disabled),
.yr-menu__item:focus-visible {
  background: var(--yr-surface-hover);
  outline: none;
}

.yr-menu__item--danger {
  color: var(--yr-danger);
}

.yr-menu__item--danger:hover:not(:disabled),
.yr-menu__item--danger:focus-visible {
  background: var(--yr-danger-soft);
}

.yr-menu__item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.yr-menu__shortcut {
  color: var(--yr-text-muted);
  font-family: var(--yr-font-mono);
  font-size: var(--yr-text-xs);
}
</style>
