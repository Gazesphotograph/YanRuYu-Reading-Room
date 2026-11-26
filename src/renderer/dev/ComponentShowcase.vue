<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  YrButton,
  YrChip,
  YrDataTable,
  YrDialog,
  YrEmptyState,
  YrIconButton,
  YrInput,
  YrMenu,
  YrPanel,
  YrSelect,
  YrTabs,
  YrToast,
} from '../components';
import type { YrMenuItem, YrSelectOption, YrTabItem, YrTableColumn, YrTableRow } from '../components';
import {
  THEMES,
  applyThemeToDocument,
  getThemeDefinition,
  normalizeTheme,
  resolveTheme,
} from '../design/theme-registry';
import type { ThemeId } from '../design/theme-registry';

const activeThemeId = ref<ThemeId>('paper');
const activeTheme = computed(() => getThemeDefinition(activeThemeId.value));
let lockedTheme: ThemeId | null = null;
let themeObserver: MutationObserver | null = null;

function selectTheme(id: ThemeId): void {
  lockedTheme = id;
  activeThemeId.value = id;
  applyThemeToDocument(id);
}

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  const requested = normalizeTheme(params.get('theme'));
  const initial = requested ?? resolveTheme();
  if (requested) lockedTheme = requested;
  activeThemeId.value = initial;
  applyThemeToDocument(initial);

  themeObserver = new MutationObserver(() => {
    const current = normalizeTheme(document.documentElement.dataset.roomTheme);
    if (lockedTheme && current !== lockedTheme) {
      applyThemeToDocument(lockedTheme);
    } else if (!lockedTheme && current && current !== activeThemeId.value) {
      activeThemeId.value = current;
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-room-theme'],
  });
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  themeObserver = null;
});

// Interactive state for the 12 component demos
const searchQuery = ref('胡桃木书架');
const errorSample = ref('invalid/path');
const sortOption = ref('recent');
const sortOptions: readonly YrSelectOption[] = [
  { value: 'recent', label: '最近阅读' },
  { value: 'title', label: '按书名排序' },
  { value: 'pages', label: '按页数降序' },
  { value: 'rating', label: '按评分降序' },
];

const activeTab = ref('all');
const tabItems: readonly YrTabItem[] = [
  { id: 'all', label: '全部藏书', count: 128 },
  { id: 'reading', label: '在读', count: 14 },
  { id: 'collections', label: '合集', count: 6 },
];

const pinned = ref(true);
const activeChips = ref<string[]>(['单行本', '已汉化']);
const removableChips = ref<string[]>(['高质量扫描', '精选收藏']);
const filterChipOptions = ['单行本', '已汉化', '全彩', '未读'];

function toggleChip(tag: string): void {
  if (activeChips.value.includes(tag)) {
    activeChips.value = activeChips.value.filter(item => item !== tag);
  } else {
    activeChips.value = [...activeChips.value, tag];
  }
}

function removeChip(tag: string): void {
  removableChips.value = removableChips.value.filter(item => item !== tag);
}

const menuItems: readonly YrMenuItem[] = [
  { id: 'edit', label: '编辑元数据', shortcut: 'E' },
  { id: 'tag', label: '批量管理标签', shortcut: 'T' },
  { id: 'export', label: '导出书单 JSON' },
  { id: 'delete', label: '移入回收站', shortcut: 'Del', danger: true, dividerBefore: true },
];
const lastMenuAction = ref('尚未选择');

const tableColumns: readonly YrTableColumn[] = [
  { key: 'title', label: '标题', sortable: true },
  { key: 'author', label: '作者', sortable: true },
  { key: 'pages', label: '页数', align: 'right', sortable: true, width: '90px' },
  { key: 'status', label: '状态', width: '110px' },
  { key: 'rating', label: '评分', align: 'right', sortable: true, width: '80px' },
];

const rawRows: readonly YrTableRow[] = [
  { id: 'b1', title: '静夜书斋记录 · 第一卷', author: '青岚社', pages: 184, status: '在读', rating: '4.9' },
  { id: 'b2', title: '午后窗光与插画集', author: '白木工作室', pages: 96, status: '已读', rating: '4.7' },
  { id: 'b3', title: 'EX 私人档案索引手账', author: 'Archive Lab', pages: 242, status: '未读', rating: '4.5' },
];

const sortKey = ref('pages');
const sortDir = ref<'asc' | 'desc'>('desc');
const selectedRowKeys = ref<string[]>(['b1']);

const sortedRows = computed<YrTableRow[]>(() => {
  const rows = [...rawRows];
  const key = sortKey.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va ?? '').localeCompare(String(vb ?? ''), 'zh-CN') * dir;
  });
  return rows;
});

