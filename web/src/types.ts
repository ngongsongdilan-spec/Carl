export interface NotificationPayload {
  itemId: string;
  title: string;
  body: string;
  priority: string;
  category: string;
  deadlineIso: string | null;
  gmailUrl: string;
}

export type {
  ApiErrorShape,
  AnalyzeResponse,
  AppConfigView,
  AskResponse,
  AttentionItemView,
  AttentionListResponse,
  AuthStatus,
  DeadlineView,
  ItemStatus,
  Priority,
  SourceResponse,
} from './api';
