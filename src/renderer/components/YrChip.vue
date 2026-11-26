<script setup lang="ts">
export interface YrChipProps {
  variant?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
  selected?: boolean;
  interactive?: boolean;
  removable?: boolean;
  disabled?: boolean;
}

const props = withDefaults(defineProps<YrChipProps>(), {
  variant: 'default',
  size: 'md',
  selected: false,
  interactive: false,
  removable: false,
  disabled: false,
});

const emit = defineEmits<{
  click: [event: MouseEvent];
  remove: [];
}>();

function onClick(event: MouseEvent): void {
  if (!props.interactive || props.disabled) return;
  emit('click', event);
}
</script>

<template>
  <span
    class="yr-chip"
    :class="[
      `yr-chip--${variant}`,
      `yr-chip--${size}`,
      {
        'yr-chip--selected': selected,
        'yr-chip--interactive': interactive,
        'yr-chip--disabled': disabled,
      },
    ]"
  >
    <button
      v-if="interactive"
      type="button"
      class="yr-chip__trigger"
      :aria-pressed="selected"
      :disabled="disabled"
      @click="onClick"
    >
      <slot />
    </button>
    <span v-else class="yr-chip__text">
      <slot />
    </span>
    <button
      v-if="removable"
      type="button"
      class="yr-chip__remove"
      aria-label="移除标签"
      :disabled="disabled"
      @click.stop="emit('remove')"
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    </button>
  </span>
</template>

<style scoped>
.yr-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--yr-space-1);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-pill);
  background: var(--yr-surface);
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  font-weight: var(--yr-weight-medium);
  line-height: 1;
  white-space: nowrap;
  transition:
    background-color var(--yr-duration-fast) var(--yr-ease-standard),
    border-color var(--yr-duration-fast) var(--yr-ease-standard),
    color var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-chip--sm {
  min-height: 24px;
  padding: 0 var(--yr-space-2);
  font-size: var(--yr-text-xs);
}

.yr-chip--md {
  min-height: 28px;
  padding: 0 var(--yr-space-3);
  font-size: var(--yr-text-sm);
}

.yr-chip--accent,
.yr-chip--selected {
  background: var(--yr-accent-soft);
  border-color: var(--yr-accent);
  color: var(--yr-text);
}

.yr-chip--success {
  background: var(--yr-success-soft);
  border-color: var(--yr-success);
  color: var(--yr-success);
}

.yr-chip--warning {
  background: var(--yr-warning-soft);
  border-color: var(--yr-warning);
  color: var(--yr-warning);
}

.yr-chip--danger {
  background: var(--yr-danger-soft);
  border-color: var(--yr-danger);
  color: var(--yr-danger);
}

.yr-chip--interactive:not(.yr-chip--disabled):hover {
  border-color: var(--yr-accent);
  background: var(--yr-surface-hover);
}

.yr-chip--selected.yr-chip--interactive:not(.yr-chip--disabled):hover {
  background: var(--yr-accent-soft);
}

.yr-chip--disabled {
  opacity: 0.48;
}

.yr-chip__trigger {
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

.yr-chip__trigger:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: 3px;
  border-radius: var(--yr-radius-pill);
}

.yr-chip__text {
  display: inline-flex;
  align-items: center;
  gap: var(--yr-space-1);
}

.yr-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: calc(var(--yr-space-1) * -1);
  padding: 0;
  border: 0;
  border-radius: var(--yr-radius-pill);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.yr-chip__remove:hover:not(:disabled) {
  background: var(--yr-surface-hover);
}

.yr-chip__remove:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: 1px;
}

.yr-chip__remove svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
}
</style>