function statusVariant(status: unknown): 'accent' | 'success' | 'default' {
  if (status === '在读') return 'accent';
  if (status === '已读') return 'success';
  return 'default';
}

const dialogOpen = ref(false);
const dialogNote = ref('中性深灰主题下对话框与表单保持纯色不透明与 WCAG AA 对比度。');

const visibleToasts = ref({
  info: true,
  success: true,
  warning: true,
  danger: true,
});

function resetToasts(): void {
  visibleToasts.value = { info: true, success: true, warning: true, danger: true };
}

const tokenSwatches = [
  { name: '--yr-bg', label: 'Canvas BG', varRef: 'var(--yr-bg)' },
  { name: '--yr-surface', label: 'Surface', varRef: 'var(--yr-surface)' },
  { name: '--yr-surface-subtle', label: 'Subtle', varRef: 'var(--yr-surface-subtle)' },
  { name: '--yr-surface-raised', label: 'Raised', varRef: 'var(--yr-surface-raised)' },
  { name: '--yr-accent', label: 'Accent', varRef: 'var(--yr-accent)' },
  { name: '--yr-accent-soft', label: 'Accent Soft', varRef: 'var(--yr-accent-soft)' },
  { name: '--yr-danger', label: 'Danger', varRef: 'var(--yr-danger)' },
  { name: '--yr-border', label: 'Border', varRef: 'var(--yr-border)' },
] as const;
</script>

