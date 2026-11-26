<script setup lang="ts">
import { computed, useId } from 'vue';

export interface YrSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface YrSelectProps {
  modelValue: string;
  options: readonly YrSelectOption[];
  label?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  id?: string;
}

const props = withDefaults(defineProps<YrSelectProps>(), {
  label: undefined,
  placeholder: undefined,
  hint: undefined,
  error: undefined,
  size: 'md',
  disabled: false,
  id: undefined,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const autoId = useId();
const selectId = computed(() => props.id ?? `yr-select-${autoId}`);
const describedBy = computed(() => {
  if (props.error) return `${selectId.value}-error`;
  if (props.hint) return `${selectId.value}-hint`;
  return undefined;
});

function onChange(event: Event): void {
  const target = event.target as HTMLSelectElement | null;
  emit('update:modelValue', target?.value ?? '');
}
</script>

<template>
  <div class="yr-field" :class="{ 'yr-field--disabled': disabled }">
    <label v-if="label" :for="selectId" class="yr-field__label">
      {{ label }}
    </label>
    <div class="yr-select" :class="[`yr-select--${size}`, { 'yr-select--invalid': Boolean(error) }]">
      <select
        :id="selectId"
        class="yr-select__control"
        :value="modelValue"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        @change="onChange"
      >
        <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
        <option
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          :disabled="option.disabled"
        >
          {{ option.label }}
        </option>
      </select>
      <span class="yr-select__chevron" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
    </div>
    <p v-if="error" :id="`${selectId}-error`" class="yr-field__message yr-field__message--error" role="alert">
      {{ error }}
    </p>
    <p v-else-if="hint" :id="`${selectId}-hint`" class="yr-field__message">
      {{ hint }}
    </p>
  </div>
</template>

<style scoped>
.yr-field {
  display: flex;
  flex-direction: column;
  gap: var(--yr-space-1);
  min-width: 0;
}

.yr-field__label {
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  font-size: var(--yr-text-sm);
  font-weight: var(--yr-weight-medium);
  line-height: var(--yr-leading-tight);
}

.yr-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 100%;
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-control);
  background: var(--yr-surface);
  color: var(--yr-text);
  transition:
    border-color var(--yr-duration-fast) var(--yr-ease-standard),
    box-shadow var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-select--sm {
  min-height: 30px;
  font-size: var(--yr-text-sm);
}

.yr-select--md {
  min-height: 36px;
  font-size: var(--yr-text-md);
}

.yr-select:hover:not(.yr-select--invalid) {
  border-color: var(--yr-border-strong);
}

.yr-select:focus-within {
  border-color: var(--yr-focus-ring);
  box-shadow: 0 0 0 2px var(--yr-accent-soft);
}

.yr-select--invalid {
  border-color: var(--yr-danger);
}

.yr-field--disabled .yr-select {
  background: var(--yr-surface-subtle);
  opacity: 0.6;
}

.yr-select__control {
  appearance: none;
  width: 100%;
  min-height: inherit;
  padding: 0 var(--yr-space-8) 0 var(--yr-space-3);
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  font-size: inherit;
  cursor: pointer;
  outline: none;
}

.yr-select__control:focus-visible {
  outline: none;
}

.yr-select__control option {
  background: var(--yr-surface-raised);
  color: var(--yr-text);
}

.yr-select__chevron {
  position: absolute;
  right: var(--yr-space-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--yr-text-muted);
  pointer-events: none;
}

.yr-select__chevron svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.yr-field__message {
  margin: 0;
  color: var(--yr-text-muted);
  font-size: var(--yr-text-xs);
  line-height: var(--yr-leading-normal);
}

.yr-field__message--error {
  color: var(--yr-danger);
}
</style>
