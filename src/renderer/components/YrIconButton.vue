<script setup lang="ts">
export interface YrIconButtonProps {
  label: string;
  variant?: 'default' | 'subtle' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  pressed?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

const props = withDefaults(defineProps<YrIconButtonProps>(), {
  variant: 'default',
  size: 'md',
  pressed: undefined,
  disabled: false,
  type: 'button',
});

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

function handleClick(event: MouseEvent): void {
  if (props.disabled) return;
  emit('click', event);
}
</script>

<template>
  <button
    :type="type"
    class="yr-icon-btn"
    :class="[`yr-icon-btn--${variant}`, `yr-icon-btn--${size}`, { 'yr-icon-btn--pressed': pressed === true }]"
    :aria-label="label"
    :title="label"
    :aria-pressed="pressed"
    :disabled="disabled"
    @click="handleClick"
  >
    <slot />
  </button>
</template>

<style scoped>
.yr-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--yr-radius-control);
  color: var(--yr-text);
  background: transparent;
  cursor: pointer;
  transition:
    background-color var(--yr-duration-fast) var(--yr-ease-standard),
    border-color var(--yr-duration-fast) var(--yr-ease-standard),
    color var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-icon-btn:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: var(--yr-focus-ring-offset);
}

.yr-icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.yr-icon-btn--sm {
  width: 28px;
  height: 28px;
}

.yr-icon-btn--md {
  width: 34px;
  height: 34px;
}

.yr-icon-btn--lg {
  width: 40px;
  height: 40px;
}

.yr-icon-btn--default {
  background: var(--yr-surface);
  border-color: var(--yr-border);
  color: var(--yr-text);
}

.yr-icon-btn--default:hover:not(:disabled) {
  background: var(--yr-surface-hover);
  border-color: var(--yr-border-strong);
}

.yr-icon-btn--subtle {
  background: var(--yr-surface-subtle);
  border-color: transparent;
  color: var(--yr-text);
}

.yr-icon-btn--subtle:hover:not(:disabled) {
  background: var(--yr-surface-hover);
}

.yr-icon-btn--ghost {
  background: transparent;
  color: var(--yr-text-muted);
}

.yr-icon-btn--ghost:hover:not(:disabled) {
  background: var(--yr-surface-hover);
  color: var(--yr-text);
}

.yr-icon-btn--danger {
  background: var(--yr-surface);
  border-color: var(--yr-border);
  color: var(--yr-danger);
}

.yr-icon-btn--danger:hover:not(:disabled) {
  background: var(--yr-danger-soft);
  border-color: var(--yr-danger);
}

.yr-icon-btn--pressed {
  background: var(--yr-accent-soft);
  border-color: var(--yr-accent);
  color: var(--yr-accent);
}

.yr-icon-btn :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
