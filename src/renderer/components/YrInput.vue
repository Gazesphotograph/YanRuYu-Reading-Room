<script setup lang="ts">
import { computed, useId } from 'vue';

export interface YrInputProps {
  modelValue: string;
  label?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  type?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  readonly?: boolean;
  clearable?: boolean;
  id?: string;
}

const props = withDefaults(defineProps<YrInputProps>(), {
  label: undefined,
  placeholder: '',
  hint: undefined,
  error: undefined,
  type: 'text',
  size: 'md',
  disabled: false,
  readonly: false,
  clearable: false,
  id: undefined,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  clear: [];
  enter: [event: KeyboardEvent];
}>();

const autoId = useId();
const inputId = computed(() => props.id ?? `yr-input-${autoId}`);
const describedBy = computed(() => {
  if (props.error) return `${inputId.value}-error`;
  if (props.hint) return `${inputId.value}-hint`;
  return undefined;
});

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement | null;
  emit('update:modelValue', target?.value ?? '');
}

function onClear(): void {
  emit('update:modelValue', '');
  emit('clear');
}
</script>

<template>
  <div class="yr-field" :class="{ 'yr-field--error': Boolean(error), 'yr-field--disabled': disabled }">
    <label v-if="label" :for="inputId" class="yr-field__label">
      {{ label }}
    </label>
    <div class="yr-input" :class="[`yr-input--${size}`, { 'yr-input--invalid': Boolean(error) }]">
      <span v-if="$slots.prefix" class="yr-input__affix">
        <slot name="prefix" />
      </span>
      <input
        :id="inputId"
        class="yr-input__control"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        @input="onInput"
        @keydown.enter="emit('enter', $event)"
      />
      <button
        v-if="clearable && modelValue && !disabled && !readonly"
        type="button"
        class="yr-input__clear"
        aria-label="清除输入"
        @click="onClear"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </svg>
      </button>
      <span v-if="$slots.suffix" class="yr-input__affix">
        <slot name="suffix" />
      </span>
    </div>
    <p v-if="error" :id="`${inputId}-error`" class="yr-field__message yr-field__message--error" role="alert">
      {{ error }}
    </p>
    <p v-else-if="hint" :id="`${inputId}-hint`" class="yr-field__message">
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

.yr-input {
  display: flex;
  align-items: center;
  gap: var(--yr-space-2);
  min-width: 0;
  padding: 0 var(--yr-space-3);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-control);
  background: var(--yr-surface);
  color: var(--yr-text);
  transition:
    border-color var(--yr-duration-fast) var(--yr-ease-standard),
    box-shadow var(--yr-duration-fast) var(--yr-ease-standard);
}

.yr-input--sm {
  min-height: 30px;
  font-size: var(--yr-text-sm);
}

.yr-input--md {
  min-height: 36px;
  font-size: var(--yr-text-md);
}

.yr-input:hover:not(.yr-input--invalid) {
  border-color: var(--yr-border-strong);
}

.yr-input:focus-within {
  border-color: var(--yr-focus-ring);
  box-shadow: 0 0 0 2px var(--yr-accent-soft);
}

.yr-input--invalid {
  border-color: var(--yr-danger);
}

.yr-input--invalid:focus-within {
  border-color: var(--yr-danger);
  box-shadow: 0 0 0 2px var(--yr-danger-soft);
}

.yr-field--disabled .yr-input {
  background: var(--yr-surface-subtle);
  opacity: 0.6;
}

.yr-input__control {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  font-size: inherit;
  line-height: var(--yr-leading-normal);
  outline: none;
}

.yr-input__control:focus-visible {
  outline: none;
}

.yr-input__control::placeholder {
  color: var(--yr-text-muted);
}

.yr-input__affix {
  display: inline-flex;
  align-items: center;
  color: var(--yr-text-muted);
  flex: none;
}

.yr-input__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--yr-radius-pill);
  background: transparent;
  color: var(--yr-text-muted);
  cursor: pointer;
  flex: none;
}

.yr-input__clear:hover {
  background: var(--yr-surface-hover);
  color: var(--yr-text);
}

.yr-input__clear:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: 1px;
}

.yr-input__clear svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
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
