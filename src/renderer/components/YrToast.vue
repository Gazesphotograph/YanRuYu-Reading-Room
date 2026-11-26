<script setup lang="ts">
export interface YrToastProps {
  variant?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  message: string;
  dismissible?: boolean;
}

withDefaults(defineProps<YrToastProps>(), {
  variant: 'info',
  title: undefined,
  dismissible: true,
});

const emit = defineEmits<{
  dismiss: [];
}>();
</script>

<template>
  <div
    class="yr-toast"
    :class="`yr-toast--${variant}`"
    :role="variant === 'danger' || variant === 'warning' ? 'alert' : 'status'"
    :aria-live="variant === 'danger' ? 'assertive' : 'polite'"
  >
    <span class="yr-toast__stripe" aria-hidden="true"></span>
    <div class="yr-toast__content">
      <strong v-if="title" class="yr-toast__title">{{ title }}</strong>
      <p class="yr-toast__message">{{ message }}</p>
    </div>
    <div v-if="$slots.action" class="yr-toast__action">
      <slot name="action" />
    </div>
    <button
      v-if="dismissible"
      type="button"
      class="yr-toast__dismiss"
      aria-label="关闭通知"
      @click="emit('dismiss')"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.yr-toast {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--yr-space-3);
  padding: var(--yr-space-3) var(--yr-space-4);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-panel);
  background: var(--yr-surface-raised);
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  box-shadow: var(--yr-shadow-md);
  overflow: hidden;
}

.yr-toast__stripe {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: var(--yr-accent);
}

.yr-toast--info {
  border-color: var(--yr-border);
}

.yr-toast--success {
  border-color: var(--yr-success);
}

.yr-toast--success .yr-toast__stripe {
  background: var(--yr-success);
}

.yr-toast--warning {
  border-color: var(--yr-warning);
}

.yr-toast--warning .yr-toast__stripe {
  background: var(--yr-warning);
}

.yr-toast--danger {
  border-color: var(--yr-danger);
  background: var(--yr-danger-soft);
}

.yr-toast--danger .yr-toast__stripe {
  background: var(--yr-danger);
}

.yr-toast__content {
  flex: 1 1 auto;
  min-width: 0;
  padding-left: var(--yr-space-1);
}

.yr-toast__title {
  display: block;
  color: var(--yr-text);
  font-size: var(--yr-text-md);
  font-weight: var(--yr-weight-semibold);
  line-height: var(--yr-leading-tight);
}

.yr-toast__message {
  margin: var(--yr-space-1) 0 0;
  color: var(--yr-text);
  font-size: var(--yr-text-sm);
  line-height: var(--yr-leading-normal);
}

.yr-toast__content:not(:has(.yr-toast__title)) .yr-toast__message {
  margin-top: 0;
}

.yr-toast__action {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.yr-toast__dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: var(--yr-radius-control);
  background: transparent;
  color: var(--yr-text-muted);
  cursor: pointer;
}

.yr-toast__dismiss:hover {
  background: var(--yr-surface-hover);
  color: var(--yr-text);
}

.yr-toast__dismiss:focus-visible {
  outline: 2px solid var(--yr-focus-ring);
  outline-offset: 1px;
}

.yr-toast__dismiss svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
}
</style>
