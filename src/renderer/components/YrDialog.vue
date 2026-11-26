<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

export interface YrDialogProps {
  open: boolean;
  title?: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}

const props = withDefaults(defineProps<YrDialogProps>(), {
  title: undefined,
  description: undefined,
  size: 'md',
  closeOnBackdrop: true,
  closeOnEscape: true,
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  close: [];
}>();

const autoId = useId();
const titleId = `yr-dialog-title-${autoId}`;
const descId = `yr-dialog-desc-${autoId}`;
const surfaceRef = ref<HTMLElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

function closeDialog(): void {
  emit('update:open', false);
  emit('close');
}

function onBackdropClick(): void {
  if (props.closeOnBackdrop) closeDialog();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.closeOnEscape) {
    event.preventDefault();
    closeDialog();
  }
}

watch(
  () => props.open,
  async isOpen => {
    if (typeof window === 'undefined') return;
    if (isOpen) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.addEventListener('keydown', onKeydown);
      await nextTick();
      surfaceRef.value?.focus();
    } else {
      window.removeEventListener('keydown', onKeydown);
      previouslyFocused?.focus?.();
      previouslyFocused = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onKeydown);
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="yr-dialog-backdrop" @click.self="onBackdropClick">
      <div
        ref="surfaceRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title || $slots.header ? titleId : undefined"
        :aria-describedby="description ? descId : undefined"
        tabindex="-1"
        class="yr-dialog"
        :class="`yr-dialog--${size}`"
      >
        <header v-if="title || description || $slots.header" class="yr-dialog__header">
          <div class="yr-dialog__heading">
            <slot name="header">
              <h2 v-if="title" :id="titleId" class="yr-dialog__title">{{ title }}</h2>
              <p v-if="description" :id="descId" class="yr-dialog__desc">{{ description }}</p>
            </slot>
          </div>
          <button type="button" class="yr-dialog__close" aria-label="关闭对话框" @click="closeDialog">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>
        <div class="yr-dialog__body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="yr-dialog__footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.yr-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: calc(var(--yr-z-showcase) + var(--yr-z-dialog));
  display: grid;
  place-items: center;
  padding: var(--yr-space-5);
  background: var(--yr-overlay);
}

.yr-dialog {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: calc(100dvh - 40px);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-dialog);
  background: var(--yr-surface-raised);
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  box-shadow: var(--yr-shadow-lg);
  outline: none;
}

.yr-dialog--sm {
  max-width: 420px;
}

.yr-dialog--md {
  max-width: 560px;
}

.yr-dialog--lg {
  max-width: 760px;
}

.yr-dialog__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--yr-space-4);
  padding: var(--yr-space-5) var(--yr-space-5) var(--yr-space-4);
  border-bottom: 1px solid var(--yr-border);
}

.yr-dialog__heading {
  min-width: 0;
}

.yr-dialog__title {
  margin: 0;
  color: var(--yr-text);
  font-size: var(--yr-text-lg);
  font-weight: var(--yr-weight-semibold);
  line-height: var(--yr-leading-tight);
}

.yr-dialog__desc {
  margin: var(--yr-space-1) 0 0;
  color: var(--yr-text-muted);
  font-size: var(--yr-text-sm);
  line-height: var(--yr-leading-normal);
}

.yr-dialog__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  padding: 0;
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-control);
  background: var(--yr-surface);
  color: var(--yr-text-muted);
  cursor: pointer;
  transition:
    background-color var(--yr-duration-fast) var(--yr-ease-standard),
    color var(--yr-duration-fast) var(--yr-ease-standard),
    border-color var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-dialog__close:hover {
  background: var(--yr-surface-hover);
  border-color: var(--yr-border-strong);
  color: var(--yr-text);
}

.yr-dialog__close:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: var(--yr-focus-ring-offset);
}

.yr-dialog__close svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
}

.yr-dialog__body {
  padding: var(--yr-space-5);
  overflow: auto;
  font-size: var(--yr-text-md);
  line-height: var(--yr-leading-normal);
}

.yr-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--yr-space-2);
  padding: var(--yr-space-3) var(--yr-space-5);
  border-top: 1px solid var(--yr-border);
  background: var(--yr-surface-subtle);
  border-radius: 0 0 calc(var(--yr-radius-dialog) - 1px) calc(var(--yr-radius-dialog) - 1px);
}
</style>