<template>
  <div class="yr-showcase" data-testid="design-system-showcase">
    <header class="yr-showcase__header">
      <div class="yr-showcase__brand">
        <span class="yr-showcase__eyebrow">YANRUYU 2.0 · DESIGN SYSTEM</span>
        <div class="yr-showcase__title-row">
          <h1 class="yr-showcase__title">组件与 4 主题规范总览</h1>
          <YrChip variant="accent" size="sm">{{ activeTheme.name }} · {{ activeTheme.label }}</YrChip>
        </div>
      </div>

      <div class="yr-showcase__themes" role="group" aria-label="切换展示主题">
        <YrButton
          v-for="theme in THEMES"
          :key="theme.id"
          :data-testid="`showcase-theme-${theme.id}`"
          :variant="activeThemeId === theme.id ? 'primary' : 'secondary'"
          size="sm"
          :aria-pressed="activeThemeId === theme.id"
          @click="selectTheme(theme.id)"
        >
          <template #leading>
            <span class="yr-showcase__swatch-dot" :style="{ background: theme.colors[0], borderColor: theme.colors[1] }"></span>
          </template>
          {{ theme.name }}
        </YrButton>
      </div>
    </header>

    <main class="yr-showcase__main">
      <!-- Row 1: Semantic tokens + Buttons/IconButtons/Menu -->
      <div class="yr-showcase__grid">
        <YrPanel title="语义色板 · Semantic Tokens" :subtitle="activeTheme.desc">
          <div class="yr-showcase__swatches">
            <div v-for="swatch in tokenSwatches" :key="swatch.name" class="yr-showcase__swatch-card">
              <span class="yr-showcase__swatch-chip" :style="{ background: swatch.varRef }"></span>
              <div class="yr-showcase__swatch-meta">
                <strong>{{ swatch.label }}</strong>
                <code>{{ swatch.name }}</code>
              </div>
            </div>
          </div>
        </YrPanel>

        <YrPanel title="按钮、图标按钮与菜单" subtitle="YrButton · YrIconButton · YrMenu">
          <div class="yr-showcase__stack">
            <div class="yr-showcase__row">
              <YrButton variant="primary">主要操作</YrButton>
              <YrButton variant="secondary">次要按钮</YrButton>
              <YrButton variant="ghost">幽灵按钮</YrButton>
              <YrButton variant="danger">危险操作</YrButton>
              <YrButton variant="primary" size="sm" loading>处理中</YrButton>
              <YrButton variant="secondary" size="sm" disabled>已禁用</YrButton>
            </div>

            <div class="yr-showcase__row yr-showcase__row--between">
              <div class="yr-showcase__row">
                <YrIconButton label="置顶状态" :pressed="pinned" @click="pinned = !pinned">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8-2.8-2.7 3.8-.5z" />
                  </svg>
                </YrIconButton>
                <YrIconButton label="刷新列表" variant="subtle">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M13 8a5 5 0 1 1-1.4-3.5M13 2.5v2.5h-2.5" />
                  </svg>
                </YrIconButton>
                <YrIconButton label="视图设置" variant="ghost">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 4.5h10M3 8h10M3 11.5h10" />
                  </svg>
                </YrIconButton>
                <YrIconButton label="删除选中" variant="danger">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.5 8.5h5l.5-8.5" />
                  </svg>
                </YrIconButton>
              </div>

              <div class="yr-showcase__row">
                <YrMenu :items="menuItems" label="操作菜单" align="end" @select="lastMenuAction = $event" />
                <span class="yr-showcase__muted">已选：{{ lastMenuAction }}</span>
              </div>
            </div>
          </div>
        </YrPanel>

        <!-- Row 2: Forms + Chips & Tabs -->
        <YrPanel title="表单控件（实心不透明表面）" subtitle="YrInput · YrSelect">
          <div class="yr-showcase__form-grid">
            <YrInput
              v-model="searchQuery"
              label="书库检索"
              placeholder="输入标题、作者或标签…"
              hint="支持中英文与精确标签匹配"
              clearable
            />
            <YrSelect
              v-model="sortOption"
              label="排序方式"
              :options="sortOptions"
              hint="切换后即时更新书架排列"
            />
            <YrInput
              v-model="errorSample"
              label="错误状态校验"
              error="路径不可访问，请重新选择有效的本地书库目录。"
            />
          </div>
        </YrPanel>

        <YrPanel title="标签页与状态胶囊" subtitle="YrTabs · YrChip">
          <div class="yr-showcase__stack">
            <YrTabs v-model="activeTab" :items="tabItems" aria-label="藏书分类切换" />

            <div class="yr-showcase__row">
              <YrChip
                v-for="tag in filterChipOptions"
                :key="tag"
                interactive
                :selected="activeChips.includes(tag)"
                @click="toggleChip(tag)"
              >
                {{ tag }}
              </YrChip>
            </div>

            <div class="yr-showcase__row">
              <YrChip variant="accent">Accent</YrChip>
              <YrChip variant="success">已完成</YrChip>
              <YrChip variant="warning">待补全</YrChip>
              <YrChip variant="danger">校验异常</YrChip>
              <YrChip
                v-for="tag in removableChips"
                :key="tag"
                removable
                @remove="removeChip(tag)"
              >
                {{ tag }}
              </YrChip>
            </div>
          </div>
        </YrPanel>
      </div>

      <!-- Row 3: Data Table -->
      <YrPanel title="数据表格 · YrDataTable" subtitle="实心表头与行表面，支持排序、多选与插槽自定义渲染" padding="none">
        <template #actions>
          <span class="yr-showcase__muted">已勾选 {{ selectedRowKeys.length }} 项</span>
          <YrButton variant="primary" size="sm" @click="dialogOpen = true">打开对话框示例</YrButton>
        </template>
        <div class="yr-showcase__table-pad">
          <YrDataTable
            :columns="tableColumns"
            :rows="sortedRows"
            v-model:sort-key="sortKey"
            v-model:sort-dir="sortDir"
            v-model:selected-keys="selectedRowKeys"
            selectable
            compact
          >
            <template #cell-status="{ value }">
              <YrChip :variant="statusVariant(value)" size="sm">{{ value }}</YrChip>
            </template>
          </YrDataTable>
        </div>
      </YrPanel>

      <!-- Row 4: Toasts + Empty State -->
      <div class="yr-showcase__grid">
        <YrPanel title="通知与错误横幅 · YrToast" subtitle="实心背景 + 高对比状态色带">
          <template #actions>
            <YrButton variant="ghost" size="sm" @click="resetToasts">重置全部</YrButton>
          </template>
          <div class="yr-showcase__stack">
            <YrToast
              v-if="visibleToasts.info"
              variant="info"
              title="元数据同步已就绪"
              message="本地书库索引与标签翻译字典均已加载完成。"
              @dismiss="visibleToasts.info = false"
            />
            <YrToast
              v-if="visibleToasts.success"
              variant="success"
              message="已成功切换主题配置并保留当前书架筛选状态。"
              @dismiss="visibleToasts.success = false"
            />
            <YrToast
              v-if="visibleToasts.warning"
              variant="warning"
              message="检测到 2 本图书缺少封面缓存，将在后台补建。"
              @dismiss="visibleToasts.warning = false"
            />
            <YrToast
              v-if="visibleToasts.danger"
              variant="danger"
              title="导入失败"
              message="目标压缩包已损坏或权限不足，请检查文件后重试。"
              @dismiss="visibleToasts.danger = false"
            />
          </div>
        </YrPanel>

        <YrPanel title="空状态与模态对话框" subtitle="YrEmptyState · YrDialog">
          <YrEmptyState
            title="当前筛选条件下没有匹配藏书"
            description="可以清空关键词或放宽标签过滤条件，也可以从本地文件夹导入新漫画。"
            compact
          >
            <template #actions>
              <YrButton variant="primary" size="sm" @click="dialogOpen = true">预览 YrDialog</YrButton>
              <YrButton variant="secondary" size="sm" @click="searchQuery = ''">清空检索词</YrButton>
            </template>
          </YrEmptyState>
        </YrPanel>
      </div>
    </main>

    <YrDialog
      v-model:open="dialogOpen"
      title="书库属性设置 · YrDialog"
      description="无论在暖白、静夜、纯白液态玻璃还是 EX 主题下，对话框表单始终使用实心不透明表面。"
      size="md"
    >
      <div class="yr-showcase__stack">
        <YrInput v-model="dialogNote" label="材质纪律说明" clearable />
        <YrSelect v-model="sortOption" label="默认排序" :options="sortOptions" />
      </div>
      <template #footer>
        <YrButton variant="secondary" @click="dialogOpen = false">取消</YrButton>
        <YrButton variant="primary" @click="dialogOpen = false">保存更改</YrButton>
      </template>
    </YrDialog>
  </div>
