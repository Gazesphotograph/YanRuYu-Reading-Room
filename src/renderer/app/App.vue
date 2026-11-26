<script setup lang="ts">
import '../design/tokens.css';
import '../design/themes/index.css';
import { computed, defineAsyncComponent } from 'vue';

const ComponentShowcase = defineAsyncComponent(() => import('../dev/ComponentShowcase.vue'));

const isShowcaseMode = computed(() => {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('showcase') === '1';
});
</script>

<template>
  <div data-yr-shell="ready" hidden></div>
  <ComponentShowcase v-if="isShowcaseMode" />
</template>
