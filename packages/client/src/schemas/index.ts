/**
 * Response resource schemas (camelCase) and the component registry the OpenAPI
 * generator publishes under `#/components/schemas/<Name>` (converted to snake_case).
 */
import * as auth from './auth.ts';
import * as automation from './automation.ts';
import * as billing from './billing.ts';
import * as chats from './chats.ts';
import * as common from './common.ts';
import * as files from './files.ts';
import * as jobs from './jobs.ts';
import * as ops from './operations.ts';
import * as sites from './sites.ts';
import * as team from './team.ts';
import * as visitors from './visitors.ts';
import * as widget from './widget.ts';

export * from './auth.ts';
export * from './automation.ts';
export * from './billing.ts';
export * from './chats.ts';
export * from './common.ts';
export * from './files.ts';
export * from './jobs.ts';
export * from './operations.ts';
export * from './sites.ts';
export * from './team.ts';
export * from './visitors.ts';
export * from './widget.ts';

/** Component name → schema. Names are part of the published contract; keep them stable. */
export const ResourceSchemas = {
  // common
  Ok: common.OkSchema,
  OkTrue: common.OkTrueSchema,
  Accepted: common.AcceptedSchema,
  DownloadGrant: common.DownloadGrantSchema,
  // auth & tenant
  Me: auth.MeSchema,
  SignupResult: auth.SignupResultSchema,
  AuthProviders: auth.AuthProvidersSchema,
  AuthSession: auth.AuthSessionSchema,
  RevokedCount: auth.RevokedCountSchema,
  MfaEnrollment: auth.MfaEnrollmentSchema,
  RecoveryCodes: auth.RecoveryCodesSchema,
  OrgSettings: auth.OrgSettingsSchema,
  Tenant: auth.TenantSchema,
  TenantDeletionRequest: jobs.TenantDeletionRequestSchema,
  // team
  Agent: team.AgentSchema,
  AgentMe: team.AgentMeSchema,
  PresenceState: team.PresenceStateSchema,
  AgentInvitation: team.AgentInvitationSchema,
  AgentInvitationCreated: team.AgentInvitationCreatedSchema,
  InvitationLookup: team.InvitationLookupSchema,
  Department: team.DepartmentSchema,
  Tag: team.TagSchema,
  // sites
  WidgetConfig: sites.WidgetConfigSchema,
  Site: sites.SiteSchema,
  SiteKeyRotation: sites.SiteKeyRotationSchema,
  WidgetConfigRevisions: sites.WidgetConfigRevisionsSchema,
  WidgetConfigDraft: sites.WidgetConfigDraftSchema,
  WidgetConfigPublishResult: sites.WidgetConfigPublishResultSchema,
  WidgetConfigDiscardResult: sites.WidgetConfigDiscardResultSchema,
  InstallationStatus: sites.InstallationStatusSchema,
  IdentitySecret: sites.IdentitySecretSchema,
  // chats
  TagRef: chats.TagRefSchema,
  VisitorSummary: chats.VisitorSummarySchema,
  StaffChat: chats.StaffChatSchema,
  HistoryChat: chats.HistoryChatSchema,
  PublicAgentProfile: chats.PublicAgentProfileSchema,
  PublicChat: chats.PublicChatSchema,
  AttachmentRef: chats.AttachmentRefSchema,
  Message: chats.MessageSchema,
  MessagePage: chats.MessagePageSchema,
  Offer: chats.OfferSchema,
  PendingOffer: chats.PendingOfferSchema,
  TransferResult: chats.TransferResultSchema,
  ChatCounts: chats.ChatCountsSchema,
  ReadCursor: chats.ReadCursorSchema,
  ChatAdmission: chats.ChatAdmissionSchema,
  AgentStartedChat: chats.AgentStartedChatSchema,
  ChatRating: chats.ChatRatingSchema,
  // visitors
  VisitorTagRef: visitors.VisitorTagRefSchema,
  StaffVisitor: visitors.StaffVisitorSchema,
  VisitorListItem: visitors.VisitorListItemSchema,
  VisitorSession: visitors.VisitorSessionSchema,
  VisitorTags: visitors.VisitorTagsSchema,
  LiveSessionItem: visitors.LiveSessionItemSchema,
  LiveVisitorItem: visitors.LiveVisitorItemSchema,
  LiveVisitors: visitors.LiveVisitorsSchema,
  VisitorMergeJob: visitors.VisitorMergeJobSchema,
  Ban: visitors.BanSchema,
  CustomField: visitors.CustomFieldSchema,
  // widget (public)
  PublicAvailability: widget.PublicAvailabilitySchema,
  WidgetBootstrap: widget.WidgetBootstrapSchema,
  WidgetSession: widget.WidgetSessionSchema,
  WidgetRedeemedSession: widget.WidgetRedeemedSessionSchema,
  WidgetResetSession: widget.WidgetResetSessionSchema,
  IdentityHandoff: widget.IdentityHandoffSchema,
  WidgetIdentity: widget.WidgetIdentitySchema,
  PublicVisitor: widget.PublicVisitorSchema,
  ConsentState: widget.ConsentStateSchema,
  EventsIngestResult: widget.EventsIngestResultSchema,
  SocketTicket: widget.SocketTicketSchema,
  AgentSocketTicket: widget.AgentSocketTicketSchema,
  Invitation: widget.InvitationSchema,
  // files & exports
  Attachment: files.AttachmentSchema,
  UploadInit: files.UploadInitSchema,
  AttachmentDownloadGrant: files.AttachmentDownloadGrantSchema,
  Export: files.ExportSchema,
  ExportPreview: files.ExportPreviewSchema,
  TranscriptEmailJob: files.TranscriptEmailJobSchema,
  PublicTranscriptEmailJob: files.PublicTranscriptEmailJobSchema,
  // automation
  Shortcut: automation.ShortcutSchema,
  ShortcutImportPreview: automation.ShortcutImportPreviewSchema,
  ShortcutImportResult: automation.ShortcutImportResultSchema,
  ShortcutRender: automation.ShortcutRenderSchema,
  TriggerSummary: automation.TriggerSummarySchema,
  TriggerListItem: automation.TriggerListItemSchema,
  TriggerRevision: automation.TriggerRevisionSchema,
  TriggerDetail: automation.TriggerDetailSchema,
  TriggerDraftResult: automation.TriggerDraftResultSchema,
  TriggerSimulation: automation.TriggerSimulationSchema,
  TriggerRun: automation.TriggerRunSchema,
  TriggerFunnel: automation.TriggerFunnelSchema,
  Schedule: automation.ScheduleSchema,
  ScheduleException: automation.ScheduleExceptionSchema,
  ScheduleDetail: automation.ScheduleDetailSchema,
  ScheduleUpdateResult: automation.ScheduleUpdateResultSchema,
  ScheduleExceptionResult: automation.ScheduleExceptionResultSchema,
  SchedulePreview: automation.SchedulePreviewSchema,
  EmergencyClosure: automation.EmergencyClosureSchema,
  // operations
  OfflineReceipt: ops.OfflineReceiptSchema,
  OfflineSubmission: ops.OfflineSubmissionSchema,
  OfflineSubmissionDetail: ops.OfflineSubmissionDetailSchema,
  Notification: ops.NotificationSchema,
  NotificationList: ops.NotificationListSchema,
  NotificationsReadAll: ops.NotificationsReadAllSchema,
  NotificationRead: ops.NotificationReadSchema,
  MeasureValue: ops.MeasureValueSchema,
  ReportedMeasure: ops.ReportedMeasureSchema,
  ChatsReport: ops.ChatsReportSchema,
  AgentsReport: ops.AgentsReportSchema,
  InvitationsReport: ops.InvitationsReportSchema,
  AnalyticsExport: ops.AnalyticsExportSchema,
  DepartmentLoad: ops.DepartmentLoadSchema,
  MonitorSnapshot: ops.MonitorSnapshotSchema,
  IntegrationToken: ops.IntegrationTokenSchema,
  IntegrationTokenScope: ops.IntegrationTokenScopeSchema,
  IntegrationTokenSecret: ops.IntegrationTokenSecretSchema,
  WebhookEndpoint: ops.WebhookEndpointSchema,
  WebhookEndpointSecret: ops.WebhookEndpointSecretSchema,
  WebhookEventTypes: ops.WebhookEventTypesSchema,
  WebhookDelivery: ops.WebhookDeliverySchema,
  Connector: ops.ConnectorSchema,
  AuditEvent: ops.AuditEventSchema,
  PrivacyRequest: ops.PrivacyRequestSchema,
  RetentionReport: ops.RetentionReportSchema,
  HealthLive: ops.HealthLiveSchema,
  // jobs
  JobStatus: jobs.JobStatusSchema,
  // billing
  BillingStatus: billing.BillingStatusSchema,
  BillingSummary: billing.BillingSummarySchema,
  BillingQuote: billing.BillingQuoteSchema,
  BillingCardSession: billing.BillingCardSessionSchema,
  BillingCharge: billing.BillingChargeSchema,
} as const;

export type ResourceName = keyof typeof ResourceSchemas;
