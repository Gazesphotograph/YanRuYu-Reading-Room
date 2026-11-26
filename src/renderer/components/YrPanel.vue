<script setup lang="ts">
export interface YrPanelProps {
  title?: string;
  subtitle?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  elevated?: boolean;
  bordered?: boolean;
}

withDefaults(defineProps<YrPanelProps>(), {
  title: undefined,
  subtitle: undefined,
  padding: 'md',
  elevated: false,
  bordered: true,
});
</script>

<template>
  <section
    class="yr-panel"
    :class="{
      'yr-panel--elevated': elevated,
      'yr-panel--bordered': bordered,
    }"
  >
    <header v-if="title || subtitle || $slots.header || $slots.actions" class="yr-panel__header">
      <div class="yr-panel__heading">
        <slot name="header">
          <h3 v-if="title" class="yr-panel__title">{{ title }}</h3>
          <p v-if="subtitle" class="yr-panel__subtitle">{{ subtitle }}</p>
        </slot>
      </div>
      <div v-if="$slots.actions" class="yr-panel__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="yr-panel__body" :class="`yr-panel__body--${padding}`">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="yr-panel__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.yr-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--yr-radius-panel);
  background: var(--yr-surface);
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
}

.yr-panel--bordered {
  border: 1px solid var(--yr-border);
}

.yr-panel--elevated {
  background: var(--yr-surface-raised);
  box-shadow: var(--yr-shadow-md);
}

.yr-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--yr-space-4);
  padding: var(--yr-space-4) var(--yr-space-5);
  border-bottom: 1px solid var(--yr-border);
}

.yr-panel__heading {
  min-width: 0;
}

.yr-panel__title {
  margin: 0;
  color: var(--yr-text);
  font-size: var(--yr-text-base);
  font-weight: var(--yr-weight-semibold);
  line-height: var(--yr-leading-tight);
}

.yr-panel__subtitle {
  margin: var(--yr-space-1) 0 0;
  color: var(--yr-text-muted);
  font-size: var(--yr-text-sm);
  line-height: var(--yr-leading-normal);
}

.yr-panel__actions {
  display: flex;
  align-items: center;
  gap: var(--yr-space-2);
  flex: none;
}

.yr-panel__body {
  min-width: 0;
}

.yr-panel__body--none {
  padding: 0;
}

.yr-panel__body--sm {
  padding: var(--yr-space-3);
}

.yr-panel__body--md {
  padding: var(--yr-space-5);
}

.yr-panel__body--lg {
  padding: var(--yr-space-6);
}

.yr-panel__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--yr-space-2);
  padding: var(--yr-space-3) var(--yr-space-5);
  border-top: 1px solid var(--yr-border);
  background: var(--yr-surface-subtle);
  border-radius: 0 0 calc(var(--yr-radius-panel) - 1px) calc(var(--yr-radius-panel) - 1px);
}
</style>
