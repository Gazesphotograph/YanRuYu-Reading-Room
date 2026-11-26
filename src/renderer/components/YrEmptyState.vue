<script setup lang="ts">
export interface YrEmptyStateProps {
  title: string;
  description?: string;
  compact?: boolean;
}

withDefaults(defineProps<YrEmptyStateProps>(), {
  description: undefined,
  compact: false,
});
</script>

<template>
  <div class="yr-empty" :class="{ 'yr-empty--compact': compact }">
    <div class="yr-empty__icon" aria-hidden="true">
      <slot name="icon">
        <svg viewBox="0 0 24 24" width="28" height="28">
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19v15.5a.5.5 0 0 1-.5.5H6.5A2.5 2.5 0 0 1 4 17.5v-11z" />
          <path d="M4 17a2 2 0 0 1 2-2h13" />
        </svg>
      </slot>
    </div>
    <h3 class="yr-empty__title">{{ title }}</h3>
    <p v-if="description" class="yr-empty__desc">{{ description }}</p>
    <div v-if="$slots.actions" class="yr-empty__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.yr-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--yr-space-10) var(--yr-space-6);
  border: 1px dashed var(--yr-border);
  border-radius: var(--yr-radius-panel);
  background: var(--yr-surface-subtle);
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
  text-align: center;
}

.yr-empty--compact {
  padding: var(--yr-space-6) var(--yr-space-4);
}

.yr-empty__icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  margin-bottom: var(--yr-space-3);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-pill);
  background: var(--yr-surface);
  color: var(--yr-text-muted);
}

.yr-empty__icon svg {
  width: 28px;
  height: 28px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.yr-empty__title {
  margin: 0;
  color: var(--yr-text);
  font-size: var(--yr-text-base);
  font-weight: var(--yr-weight-semibold);
  line-height: var(--yr-leading-tight);
}

.yr-empty__desc {
  max-width: 360px;
  margin: var(--yr-space-2) 0 0;
  color: var(--yr-text-muted);
  font-size: var(--yr-text-sm);
  line-height: var(--yr-leading-normal);
}

.yr-empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--yr-space-2);
  margin-top: var(--yr-space-4);
}
</style>
