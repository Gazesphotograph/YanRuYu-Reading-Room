export type ThemeId = 'paper' | 'dark' | 'glass' | 'ex';

export type WorkspaceStartPage = 'desk' | 'library' | 'room';

export type QualityPresetId = 'power' | 'balanced' | 'fine';

export interface QualityPreset {
  readonly id: QualityPresetId;
  readonly label: string;
  readonly pixelRatio: number;
  readonly shadows: boolean;
  readonly shadowSize: number;
  readonly shadowSamples: number;
  readonly anisotropy: number;
  readonly coverDimension: number;
  readonly coverBudgetBytes: number;
  readonly coverCount: number;
  readonly coverConcurrency: number;
  readonly dust: boolean;
}

export interface AppSetting {
  proxy?: string;
  library?: string;
  metadataPath?: string;
  imageExplorer?: string;
  pageSize?: number;
  loadOnStart?: boolean;
  igneous?: string;
  ipb_pass_hash?: string;
  ipb_member_id?: string;
  star?: string;
  showComment?: boolean;
  requireGap?: number;
  thumbnailColumn?: number;
  showTranslation?: boolean;
  theme?: string;
  widthLimit?: number;
  directEnter?: string;
  language?: string;
  folderTreeWidth?: string;
  advancedSearch?: boolean;
  autoCheckUpdates?: boolean;
  customOptions?: string;
  defaultExpandTree?: boolean;
  hidePageNumber?: boolean;
  skipDeleteConfirm?: boolean;
  displayTitle?: string;
  keepReadingProgress?: boolean;
  reverseLeftRight?: boolean;
  imageCacheBudgetMB?: number;
  excludeFile?: string;
  [key: string]: unknown;
}

export interface UiStateSnapshot {
  schemaVersion: 1;
  values: Record<string, string>;
  savedAt: number;
  restoreToken?: string;
}