</template>

<style scoped>
.yr-showcase {
  position: fixed;
  inset: 0;
  z-index: var(--yr-z-showcase);
  display: flex;
  flex-direction: column;
  overflow: auto;
  background: var(--yr-bg);
  color: var(--yr-text);
  font-family: var(--yr-font-sans);
}

.yr-showcase__header {
  position: sticky;
  top: 0;
  z-index: var(--yr-z-header);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--yr-space-4);
  padding: var(--yr-space-4) var(--yr-space-6);
  border-bottom: 1px solid var(--yr-border);
  background: var(--yr-bg-sidebar);
}

.yr-showcase__brand {
  display: flex;
  flex-direction: column;
  gap: var(--yr-space-1);
}

.yr-showcase__eyebrow {
  color: var(--yr-text-muted);
  font-family: var(--yr-font-mono);
  font-size: var(--yr-text-xs);
  letter-spacing: 0.08em;
}

.yr-showcase__title-row {
  display: flex;
  align-items: center;
  gap: var(--yr-space-3);
}

.yr-showcase__title {
  margin: 0;
  color: var(--yr-text);
  font-size: var(--yr-text-xl);
  font-weight: var(--yr-weight-semibold);
  line-height: var(--yr-leading-tight);
}

.yr-showcase__themes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yr-space-2);
}

.yr-showcase__swatch-dot {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 2px solid var(--yr-border);
  border-radius: var(--yr-radius-pill);
}

.yr-showcase__main {
  display: flex;
  flex-direction: column;
  gap: var(--yr-space-4);
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
  padding: var(--yr-space-5) var(--yr-space-6) var(--yr-space-8);
}

.yr-showcase__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--yr-space-4);
}

.yr-showcase__stack {
  display: flex;
  flex-direction: column;
  gap: var(--yr-space-3);
}

.yr-showcase__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yr-space-2);
}

.yr-showcase__row--between {
  justify-content: space-between;
}

.yr-showcase__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--yr-space-3);
}

.yr-showcase__form-grid > :last-child {
  grid-column: 1 / -1;
}

.yr-showcase__swatches {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--yr-space-2);
}

.yr-showcase__swatch-card {
  display: flex;
  flex-direction: column;
  gap: var(--yr-space-2);
  padding: var(--yr-space-2);
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-control);
  background: var(--yr-surface-subtle);
}

.yr-showcase__swatch-chip {
  display: block;
  width: 100%;
  height: 28px;
  border: 1px solid var(--yr-border);
  border-radius: var(--yr-radius-xs);
}

.yr-showcase__swatch-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.yr-showcase__swatch-meta strong {
  color: var(--yr-text);
  font-size: var(--yr-text-xs);
  font-weight: var(--yr-weight-semibold);
}

.yr-showcase__swatch-meta code {
  color: var(--yr-text-muted);
  font-family: var(--yr-font-mono);
  font-size: 10px;
}

.yr-showcase__table-pad {
  padding: var(--yr-space-4);
}

.yr-showcase__muted {
  color: var(--yr-text-muted);
  font-size: var(--yr-text-sm);
}

@media (max-width: 900px) {
  .yr-showcase__grid,
  .yr-showcase__form-grid {
    grid-template-columns: 1fr;
  }

  .yr-showcase__swatches {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
