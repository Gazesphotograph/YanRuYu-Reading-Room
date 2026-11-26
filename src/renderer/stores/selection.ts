import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { normalizeShelfQuery } from './library';
import type {
  Book,
  FilteredBookNotice,
  LibraryPosition,
  LibraryQuery,
  ReturnTarget,
  WorkspaceKind,
  WorkspaceLibraryView,
} from '../types/book';

export interface SelectionReconciliationInput {
  previousSelectedId: string;
  previousIndex: number;
  nextVisibleBooks: readonly Book[];
  allBooks: readonly Book[];
  workspace: WorkspaceKind;
  perPage: number;
  preferNoticeFocus?: boolean;
}

export interface SelectionReconciliationResult {
  selectedId: string;
  page: number;
  notice: FilteredBookNotice | null;
  focusTarget: 'book' | 'filtered-notice' | 'empty' | 'workspace-nav';
  focusBookId: string;
}

export interface WorkspaceTransitionOptions {
  bookId?: string;
  currentQuery?: Partial<LibraryQuery>;
  currentPage?: number;
  currentScrollTop?: number;
  visibleBooks?: readonly Book[];
  allBooks?: readonly Book[];
  perPage?: number;
}

export interface WorkspaceTransitionResult {
  workspace: WorkspaceKind;
  page: number;
  scrollTop: number;
  selectedId: string;
  notice: FilteredBookNotice | null;
  focusTarget: 'book' | 'filtered-notice' | 'empty' | 'workspace-nav';
  focusBookId: string;
}

export function resolveFilteredBookNotice(
  bookId: string,
  allBooks: readonly Book[]
): FilteredBookNotice {
  const book = allBooks.find(item => item.id === bookId);
  if (!book) {
    return {
      bookId,
      reason: 'removed',
      message: '所选书已从书库移除，原查询已保留。',
      canShowBook: false,
    };
  }
  if (book.hiddenBook) {
    return {
      bookId,
      reason: 'hidden',
      message: '所选书已隐藏，原查询已保留。',
      canShowBook: true,
    };
  }
  return {
    bookId,
    reason: 'filtered',
    message: '这本书已移出当前筛选。',
    canShowBook: true,
  };
}

/**
 * Pure reconciliation logic matching commit f433d79:
 * When editing, hiding, or deleting removes the selected book from the active
 * filter, preserve the active query, pick the nearest surviving neighbor (or
 * empty fallback), surface the filtered-out notice in library workspace, and
 * return a deterministic focus target.
 */
export function reconcileSelectionAfterChange(
  input: SelectionReconciliationInput
): SelectionReconciliationResult {
  const {
    previousSelectedId,
    previousIndex,
    nextVisibleBooks,
    allBooks,
    workspace,
    perPage,
    preferNoticeFocus = false,
  } = input;

  const safePerPage = Math.max(1, perPage || 12);

  if (!previousSelectedId) {
    return {
      selectedId: '',
      page: 1,
      notice: null,
      focusTarget: nextVisibleBooks.length > 0 ? 'book' : workspace === 'library' ? 'empty' : 'workspace-nav',
      focusBookId: '',
    };
  }

  const survivingIndex = nextVisibleBooks.findIndex(book => book.id === previousSelectedId);
  if (survivingIndex >= 0) {
    return {
      selectedId: previousSelectedId,
      page: Math.floor(survivingIndex / safePerPage) + 1,
      notice: null,
      focusTarget: 'book',
      focusBookId: previousSelectedId,
    };
  }

  const clampedIndex =
    nextVisibleBooks.length > 0
      ? Math.min(Math.max(0, previousIndex), nextVisibleBooks.length - 1)
      : -1;
  const neighbor = clampedIndex >= 0 ? nextVisibleBooks[clampedIndex] : null;
  const nextSelectedId = neighbor?.id ?? '';
  const nextPage = neighbor ? Math.floor(clampedIndex / safePerPage) + 1 : 1;
  const notice = workspace === 'library' ? resolveFilteredBookNotice(previousSelectedId, allBooks) : null;

  let focusTarget: SelectionReconciliationResult['focusTarget'];
  let focusBookId = nextSelectedId;
  if (preferNoticeFocus && notice?.canShowBook) {
    focusTarget = 'filtered-notice';
    focusBookId = previousSelectedId;
  } else if (nextSelectedId) {
    focusTarget = 'book';
    focusBookId = nextSelectedId;
  } else if (notice?.canShowBook) {
    focusTarget = 'filtered-notice';
    focusBookId = previousSelectedId;
  } else if (workspace === 'library') {
    focusTarget = 'empty';
    focusBookId = '';
  } else {
    focusTarget = 'workspace-nav';
    focusBookId = '';
  }

  return {
    selectedId: nextSelectedId,
    page: nextPage,
    notice,
    focusTarget,
    focusBookId,
  };
}

