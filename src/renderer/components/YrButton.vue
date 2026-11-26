<script setup lang="ts">
export interface YrButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  loading?: boolean;
  block?: boolean;
}

const props = withDefaults(defineProps<YrButtonProps>(), {
  variant: 'secondary',
  size: 'md',
  type: 'button',
  disabled: false,
  loading: false,
  block: false,
});

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

function handleClick(event: MouseEvent): void {
  if (props.disabled || props.loading) return;
  emit('click', event);
}
</script>

<template>
  <button
    :type="type"
    class="yr-button"
    :class="[`yr-button--${variant}`, `yr-button--${size}`, { 'yr-button--block': block, 'yr-button--loading': loading }]"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
    @click="handleClick"
  >
    <span v-if="loading" class="yr-button__spinner" aria-hidden="true"></span>
    <span v-else-if="$slots.leading" class="yr-button__slot">
      <slot name="leading" />
    </span>
    <span class="yr-button__label">
      <slot />
    </span>
    <span v-if="$slots.trailing" class="yr-button__slot">
      <slot name="trailing" />
    </span>
  </button>
</template>

<style scoped>
.yr-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--yr-space-2);
  border: 1px solid transparent;
  border-radius: var(--yr-radius-control);
  font-family: var(--yr-font-sans);
  font-weight: var(--yr-weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition:
    background-color var(--yr-duration-fast) var(--yr-ease-standard),
    border-color var(--yr-duration-fast) var(--yr-ease-standard),
    color var(--yr-duration-fast) var(--yr-ease-standard),
    box-shadow var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-button:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: var(--yr-focus-ring-offset);
}

.yr-button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.yr-button--block {
  width: 100%;
}

.yr-button--sm {
  min-height: 30px;
  padding: 0 var(--yr-space-3);
  font-size: var(--yr-text-sm);
}

.yr-button--md {
  min-height: 36px;
  padding: 0 var(--yr-space-4);
  font-size: var(--yr-text-md);
}

.yr-button--lg {
  min-height: 42px;
  padding: 0 var(--yr-space-5);
  font-size: var(--yr-text-base);
}

.yr-button--primary {
  background: var(--yr-accent);
  border-color: var(--yr-accent);
  color: var(--yr-accent-ink);
}

.yr-button--primary:hover:not(:disabled) {
  background: var(--yr-accent-hover);
  border-color: var(--yr-accent-hover);
}

.yr-button--secondary {
  background: var(--yr-surface);
  border-color: var(--yr-border);
  color: var(--yr-text);
}

.yr-button--secondary:hover:not(:disabled) {
  background: var(--yr-surface-hover);
  border-color: var(--yr-border-strong);
}

.yr-button--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--yr-text);
}

.yr-button--ghost:hover:not(:disabled) {
  background: var(--yr-surface-hover);
}

.yr-button--danger {
  background: var(--yr-danger);
  border-color: var(--yr-danger);
  color: var(--yr-danger-ink);
}

.yr-button--danger:hover:not(:disabled) {
  background: var(--yr-danger-hover);
  border-color: var(--yr-danger-hover);
}

.yr-button__slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.yr-button__label {
  display: inline-flex;
  align-items: center;
}

.yr-button__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--yr-radius-pill);
  animation: yr-spin 0.7s linear infinite;
}

@keyframes yr-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