export const useSelectionStore = defineStore('selection', () => {
  const workspace = ref<WorkspaceKind>('desk');
  const libraryView = ref<WorkspaceLibraryView>('grid');
  const selectedId = ref('');
  const checkedIds = ref<Set<string>>(new Set());
  const libraryPosition = ref<LibraryPosition>({ page: 1, scrollTop: 0, selectedId: '' });
  const roomQuery = ref<LibraryQuery | null>(null);
  const returnTarget = ref<ReturnTarget | null>(null);
  const filteredOutNotice = ref<FilteredBookNotice | null>(null);

  const checkedCount = computed(() => checkedIds.value.size);
  const hasChecked = computed(() => checkedIds.value.size > 0);
  const checkedList = computed(() => [...checkedIds.value]);

  function selectBook(id: string): void {
    selectedId.value = id;
    if (workspace.value === 'library') {
      libraryPosition.value = { ...libraryPosition.value, selectedId: id };
    }
  }

  function setLibraryView(view: WorkspaceLibraryView): void {
    libraryView.value = view === 'table' ? 'table' : 'grid';
  }

  function saveLibraryPosition(patch: Partial<LibraryPosition>): void {
    libraryPosition.value = {
      page:
        patch.page !== undefined && Number.isSafeInteger(patch.page) && patch.page > 0
          ? patch.page
          : libraryPosition.value.page,
      scrollTop:
        patch.scrollTop !== undefined && Number.isFinite(patch.scrollTop) && patch.scrollTop >= 0
          ? patch.scrollTop
          : libraryPosition.value.scrollTop,
      selectedId: patch.selectedId !== undefined ? patch.selectedId : libraryPosition.value.selectedId,
    };
  }

  function setWorkspace(
    next: WorkspaceKind,
    options: WorkspaceTransitionOptions = {}
  ): WorkspaceTransitionResult {
    const previousWorkspace = workspace.value;
    const bookId = options.bookId ?? '';
    const perPage = Math.max(1, options.perPage ?? 12);

    if (previousWorkspace === 'library' && next !== 'library') {
      saveLibraryPosition({
        page: options.currentPage ?? libraryPosition.value.page,
        scrollTop: options.currentScrollTop ?? libraryPosition.value.scrollTop,
        selectedId: selectedId.value,
      });
    }

    workspace.value = next;

    if (next === 'room') {
      roomQuery.value =
        bookId && previousWorkspace === 'library' && options.currentQuery
          ? normalizeShelfQuery(options.currentQuery)
          : null;
      selectedId.value = bookId;
      filteredOutNotice.value = null;
      returnTarget.value =
        previousWorkspace === 'library'
          ? { workspace: 'library', bookId: bookId || libraryPosition.value.selectedId || undefined, focusTarget: 'book' }
          : null;

      let targetPage = 1;
      if (bookId && options.visibleBooks) {
        const index = options.visibleBooks.findIndex(book => book.id === bookId);
        if (index >= 0) targetPage = Math.floor(index / perPage) + 1;
      }

      return {
        workspace: 'room',
        page: targetPage,
        scrollTop: 0,
        selectedId: selectedId.value,
        notice: null,
        focusTarget: selectedId.value ? 'book' : 'workspace-nav',
        focusBookId: selectedId.value,
      };
    }

    if (next === 'library') {
      let targetPage = libraryPosition.value.page;
      let targetScrollTop = libraryPosition.value.scrollTop;
      let targetSelectedId = libraryPosition.value.selectedId;
      let focusTarget: WorkspaceTransitionResult['focusTarget'] = targetSelectedId ? 'book' : 'empty';
      let focusBookId = targetSelectedId;

      if (bookId) {
        const visible = options.visibleBooks ?? [];
        const index = visible.findIndex(book => book.id === bookId);
        if (index >= 0) {
          targetPage = Math.floor(index / perPage) + 1;
          targetSelectedId = bookId;
          filteredOutNotice.value = null;
          focusTarget = 'book';
          focusBookId = bookId;
        } else if (options.visibleBooks !== undefined) {
          filteredOutNotice.value = resolveFilteredBookNotice(bookId, options.allBooks ?? visible);
          focusTarget = filteredOutNotice.value.canShowBook ? 'filtered-notice' : targetSelectedId ? 'book' : 'empty';
          focusBookId = filteredOutNotice.value.canShowBook ? bookId : targetSelectedId;
        } else {
          targetSelectedId = bookId;
          focusTarget = 'book';
          focusBookId = bookId;
        }
      }

      selectedId.value = targetSelectedId;
      returnTarget.value = { workspace: 'library', bookId: focusBookId || undefined, focusTarget };

      return {
        workspace: 'library',
        page: targetPage,
        scrollTop: targetScrollTop,
        selectedId: selectedId.value,
        notice: filteredOutNotice.value,
        focusTarget,
        focusBookId,
      };
    }

    // Desk workspace
    return {
      workspace: 'desk',
      page: 1,
      scrollTop: 0,
      selectedId: selectedId.value,
      notice: null,
      focusTarget: 'workspace-nav',
      focusBookId: '',
    };
  }

  function toggleChecked(id: string): boolean {
    if (!id) return false;
    const next = new Set(checkedIds.value);
    const added = !next.has(id);
    if (added) next.add(id);
    else next.delete(id);
    checkedIds.value = next;
    return added;
  }

  function setChecked(id: string, checked: boolean): void {
    if (!id) return;
    const next = new Set(checkedIds.value);
    if (checked) next.add(id);
    else next.delete(id);
    checkedIds.value = next;
  }

  function togglePageChecked(pageBookIds: readonly string[], forceChecked?: boolean): void {
    if (pageBookIds.length === 0) return;
    const allChecked = pageBookIds.every(id => checkedIds.value.has(id));
    const shouldCheck = forceChecked !== undefined ? forceChecked : !allChecked;
    const next = new Set(checkedIds.value);
    for (const id of pageBookIds) {
      if (shouldCheck) next.add(id);
      else next.delete(id);
    }
    checkedIds.value = next;
  }

  function isPageAllChecked(pageBookIds: readonly string[]): boolean {
    return pageBookIds.length > 0 && pageBookIds.every(id => checkedIds.value.has(id));
  }

  function isPageIndeterminate(pageBookIds: readonly string[]): boolean {
    if (pageBookIds.length === 0) return false;
    let checkedOnPage = 0;
    for (const id of pageBookIds) {
      if (checkedIds.value.has(id)) checkedOnPage++;
    }
    return checkedOnPage > 0 && checkedOnPage < pageBookIds.length;
  }

  function pruneChecked(validBookIds: Iterable<string>): void {
    if (checkedIds.value.size === 0) return;
    const allowed = new Set(validBookIds);
    const next = new Set<string>();
    for (const id of checkedIds.value) {
      if (allowed.has(id)) next.add(id);
    }
    if (next.size !== checkedIds.value.size) {
      checkedIds.value = next;
    }
  }

  function clearChecked(): void {
    if (checkedIds.value.size > 0) {
      checkedIds.value = new Set();
    }
  }

  function showFilteredOutNotice(bookId: string, allBooks: readonly Book[]): FilteredBookNotice {
    const notice = resolveFilteredBookNotice(bookId, allBooks);
    filteredOutNotice.value = notice;
    return notice;
  }

  function dismissFilteredOutNotice(): void {
    filteredOutNotice.value = null;
  }

  function reconcileNotice(visibleBooks: readonly Book[], allBooks: readonly Book[]): void {
    if (!filteredOutNotice.value) return;
    if (workspace.value !== 'library') {
      filteredOutNotice.value = null;
      return;
    }
    const id = filteredOutNotice.value.bookId;
    if (visibleBooks.some(book => book.id === id)) {
      filteredOutNotice.value = null;
    } else {
      filteredOutNotice.value = resolveFilteredBookNotice(id, allBooks);
    }
  }

  function reconcileAfterMutation(params: {
    previousIndex: number;
    nextVisibleBooks: readonly Book[];
    allBooks: readonly Book[];
    perPage: number;
    preferNoticeFocus?: boolean;
  }): SelectionReconciliationResult {
    const result = reconcileSelectionAfterChange({
      previousSelectedId: selectedId.value,
      previousIndex: params.previousIndex,
      nextVisibleBooks: params.nextVisibleBooks,
      allBooks: params.allBooks,
      workspace: workspace.value,
      perPage: params.perPage,
      preferNoticeFocus: params.preferNoticeFocus,
    });

    selectedId.value = result.selectedId;
    filteredOutNotice.value = result.notice;
    if (workspace.value === 'library') {
      saveLibraryPosition({ page: result.page, selectedId: result.selectedId });
    }
    returnTarget.value = {
      workspace: workspace.value,
      bookId: result.focusBookId || undefined,
      focusTarget: result.focusTarget,
    };

    pruneChecked(params.nextVisibleBooks.map(book => book.id));
    return result;
  }

  function setReturnTarget(target: ReturnTarget | null): void {
    returnTarget.value = target;
  }

  function consumeReturnTarget(): ReturnTarget | null {
    const current = returnTarget.value;
    returnTarget.value = null;
    return current;
  }

  return {
    workspace,
    libraryView,
    selectedId,
    checkedIds,
    libraryPosition,
    roomQuery,
    returnTarget,
    filteredOutNotice,
    checkedCount,
    hasChecked,
    checkedList,
    selectBook,
    setLibraryView,
    saveLibraryPosition,
    setWorkspace,
    toggleChecked,
    setChecked,
    togglePageChecked,
    isPageAllChecked,
    isPageIndeterminate,
    pruneChecked,
    clearChecked,
    showFilteredOutNotice,
    dismissFilteredOutNotice,
    reconcileNotice,
    reconcileAfterMutation,
    setReturnTarget,
    consumeReturnTarget,
  };
});
